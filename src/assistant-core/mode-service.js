import { ASSISTANT_CONTROL_MODE, ASSISTANT_RUN_STATUS } from './models.js';
import assistantSessionStore, { AssistantSessionStore } from './session-store.js';
import assistantRunStore, { AssistantRunStore } from './run-store.js';
import assistantObservationService, { AssistantObservationService } from './observation-service.js';
import assistantClarificationStore from './clarification-store.js';
import AssistantRunner from './runner.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import assistantTaskViewService from './task-view-service.js';
import AssistantDialogueService from '../assistant-agent/dialogue-service.js';
import { CHANNEL_CONVERSATION_MODE } from '../agent-channels/models.js';
import { buildSupervisorBrief } from '../agent-orchestrator/supervisor-brief.js';
import { syncTaskFromRuntimeResult } from '../agent-core/task-service.js';
import agentTaskStore from '../agent-core/task-store.js';
import { finalizeSupervisorTaskMemory, normalizeSupervisorTaskMemory, upsertSupervisorTaskRecord } from '../agent-orchestrator/supervisor-task-memory.js';
import { AGENT_SESSION_STATUS } from '../agent-runtime/models.js';
import supervisorTaskStore from '../agent-orchestrator/supervisor-task-store.js';
import {
  syncSupervisorTaskForRuntimeStart,
  syncSupervisorTaskForRuntimeTerminal
} from '../agent-orchestrator/supervisor-task-sync.js';

// CliGate Assistant mainline entry.
// /cligate, assistant runs, async closure, and observability should converge on assistant-core + assistant-agent.

function nowIso() {
  return new Date().toISOString();
}

function parseModeCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;

  const cligateMatch = trimmed.match(/^\/cligate(?:\s+(.+))?$/is);
  if (cligateMatch) {
    return {
      command: 'cligate',
      args: String(cligateMatch[1] || '').trim()
    };
  }

  if (/^\/runtime$/i.test(trimmed)) {
    return {
      command: 'runtime',
      args: ''
    };
  }

  return null;
}

function buildAssistantMetadata(current = {}, patch = {}) {
  return {
    ...current,
    ...patch,
    updatedAt: nowIso()
  };
}

function buildFallbackMessage(reason, text) {
  const source = String(text || '');
  const zh = /[\u3400-\u9fff]/.test(source);
  if (reason === 'assistant_agent_disabled') {
    return zh
      ? 'CliGate Assistant 的 LLM supervisor 当前已关闭，因此已回退到基础 assistant 流程。'
      : 'CliGate Assistant supervisor is currently disabled, so the request fell back to the basic assistant flow.';
  }
  if (reason === 'no_available_llm_source') {
    return zh
      ? 'CliGate Assistant 当前没有可用的模型来源，因此已回退到基础 assistant 流程。'
      : 'CliGate Assistant could not find an available model source, so the request fell back to the basic assistant flow.';
  }
  if (reason === 'assistant llm failed' || String(reason || '').includes('assistant llm failed')) {
    return zh
      ? 'CliGate Assistant 在本轮执行中调用模型失败，因此已回退到基础 assistant 流程。'
      : 'CliGate Assistant failed during model execution for this turn, so the request fell back to the basic assistant flow.';
  }
  return zh
    ? 'CliGate Assistant 当前已回退到基础 assistant 流程。'
    : 'CliGate Assistant is currently running in the basic fallback assistant flow.';
}

function normalizeText(value) {
  return String(value || '').trim();
}

function buildAssistantRunObservability(run = null) {
  if (!run || typeof run !== 'object') return null;
  const assistantAgent = run?.metadata?.assistantAgent || {};
  const agentMeta = run?.metadata?.agent || {};
  const llmSource = agentMeta?.llmSource || null;
  const stopPolicy = run?.metadata?.stopPolicy || null;
  const fallbackMode = assistantAgent?.mode === 'fallback';

  return {
    mode: fallbackMode ? 'fallback' : 'agent',
    resolvedSource: llmSource
      ? {
          kind: normalizeText(llmSource.kind),
          label: normalizeText(llmSource.label),
          model: normalizeText(llmSource.model)
        }
      : null,
    fallbackReason: normalizeText(assistantAgent?.reason),
    stopPolicy: stopPolicy && typeof stopPolicy === 'object'
      ? {
          status: normalizeText(stopPolicy.status),
          closure: normalizeText(stopPolicy.closure),
          reason: normalizeText(stopPolicy.reason)
        }
      : null
  };
}

