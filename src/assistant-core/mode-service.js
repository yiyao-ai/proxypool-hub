import { ASSISTANT_CONTROL_MODE, ASSISTANT_RUN_STATUS } from './models.js';
import assistantSessionStore, { AssistantSessionStore } from './session-store.js';
import assistantRunStore, { AssistantRunStore } from './run-store.js';
import assistantObservationService, { AssistantObservationService } from './observation-service.js';
import AssistantRunner from './runner.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import assistantTaskViewService from './task-view-service.js';
import AssistantDialogueService from '../assistant-agent/dialogue-service.js';
import { CHANNEL_CONVERSATION_MODE } from '../agent-channels/models.js';
import { buildSupervisorBrief } from '../agent-orchestrator/supervisor-brief.js';
import { syncTaskFromRuntimeResult } from '../agent-core/task-service.js';

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

export class AssistantModeService {
  constructor({
    conversationStore,
    assistantSessionStore: assistantSessionStoreArg = assistantSessionStore,
    assistantRunStore: assistantRunStoreArg = assistantRunStore,
    observationService = assistantObservationService,
    messageService = agentOrchestratorMessageService,
    taskViewService = assistantTaskViewService,
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

    const delegatedRuntime = getDelegatedRuntimeResult(executed);
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
      const pendingApproval = this.messageService.listPendingApprovals(delegatedRuntime.id)[0] || null;
      const pendingQuestion = this.messageService.listPendingQuestions(delegatedRuntime.id)
        .find((entry) => entry.status === 'pending') || null;
      const taskRecord = syncTaskFromRuntimeResult({
        conversation: nextConversation,
        result: {
          type: delegatedRuntime?.turnCount > 1 ? 'runtime_continued' : 'runtime_started',
          provider: delegatedRuntime.provider,
          session: delegatedRuntime,
          supervisorContext: persistedRun?.metadata?.plan?.summaryIntent === 'runtime_start'
            ? {
                kind: 'assistant',
                title: delegatedRuntime.title || runText,
                summary: executed.reply.summary || '',
                sourceTitle: conversation?.metadata?.supervisor?.brief?.title || '',
                sourceProvider: conversation?.metadata?.supervisor?.brief?.provider || '',
                sourceStatus: conversation?.metadata?.supervisor?.brief?.status || ''
              }
            : null
        },
        userInput: runText
      });
      const taskMemory = {
        ...((conversation.metadata?.supervisor?.taskMemory && typeof conversation.metadata.supervisor.taskMemory === 'object')
          ? conversation.metadata.supervisor.taskMemory
          : {}),
        current: {
          sessionId: delegatedRuntime.id,
          provider: delegatedRuntime.provider,
          title: delegatedRuntime.title || taskRecord?.title || runText || '',
          status: pendingQuestion
            ? 'waiting_user'
            : (pendingApproval ? 'waiting_approval' : (delegatedRuntime.status || 'starting')),
          startedAt: delegatedRuntime.createdAt || new Date().toISOString(),
          lastUpdateAt: delegatedRuntime.updatedAt || new Date().toISOString(),
          summary: String(executed.reply.summary || delegatedRuntime.summary || '').trim(),
          result: '',
          originKind: 'assistant',
          sourceTitle: String(conversation?.metadata?.supervisor?.brief?.title || '').trim(),
          sourceProvider: String(conversation?.metadata?.supervisor?.brief?.provider || '').trim(),
          sourceStatus: String(conversation?.metadata?.supervisor?.brief?.status || '').trim(),
          pendingApprovalTitle: String(pendingApproval?.title || '').trim(),
          pendingQuestion: String(pendingQuestion?.text || '').trim()
        }
      };

      nextConversation = this.conversationStore.bindRuntimeSession(conversation.id, delegatedRuntime.id, {
        mode: CHANNEL_CONVERSATION_MODE.AGENT_RUNTIME,
        lastPendingApprovalId: pendingApproval?.approvalId || null,
        lastPendingQuestionId: pendingQuestion?.questionId || null,
        metadata: {
          ...(nextConversation?.metadata || conversation?.metadata || {}),
          assistantCore: nextAssistantMetadata.assistantCore,
          supervisor: {
            ...(((nextConversation?.metadata || conversation?.metadata || {})?.supervisor
              && typeof ((nextConversation?.metadata || conversation?.metadata || {})?.supervisor) === 'object')
              ? ((nextConversation?.metadata || conversation?.metadata || {})?.supervisor)
              : {}),
            taskMemory,
            brief: buildSupervisorBrief({
              taskMemory,
              session: delegatedRuntime
            })
          }
        }
      });
    }

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
          if (typeof onBackgroundResult === 'function') {
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