function getDelegatedRuntimeResult(executed = {}) {
  const toolResults = Array.isArray(executed?.toolResults) ? executed.toolResults : [];
  return toolResults.find((entry) => (
    [
      'start_runtime_task',
      'delegate_to_codex',
      'delegate_to_claude_code',
      'delegate_to_runtime',
      'reuse_or_delegate',
      'send_runtime_input'
    ].includes(entry?.toolName)
    && entry?.result?.id
  ))?.result || null;
}

function getDelegatedRuntimeResults(executed = {}) {
  const toolResults = Array.isArray(executed?.toolResults) ? executed.toolResults : [];
  const seen = new Set();
  const results = [];
  for (const entry of toolResults) {
    if (![
      'start_runtime_task',
      'delegate_to_codex',
      'delegate_to_claude_code',
      'delegate_to_runtime',
      'reuse_or_delegate',
      'send_runtime_input'
    ].includes(entry?.toolName)) {
      continue;
    }
    const result = entry?.result;
    const sessionId = String(result?.id || result?.session?.id || '').trim();
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    results.push(result);
  }
  return results;
}

function getPrimaryRuntimeResult(executed = {}) {
  return getDelegatedRuntimeResults(executed)[0] || getDelegatedRuntimeResult(executed);
}

function isTerminalRuntimeStatus(status) {
  return [
    AGENT_SESSION_STATUS.READY,
    AGENT_SESSION_STATUS.FAILED,
    AGENT_SESSION_STATUS.CANCELLED
  ].includes(String(status || ''));
}

function runtimeStatusToTaskStatus(session, { pendingApproval = null, pendingQuestion = null } = {}) {
  if (pendingQuestion) return 'waiting_user';
  if (pendingApproval) return 'waiting_approval';
  const status = String(session?.status || '');
  if (status === AGENT_SESSION_STATUS.READY) return 'completed';
  if (status === AGENT_SESSION_STATUS.FAILED) return 'failed';
  if (status === AGENT_SESSION_STATUS.CANCELLED) return 'cancelled';
  return status || 'starting';
}

function shouldDeferBackgroundCallback(result = null) {
  const sessionIds = Array.isArray(result?.assistantRun?.relatedRuntimeSessionIds)
    ? result.assistantRun.relatedRuntimeSessionIds.filter(Boolean)
    : [];
  return result?.assistantRun?.status === ASSISTANT_RUN_STATUS.WAITING_RUNTIME
    && sessionIds.length > 0;
}

function buildAggregatedRuntimeMessage({ sessions = [], runText = '' } = {}) {
  const zh = /[\u3400-\u9fff]/.test(String(runText || ''));
  const lines = sessions.map((session, index) => {
    const label = session?.provider === 'claude-code' ? 'Claude Code' : (session?.provider === 'codex' ? 'Codex' : String(session?.provider || 'runtime'));
    const status = String(session?.status || '').trim();
    const summary = String(session?.summary || '').trim();
    const result = String(session?.result || '').trim();
    const error = String(session?.error || '').trim();
    const detail = result || summary || error || status || (zh ? '已结束' : 'finished');
    return `${index + 1}. ${label}: ${detail}`;
  });

  if (lines.length === 1) {
    return lines[0].replace(/^1\.\s*/, '');
  }

  if (zh) {
    return lines.length > 0
      ? `并发任务已全部结束，汇总如下：\n${lines.join('\n')}`
      : '并发任务已全部结束。';
  }

  return lines.length > 0
    ? `All parallel runtime tasks finished:\n${lines.join('\n')}`
    : 'All parallel runtime tasks finished.';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syncPendingRuntimeMarkers(conversationStore, messageService, conversation = null) {
  const sessionId = String(conversation?.activeRuntimeSessionId || '').trim();
  if (!conversation?.id || !sessionId) {
    return conversation;
  }

  const patch = {};
  const pendingApprovalId = String(conversation?.lastPendingApprovalId || '').trim();
  if (pendingApprovalId) {
    const stillPending = messageService.listPendingApprovals(sessionId)
      .some((entry) => String(entry?.approvalId || '').trim() === pendingApprovalId);
    if (!stillPending) {
      patch.lastPendingApprovalId = null;
    }
  }

  const pendingQuestionId = String(conversation?.lastPendingQuestionId || '').trim();
  if (pendingQuestionId) {
    const stillPending = messageService.listPendingQuestions(sessionId)
      .some((entry) => (
        String(entry?.questionId || '').trim() === pendingQuestionId
        && String(entry?.status || '').trim() === 'pending'
      ));
    if (!stillPending) {
      patch.lastPendingQuestionId = null;
    }
  }

  const pendingClarificationId = String(conversation?.lastPendingClarificationId || '').trim();
  if (pendingClarificationId) {
    const clarification = assistantClarificationStore.get(pendingClarificationId);
    if (!clarification || clarification.status !== 'pending' || clarification.conversationId !== conversation.id) {
      patch.lastPendingClarificationId = null;
    }
  }

  if (Object.keys(patch).length === 0) {
    return conversation;
  }

  return conversationStore.patch(conversation.id, patch) || conversation;
}

export class AssistantModeService {
  constructor({
    conversationStore,
    assistantSessionStore: assistantSessionStoreArg = assistantSessionStore,
    assistantRunStore: assistantRunStoreArg = assistantRunStore,
    observationService = assistantObservationService,
    messageService = agentOrchestratorMessageService,
    taskViewService = assistantTaskViewService,
    taskStore = null,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    runner = null,
    dialogueService = null
  } = {}) {
    this.conversationStore = conversationStore;
    this.assistantSessionStore = assistantSessionStoreArg instanceof AssistantSessionStore
      ? assistantSessionStoreArg
      : assistantSessionStoreArg;
    this.assistantRunStore = assistantRunStoreArg instanceof AssistantRunStore
      ? assistantRunStoreArg
      : assistantRunStoreArg;
    this.observationService = observationService instanceof AssistantObservationService
      ? observationService
      : observationService;
    this.messageService = messageService;
    this.taskViewService = taskViewService;
    this.taskStore = taskStore
      || this.taskViewService?.taskStore
      || this.observationService?.taskStore
      || agentTaskStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.runner = runner || new AssistantRunner({
      runStore: this.assistantRunStore,
      observationService: this.observationService,
      messageService: this.messageService,
      taskViewService: this.taskViewService
    });
    this.dialogueService = dialogueService || new AssistantDialogueService({
      runStore: this.assistantRunStore,
      observationService: this.observationService,
      taskViewService: this.taskViewService,
      messageService: this.messageService,
      fallbackRunner: this.runner
    });
  }

  getConversationAssistantState(conversation) {
    return conversation?.metadata?.assistantCore || {};
  }

  isAssistantModeActive(conversation) {
    return this.getConversationAssistantState(conversation).mode === ASSISTANT_CONTROL_MODE.ASSISTANT;
  }

  patchConversation(conversation, patch = {}) {
    const metadataPatch = patch.metadata
      ? {
          ...(conversation.metadata || {}),
          ...(patch.metadata || {})
        }
      : undefined;
    return this.conversationStore.patch(conversation.id, {
      ...patch,
      ...(metadataPatch ? { metadata: metadataPatch } : {})
    });
  }

  ensureAssistantSession(conversation) {
    const state = this.getConversationAssistantState(conversation);
    const session = state.assistantSessionId
      ? this.assistantSessionStore.get(state.assistantSessionId)
      : null;
    if (session) return session;

    return this.assistantSessionStore.findOrCreateByConversationId(conversation.id, {
      title: `CliGate Assistant / ${conversation.title || conversation.id}`
    });
  }

  async finalizeRunSuccess({ conversation, assistantSession, runText, executed, assistantModeActive } = {}) {
    const persistedRun = this.assistantRunStore.save(executed.run);
    this.assistantSessionStore.save({
      ...assistantSession,
      lastRunId: persistedRun.id,
      lastUserMessage: runText,
      lastAssistantSummary: executed.reply.summary
    });

    const delegatedRuntimes = getDelegatedRuntimeResults(executed);
    const delegatedRuntime = delegatedRuntimes[0] || null;
    const nextAssistantMetadata = {
      assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
        mode: assistantModeActive ? ASSISTANT_CONTROL_MODE.ASSISTANT : ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME,
        assistantSessionId: assistantSession.id,
        lastRunId: persistedRun.id,
        lastRunSummary: executed.reply.summary
      })
    };
    let nextConversation = this.patchConversation(conversation, {
      metadata: nextAssistantMetadata
    });

    if (delegatedRuntime?.id) {
      const sourceContext = persistedRun?.metadata?.plan?.summaryIntent === 'runtime_start'
        ? {
            kind: 'assistant',
            sourceTitle: conversation?.metadata?.supervisor?.brief?.title || '',
            sourceProvider: conversation?.metadata?.supervisor?.brief?.provider || '',
            sourceStatus: conversation?.metadata?.supervisor?.brief?.status || ''
          }
        : null;

      for (const runtime of delegatedRuntimes) {
        const pendingApproval = this.messageService.listPendingApprovals(runtime.id)[0] || null;
        const pendingQuestion = this.messageService.listPendingQuestions(runtime.id)
          .find((entry) => entry.status === 'pending') || null;
        const taskRecord = syncTaskFromRuntimeResult({
          conversation: nextConversation,
          result: {
            type: runtime?.turnCount > 1 ? 'runtime_continued' : 'runtime_started',
            provider: runtime.provider,
            session: runtime,
            supervisorContext: sourceContext
              ? {
                  ...sourceContext,
                  title: runtime.title || runText,
                  summary: executed.reply.summary || ''
                }
              : null
          },
          userInput: runText,
          store: this.taskStore
        });
        const synced = syncSupervisorTaskForRuntimeStart({
          conversation: nextConversation,
          session: runtime,
          supervisorContext: sourceContext
            ? {
                ...sourceContext,
                title: runtime.title || taskRecord?.title || runText || '',
                summary: String(executed.reply.summary || runtime.summary || '').trim()
              }
            : {
                kind: 'assistant',
                title: runtime.title || taskRecord?.title || runText || '',
                summary: String(executed.reply.summary || runtime.summary || '').trim()
              },
          taskMemory: nextConversation?.metadata?.supervisor?.taskMemory || conversation.metadata?.supervisor?.taskMemory || null,
          pendingApproval,
          pendingQuestion,
          userInput: runText,
          originKind: 'assistant',
          activate: runtime.id === delegatedRuntime.id,
          store: this.supervisorTaskStore
        });
        const taskMemory = synced.taskMemory;
        nextConversation = this.conversationStore.patch(conversation.id, {
          activeTaskId: taskMemory?.activeTaskId || nextConversation?.activeTaskId || conversation?.activeTaskId || null,
          trackedTaskIds: taskMemory?.taskOrder || nextConversation?.trackedTaskIds || conversation?.trackedTaskIds || [],
          metadata: {
            ...(nextConversation?.metadata || conversation?.metadata || {}),
            assistantCore: nextAssistantMetadata.assistantCore,
            supervisor: {
              ...(((nextConversation?.metadata || conversation?.metadata || {})?.supervisor
                && typeof ((nextConversation?.metadata || conversation?.metadata || {})?.supervisor) === 'object')
                ? ((nextConversation?.metadata || conversation?.metadata || {})?.supervisor)
                : {}),
              taskMemory,
              brief: synced.brief
            }
          }
        });
      }

      nextConversation = this.conversationStore.bindRuntimeSession(conversation.id, delegatedRuntime.id, {
        mode: CHANNEL_CONVERSATION_MODE.AGENT_RUNTIME,
        lastPendingApprovalId: this.messageService.listPendingApprovals(delegatedRuntime.id)[0]?.approvalId || null,
        lastPendingQuestionId: this.messageService.listPendingQuestions(delegatedRuntime.id)
          .find((entry) => entry.status === 'pending')?.questionId || null,
        activeTaskId: nextConversation?.metadata?.supervisor?.taskMemory?.activeTaskId || nextConversation?.activeTaskId || conversation?.activeTaskId || null,
        trackedTaskIds: nextConversation?.metadata?.supervisor?.taskMemory?.taskOrder || nextConversation?.trackedTaskIds || conversation?.trackedTaskIds || [],
        metadata: {
          ...(nextConversation?.metadata || conversation?.metadata || {}),
          assistantCore: nextAssistantMetadata.assistantCore,
          supervisor: {
            ...(((nextConversation?.metadata || conversation?.metadata || {})?.supervisor
              && typeof ((nextConversation?.metadata || conversation?.metadata || {})?.supervisor) === 'object')
              ? ((nextConversation?.metadata || conversation?.metadata || {})?.supervisor)
                : {}),
            taskMemory: nextConversation?.metadata?.supervisor?.taskMemory || null,
            brief: buildSupervisorBrief({
              taskMemory: nextConversation?.metadata?.supervisor?.taskMemory || null,
              session: delegatedRuntime
            })
          }
        }
      });
    }

    nextConversation = syncPendingRuntimeMarkers(
      this.conversationStore,
      this.messageService,
      nextConversation
    );

    return {
      type: 'assistant_response',
      message: [
        executed.run?.metadata?.assistantAgent?.mode === 'fallback'
          ? buildFallbackMessage(executed.run?.metadata?.assistantAgent?.reason, runText)
          : '',
        executed.reply.message
      ].filter(Boolean).join('\n\n'),
      assistantSession,
      assistantRun: persistedRun,
      observability: buildAssistantRunObservability(persistedRun),
      toolResults: executed.toolResults,
      conversation: nextConversation
    };
  }

  async waitForRelatedRuntimeAggregation({ conversationId, assistantSession, runText, assistantModeActive, runId } = {}) {
    const currentRun = this.assistantRunStore.get(runId);
    const sessionIds = Array.isArray(currentRun?.relatedRuntimeSessionIds)
      ? [...new Set(currentRun.relatedRuntimeSessionIds.filter(Boolean))]
      : [];
    if (sessionIds.length === 0) {
      return null;
    }

    const readSessions = () => sessionIds.map((sessionId) => this.messageService.getRuntimeSession(sessionId)).filter(Boolean);
    const sessionsReady = () => {
      const sessions = readSessions();
      return sessions.length === sessionIds.length && sessions.every((session) => isTerminalRuntimeStatus(session.status))
        ? sessions
        : null;
    };

    const immediate = sessionsReady();
    const sessions = immediate || await new Promise((resolve) => {
      let settled = false;
      const finish = (terminal) => {
        if (settled || !terminal) return;
        settled = true;
        for (const unsubscribe of unsubscribers) {
          unsubscribe();
        }
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        resolve(terminal);
      };
      const unsubscribers = sessionIds.map((sessionId) => this.messageService.runtimeSessionManager.subscribe(sessionId, () => {
        finish(sessionsReady());
      }));
      const pollTimer = setInterval(() => {
        finish(sessionsReady());
      }, 25);
      const timeoutTimer = setTimeout(async () => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const terminal = sessionsReady();
          if (terminal) {
            finish(terminal);
            return;
          }
          await sleep(25);
        }
        finish(readSessions());
      }, 250);
    });

    const latestConversation = this.conversationStore.get(conversationId);
    let taskMemory = normalizeSupervisorTaskMemory(latestConversation?.metadata?.supervisor?.taskMemory);
    const runtimeSummaries = [];
    for (const session of sessions) {
      const task = this.taskStore?.findByRuntimeSessionId?.(session.id) || null;
      const summary = task?.summary || session.summary || '';
      const result = task?.result || '';
      const error = task?.error || session.error || '';
      const title = task?.title || session.title || '';
      runtimeSummaries.push({
        id: session.id,
        provider: session.provider,
        status: session.status,
        title,
        summary,
        result,
        error
      });
      const synced = syncSupervisorTaskForRuntimeTerminal({
        conversationId,
        session,
        taskMemory,
        patch: session.status === AGENT_SESSION_STATUS.READY
          ? {
              status: 'completed',
              lastUpdateAt: session.updatedAt || new Date().toISOString(),
              summary,
              result,
              pendingApprovalTitle: '',
              pendingQuestion: ''
            }
          : {
              status: session.status === AGENT_SESSION_STATUS.CANCELLED ? 'cancelled' : 'failed',
              lastUpdateAt: session.updatedAt || new Date().toISOString(),
              error,
              pendingApprovalTitle: '',
              pendingQuestion: ''
            },
        terminalKind: session.status === AGENT_SESSION_STATUS.READY ? 'completed' : 'failed',
        store: this.supervisorTaskStore
      });
      taskMemory = synced.taskMemory;
    }

    const nextConversation = this.conversationStore.patch(conversationId, {
      activeTaskId: taskMemory?.activeTaskId || latestConversation?.activeTaskId || null,
      trackedTaskIds: taskMemory?.taskOrder || latestConversation?.trackedTaskIds || [],
      metadata: {
        ...((latestConversation?.metadata || {})),
        assistantCore: buildAssistantMetadata(this.getConversationAssistantState(latestConversation), {
          mode: assistantModeActive ? ASSISTANT_CONTROL_MODE.ASSISTANT : ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME,
          assistantSessionId: assistantSession.id
        }),
        supervisor: {
          ...(((latestConversation?.metadata || {})?.supervisor && typeof ((latestConversation?.metadata || {})?.supervisor) === 'object')
            ? ((latestConversation?.metadata || {})?.supervisor)
            : {}),
          taskMemory,
          brief: buildSupervisorBrief({
            taskMemory,
            session: sessions[0] || null
          })
        }
      }
    });

    const failed = sessions.some((session) => session.status === AGENT_SESSION_STATUS.FAILED || session.status === AGENT_SESSION_STATUS.CANCELLED);
    const finalRun = this.assistantRunStore.save({
      ...currentRun,
      status: failed ? ASSISTANT_RUN_STATUS.FAILED : ASSISTANT_RUN_STATUS.COMPLETED,
      summary: failed ? 'Parallel runtime tasks finished with at least one failure.' : 'Parallel runtime tasks finished.',
      result: buildAggregatedRuntimeMessage({ sessions: runtimeSummaries, runText }),
      metadata: {
        ...(currentRun?.metadata || {}),
        runtimeAggregation: {
          done: true,
          sessionIds,
          runtimeSummaries
        },
        stopPolicy: {
          status: failed ? ASSISTANT_RUN_STATUS.FAILED : ASSISTANT_RUN_STATUS.COMPLETED,
          closure: failed ? 'failed' : 'assistant_done',
          reason: failed ? 'parallel_runtime_failed' : 'parallel_runtime_completed'
        }
      }
    });

    this.assistantSessionStore.save({
      ...assistantSession,
      lastRunId: finalRun.id,
      lastUserMessage: runText,
      lastAssistantSummary: finalRun.summary
    });

    return {
      type: 'assistant_response',
      message: finalRun.result,
      assistantSession,
      assistantRun: finalRun,
      observability: buildAssistantRunObservability(finalRun),
      conversation: nextConversation
    };
  }

  async finalizeRunFailure({ conversation, assistantSession, runText, run, error, assistantModeActive } = {}) {
    const failedRun = error?.assistantRun || this.assistantRunStore.save({
      ...run,
      status: ASSISTANT_RUN_STATUS.FAILED,
      summary: error.message || 'Assistant run failed',
      metadata: {
        ...(run.metadata || {}),
        error: error.message || 'Assistant run failed'
      }
    });

    this.assistantSessionStore.save({
      ...assistantSession,
      lastRunId: failedRun.id,
      lastUserMessage: runText,
      lastAssistantSummary: failedRun.summary || ''
    });

    const nextConversation = this.patchConversation(conversation, {
      metadata: {
        assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
          mode: assistantModeActive ? ASSISTANT_CONTROL_MODE.ASSISTANT : ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME,
          assistantSessionId: assistantSession.id,
          lastRunId: failedRun.id,
          lastRunSummary: failedRun.summary || ''
        })
      }
    });

    return {
      type: 'assistant_response',
      message: error.message || 'Assistant run failed',
      isError: true,
      assistantSession,
      assistantRun: failedRun,
      observability: buildAssistantRunObservability(failedRun),
      conversation: nextConversation
    };
  }

  runAcceptedMessage(text) {
    return /[\u3400-\u9fff]/.test(String(text || ''))
      ? `CliGate Assistant 已在后台开始处理“${String(text || '').trim().slice(0, 80)}”，完成后把结果回给你。`
      : `CliGate Assistant started working on "${String(text || '').trim().slice(0, 80)}" in the background and will send back the result.`;
  }

  async maybeHandleMessage({
    conversation,
    text,
    defaultRuntimeProvider = 'codex',
    cwd = '',
    model = '',
    executionMode = 'sync',
    onBackgroundResult = null
  } = {}) {
    const parsed = parseModeCommand(text);
    const assistantModeActive = this.isAssistantModeActive(conversation);

    if (parsed?.command === 'runtime') {
      const nextConversation = this.patchConversation(conversation, {
        metadata: {
          assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
            mode: ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME
          })
        }
      });

      return {
        type: 'assistant_mode_exited',
        message: conversation?.activeRuntimeSessionId
          ? `Returned to direct runtime mode. Your next message will continue runtime session ${conversation.activeRuntimeSessionId}.`
          : 'Returned to direct runtime mode. Your next message will go to the runtime path directly.',
        conversation: nextConversation
      };
    }

    if (!parsed && !assistantModeActive) {
      return null;
    }

    const assistantSession = this.ensureAssistantSession(conversation);
    const isEnterOnly = parsed?.command === 'cligate' && !parsed.args;
    const runText = parsed?.command === 'cligate'
      ? parsed.args
      : String(text || '').trim();

    if (isEnterOnly) {
      const nextConversation = this.patchConversation(conversation, {
        metadata: {
          assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
            mode: ASSISTANT_CONTROL_MODE.ASSISTANT,
            assistantSessionId: assistantSession.id,
            lastActivatedAt: nowIso()
          })
        }
      });

      return {
        type: 'assistant_mode_entered',
        message: 'CliGate Assistant mode is active. Send your next message here, or use /runtime to return to direct runtime mode.',
        conversation: nextConversation,
        assistantSession
      };
    }

    const run = this.assistantRunStore.create({
      assistantSessionId: assistantSession.id,
      conversationId: conversation.id,
      triggerText: runText,
      mode: assistantModeActive ? 'session' : 'one-shot',
      status: ASSISTANT_RUN_STATUS.QUEUED,
      metadata: {
        observationHint: {
          activeRuntimeSessionId: conversation?.activeRuntimeSessionId || null
        }
      }
    });

    if (executionMode === 'async') {
      Promise.resolve().then(async () => {
        try {
          const executed = await this.dialogueService.run({
            run,
            conversation,
            text: runText,
            defaultRuntimeProvider,
            cwd,
            model
          });
          const result = await this.finalizeRunSuccess({
            conversation,
            assistantSession,
            runText,
            executed,
            assistantModeActive
          });
          if (shouldDeferBackgroundCallback(result)) {
            const aggregated = await this.waitForRelatedRuntimeAggregation({
              conversationId: conversation.id,
              assistantSession,
              runText,
              assistantModeActive,
              runId: result?.assistantRun?.id
            });
            if (aggregated && typeof onBackgroundResult === 'function') {
              await onBackgroundResult(aggregated);
            }
          } else if (typeof onBackgroundResult === 'function') {
            await onBackgroundResult(result);
          }
        } catch (error) {
          const failed = await this.finalizeRunFailure({
            conversation,
            assistantSession,
            runText,
            run,
            error,
            assistantModeActive
          });
          if (typeof onBackgroundResult === 'function') {
            await onBackgroundResult(failed);
          }
        }
      }).catch(() => {});

      const nextConversation = this.patchConversation(conversation, {
        metadata: {
          assistantCore: buildAssistantMetadata(this.getConversationAssistantState(conversation), {
            mode: assistantModeActive ? ASSISTANT_CONTROL_MODE.ASSISTANT : ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME,
            assistantSessionId: assistantSession.id,
            lastRunId: run.id,
            lastRunSummary: 'accepted'
          })
        }
      });

      return {
        type: 'assistant_run_accepted',
        message: this.runAcceptedMessage(runText),
        assistantSession,
        assistantRun: this.assistantRunStore.get(run.id) || run,
        observability: buildAssistantRunObservability(this.assistantRunStore.get(run.id) || run),
        conversation: nextConversation
      };
    }

    try {
      const executed = await this.dialogueService.run({
        run,
        conversation,
        text: runText,
        defaultRuntimeProvider,
        cwd,
        model
      });
      return this.finalizeRunSuccess({
        conversation,
        assistantSession,
        runText,
        executed,
        assistantModeActive
      });
    } catch (error) {
      return this.finalizeRunFailure({
        conversation,
        assistantSession,
        runText,
        run,
        error,
        assistantModeActive
      });
    }
  }
}

export default AssistantModeService;
