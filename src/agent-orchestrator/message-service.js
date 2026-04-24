import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentRuntimeApprovalPolicyStore from '../agent-runtime/approval-policy-store.js';
import agentPreferenceStore from '../agent-core/preference-store.js';
import { buildPreferenceSavedMessage, saveConversationPreferences } from '../agent-core/preference-service.js';
import { selectRuntimeProvider } from '../agent-core/provider-selection.js';
import { AGENT_SESSION_STATUS } from '../agent-runtime/models.js';
import { buildSupervisorBrief } from './supervisor-brief.js';
import { AssistantMemoryService } from '../assistant-core/memory-service.js';
import { AssistantPolicyService } from '../assistant-core/policy-service.js';
import supervisorTaskStore from './supervisor-task-store.js';
import taskExecutionService, { TaskExecutionService } from './task-execution-service.js';
import { listSupervisorTaskRecords } from './supervisor-task-memory.js';

function parseLeadingCommand(input) {
  const text = String(input || '').trim();
  if (!text.startsWith('/')) {
    return null;
  }

  const match = text.match(/^\/([a-zA-Z-]+)(?:\s+(.+))?$/s);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: String(match[2] || '').trim()
  };
}

function parseProviderAlias(command, args) {
  const normalized = String(command || '').toLowerCase();
  if (normalized === 'cx') {
    return {
      provider: 'codex',
      input: String(args || '').trim()
    };
  }
  if (normalized === 'cc') {
    return {
      provider: 'claude-code',
      input: String(args || '').trim()
    };
  }
  return null;
}

function parseAgentCommand(args) {
  const match = String(args || '').match(/^(codex|claude(?:-code)?)\s+(.+)$/is);
  if (!match) return null;
  return {
    provider: match[1].toLowerCase().startsWith('claude') ? 'claude-code' : 'codex',
    input: String(match[2] || '').trim()
  };
}

function parseRuntimeTarget(args) {
  const command = parseLeadingCommand(`/${String(args || '').trim()}`);
  const alias = parseProviderAlias(command?.command, command?.args);
  if (alias) {
    return alias;
  }
  return parseAgentCommand(args);
}

function buildResetResponse(message, activeSessionId = null) {
  return {
    type: 'conversation_reset',
    message,
    previousSessionId: activeSessionId || null
  };
}

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function getTaskMemory(conversation) {
  return conversation?.metadata?.supervisor?.taskMemory || null;
}

function getCurrentTask(conversation) {
  const taskMemory = getTaskMemory(conversation);
  if (!taskMemory || typeof taskMemory !== 'object') return null;
  const activeTaskId = String(taskMemory.activeTaskId || '').trim();
  const byTask = taskMemory.byTask && typeof taskMemory.byTask === 'object'
    ? taskMemory.byTask
    : {};
  if (activeTaskId && byTask[activeTaskId]) {
    return byTask[activeTaskId];
  }
  return taskMemory.currentTask || taskMemory.current || null;
}

function getCurrentTaskSessionId(conversation) {
  return String(getCurrentTask(conversation)?.sessionId || '').trim() || null;
}

function getTrackedSupervisorTasks(conversation, store = supervisorTaskStore) {
  const memoryTasks = listSupervisorTaskRecords(getTaskMemory(conversation));
  const persisted = conversation?.id ? store.listByConversationId(conversation.id, { limit: 50 }) : [];
  if (persisted.length === 0) {
    return memoryTasks.map((entry) => ({
      taskId: String(entry?.taskId || entry?.sessionId || '').trim(),
      sessionId: String(entry?.sessionId || '').trim(),
      provider: String(entry?.provider || '').trim(),
      title: String(entry?.title || '').trim(),
      status: String(entry?.status || '').trim(),
      summary: String(entry?.summary || '').trim(),
      result: String(entry?.result || '').trim(),
      error: String(entry?.error || '').trim(),
      pendingApprovalTitle: String(entry?.pendingApprovalTitle || '').trim(),
      pendingQuestion: String(entry?.pendingQuestion || '').trim()
    })).filter((entry) => entry.taskId);
  }
  return persisted.map((entry) => ({
    taskId: String(entry?.id || '').trim(),
    sessionId: String(entry?.metadata?.latestExecutionId || entry?.metadata?.runtimeSessionId || entry?.primaryExecutionId || '').trim(),
    provider: String(entry?.metadata?.provider || entry?.executorStrategy || '').trim(),
    title: String(entry?.title || '').trim(),
    status: String(entry?.status || '').trim(),
    summary: String(entry?.summary || '').trim(),
    result: String(entry?.result || '').trim(),
    error: String(entry?.error || '').trim(),
    pendingApprovalTitle: String(entry?.awaitingKind === 'approval' ? entry?.awaitingPayload?.title : '').trim(),
    pendingQuestion: String(entry?.awaitingKind === 'user_input' ? entry?.awaitingPayload?.text : '').trim()
  })).filter((entry) => entry.taskId);
}

function isTerminalTaskStatus(status) {
  return ['completed', 'failed', 'cancelled'].includes(String(status || '').trim());
}

function selectTaskRoute(conversation, { text = '', parsed = null, activeSession = null } = {}, store = supervisorTaskStore) {
  if (!conversation) {
    return {
      kind: 'none',
      task: null,
      activeTasks: []
    };
  }

  const currentTask = getCurrentTask(conversation);
  const tasks = getTrackedSupervisorTasks(conversation, store);
  const activeTasks = tasks.filter((entry) => !isTerminalTaskStatus(entry.status));
  const waitingTasks = activeTasks.filter((entry) => ['waiting_approval', 'waiting_user'].includes(entry.status));

  if (currentTask?.taskId) {
    const matched = activeTasks.find((entry) => entry.taskId === String(currentTask.taskId).trim())
      || tasks.find((entry) => entry.taskId === String(currentTask.taskId).trim());
    if (matched) {
      return {
        kind: 'current_task',
        task: matched,
        activeTasks
      };
    }
  }

  if (!parsed && waitingTasks.length === 1) {
    return {
      kind: 'single_waiting',
      task: waitingTasks[0],
      activeTasks
    };
  }

  if (!parsed && activeTasks.length === 1) {
    return {
      kind: 'single_active',
      task: activeTasks[0],
      activeTasks
    };
  }

  if (!parsed && activeTasks.length > 1) {
    return {
      kind: 'needs_clarification',
      task: null,
      activeTasks
    };
  }

  const activeRuntimeTask = activeSession?.id
    ? activeTasks.find((entry) => entry.sessionId === activeSession.id) || null
    : null;
  return {
    kind: activeRuntimeTask ? 'active_session' : 'none',
    task: activeRuntimeTask,
    activeTasks
  };
}

function buildTaskClarificationResponse(tasks = []) {
  const lines = tasks.slice(0, 5).map((entry, index) => {
    const waiting = entry.pendingApprovalTitle
      ? ` / waiting approval: ${entry.pendingApprovalTitle}`
      : (entry.pendingQuestion ? ` / waiting input: ${entry.pendingQuestion}` : '');
    return `${index + 1}. ${entry.title || entry.taskId} / ${providerLabel(entry.provider)} / ${entry.status || 'unknown'}${waiting}`;
  });
  return {
    type: 'supervisor_clarification',
    message: [
      'There are multiple active tasks in this conversation. Tell me which one to continue, or start a fresh one with /new.',
      lines.length > 0 ? lines.join('\n') : null
    ].filter(Boolean).join('\n')
  };
}

function getSupervisorBrief(conversation, session = null) {
  const existing = conversation?.metadata?.supervisor?.brief;
  if (existing && typeof existing === 'object' && existing.kind) {
    return existing;
  }
  return buildSupervisorBrief({
    taskMemory: getTaskMemory(conversation),
    session
  });
}

function getPreferredConversationProvider(conversation, session = null, defaultRuntimeProvider = 'codex') {
  const brief = getSupervisorBrief(conversation, session);
  const currentTask = getCurrentTask(conversation);
  return String(currentTask?.provider || session?.provider || brief?.provider || defaultRuntimeProvider || 'codex');
}

function isPreferenceMemoryIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return /(记住|以后|后续|默认|总是|prefer|always|default)/i.test(text)
    && /(中文|英文|claude|codex|简洁|详细|最小改动|concise|detailed|minimal)/i.test(text);
}

function buildSupervisorStatusResponse(conversation, session = null) {
  const brief = getSupervisorBrief(conversation, session);

  if (brief.kind !== 'empty') {
    return {
      type: 'supervisor_status',
      message: [
        `${brief.kind === 'current' ? 'Current task' : 'Remembered task'}: ${brief.title || 'Untitled task'}`,
        brief.taskId ? `Task ID: ${brief.taskId}` : null,
        `Provider: ${brief.providerLabel || providerLabel(brief.provider)}`,
        `Status: ${brief.status || 'unknown'}`,
        brief.summary ? `Summary: ${brief.summary}` : null,
        brief.result ? `Latest result: ${String(brief.result).slice(0, 400)}` : null,
        brief.error ? `Error: ${brief.error}` : null,
        brief.waitingReason ? `Waiting on: ${brief.waitingReason}` : null,
        brief.nextSuggestion ? `Next: ${brief.nextSuggestion}` : null
      ].filter(Boolean).join('\n')
    };
  }

  return {
    type: 'command_error',
    message: 'No remembered task status is available for this conversation yet.'
  };
}

function isNaturalLanguageStatusIntent(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return false;

  return [
    /^(status|progress|update)\b/i,
    /\b(what('| i)?s the status|how('| i)?s it going|progress update|current status)\b/i,
    /(进展如何|现在进度|现在怎么样|情况如何|状态如何|当前状态|现在什么情况|进展怎么样|目前怎么样)/
  ].some((pattern) => pattern.test(text));
}

function isNaturalLanguageTaskContinueIntent(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return false;

  return [
    /^(continue|resume|follow up|keep going)\b/i,
    /(继续刚才那个|继续这个|接着做|接着改|继续处理|继续推进|把刚才那个继续|继续一下)/
  ].some((pattern) => pattern.test(text));
}

function shouldStartFreshFromRememberedContext(brief = null) {
  if (!brief || typeof brief !== 'object') return false;
  return ['last_completed', 'last_failed'].includes(String(brief.kind || ''));
}

function buildRememberedContextMessage(brief = null) {
  const sourceTitle = String(brief?.title || '').trim();
  if (!sourceTitle) {
    return 'Started a fresh task using remembered conversation context.';
  }
  return `Started a fresh task using remembered conversation context from "${sourceTitle}".`;
}

function buildRememberedSupervisorContext(brief = null) {
  return {
    kind: 'direct',
    title: '',
    summary: '',
    sourceTitle: String(brief?.title || '').trim(),
    sourceProvider: String(brief?.provider || '').trim(),
    sourceStatus: String(brief?.status || '').trim()
  };
}

function buildBusyResponse(session, conversation = null) {
  const currentTask = getCurrentTask(conversation);
  const current = session || {};
  const brief = getSupervisorBrief(conversation, session);
  const provider = currentTask?.provider || current.provider || brief.provider;
  const title = currentTask?.title || brief?.title || current.title || '';
  const intro = title
    ? `${brief.providerLabel || providerLabel(provider)} is still busy with "${title}".`
    : `I am still working on the current task with ${providerLabel(provider)}.`;

  if (current.status === AGENT_SESSION_STATUS.WAITING_APPROVAL) {
    return {
      type: 'command_error',
      message: `${intro} It is waiting on a permission decision from you.${brief?.waitingReason ? ` ${brief.waitingReason}.` : ''} Reply with /approve, /deny, or a natural-language reply like “同意” / “拒绝”.`
    };
  }

  if (current.status === AGENT_SESSION_STATUS.WAITING_USER) {
    return {
      type: 'command_error',
      message: `${intro} It still needs your answer before it can continue.${brief?.waitingReason ? ` ${brief.waitingReason}.` : ''} Reply directly to that question and I will pass it along.`
    };
  }

  return {
    type: 'command_error',
    message: `${intro}${brief?.summary ? ` ${brief.summary}.` : ''} Wait for that run to finish, ask for a status update, or send /cancel if you want me to stop it first.`
  };
}

function isSessionBusy(session) {
  return [
    AGENT_SESSION_STATUS.RUNNING,
    AGENT_SESSION_STATUS.WAITING_APPROVAL,
    AGENT_SESSION_STATUS.WAITING_USER,
    AGENT_SESSION_STATUS.STARTING
  ].includes(session?.status);
}

function normalizeDecisionText(input) {
  return String(input || '').trim().toLowerCase();
}

function isApprovalAffirmative(input) {
  const text = normalizeDecisionText(input);
  return /^(同意|可以|允许|继续|行|确认)(?:\s|$|这|该|后|本|给|让|吧)/.test(text)
    || /^(approve|ok|okay|yes|y)\b/.test(text);
}

function isApprovalNegative(input) {
  const text = normalizeDecisionText(input);
  return /^(拒绝|不行|不要|停止)(?:\s|$|这|该|后|本|给|让|吧)/.test(text)
    || /^(deny|no|n)\b/.test(text);
}

function wantsRememberedApproval(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(后续|以后|本会话|别再问|都允许|全部允许|this session|from now on|remember|don'?t ask again)/i.test(text);
}

function wantsConversationRememberedApproval(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(这个对话|这次对话|当前对话|这个聊天|这条会话|this conversation|this chat|以后都|后续都|别再问)/i.test(text);
}

export class AgentOrchestratorMessageService {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    approvalPolicyStore = agentRuntimeApprovalPolicyStore,
    preferenceStore = agentPreferenceStore,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    taskExecutionService: taskExecutionServiceArg = null,
    memoryService = null,
    policyService = null
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.approvalPolicyStore = approvalPolicyStore;
    this.preferenceStore = preferenceStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.taskExecutionService = taskExecutionServiceArg instanceof TaskExecutionService
      ? taskExecutionServiceArg
      : (taskExecutionServiceArg || new TaskExecutionService({
          runtimeSessionManager: this.runtimeSessionManager,
          supervisorTaskStore: this.supervisorTaskStore
        }));
    this.memoryService = memoryService instanceof AssistantMemoryService
      ? memoryService
      : new AssistantMemoryService({
          preferenceStore: this.preferenceStore
        });
    this.policyService = policyService instanceof AssistantPolicyService
      ? policyService
      : new AssistantPolicyService({
          approvalPolicyStore: this.approvalPolicyStore
        });
  }

  async startRuntimeTask({ provider, input, cwd, model = '', metadata = {} } = {}) {
    return this.taskExecutionService.startTaskExecution({
      taskId: metadata?.taskId || '',
      conversationId: metadata?.conversationId || '',
      provider,
      input,
      cwd,
      model,
      role: metadata?.executionRole || 'primary',
      metadata
    });
  }

  async continueRuntimeTask({ sessionId, taskId = '', input } = {}) {
    return this.taskExecutionService.continueTaskExecution({
      taskId,
      sessionId,
      input
    });
  }

  async resolveApproval({ sessionId, approvalId, decision } = {}) {
    return this.runtimeSessionManager.resolveApproval(
      String(sessionId || ''),
      String(approvalId || ''),
      String(decision || '')
    );
  }

  async answerQuestion({ sessionId, questionId, answer } = {}) {
    return this.runtimeSessionManager.answerQuestion(
      String(sessionId || ''),
      String(questionId || ''),
      answer
    );
  }

  cancelRuntimeSession({ sessionId } = {}) {
    return this.runtimeSessionManager.cancelSession(String(sessionId || ''));
  }

  getRuntimeSession(sessionId) {
    return this.runtimeSessionManager.getSession(String(sessionId || ''));
  }

  listPendingQuestions(sessionId) {
    return this.runtimeSessionManager.listPendingQuestions(String(sessionId || ''));
  }

  listPendingApprovals(sessionId) {
    return this.runtimeSessionManager.approvalService.listPending(String(sessionId || ''));
  }

  async routeUserMessage({
    message,
    conversation = null,
    defaultRuntimeProvider = 'codex',
    cwd,
    model = '',
    metadata = {}
  } = {}) {
    const text = String(message?.text || '').trim();
    if (!text) {
      throw new Error('message text is required');
    }

    const parsed = parseLeadingCommand(text);
    const taskRoute = selectTaskRoute(conversation, {
      text,
      parsed,
      activeSession: conversation?.activeRuntimeSessionId
        ? this.getRuntimeSession(conversation.activeRuntimeSessionId)
        : null
    }, this.supervisorTaskStore);
    const routedTaskId = String(taskRoute?.task?.taskId || '').trim() || null;
    const taskSessionId = String(taskRoute?.task?.sessionId || getCurrentTaskSessionId(conversation) || '').trim() || null;
    const activeSessionId = taskSessionId || conversation?.activeRuntimeSessionId || null;
    const pendingApprovalId = conversation?.lastPendingApprovalId || null;
    const pendingQuestionId = conversation?.lastPendingQuestionId || null;
    const activeSession = activeSessionId ? this.getRuntimeSession(activeSessionId) : null;
    const routedTaskSessionId = String(taskRoute?.task?.sessionId || '').trim() || null;
    const resolvedSessionId = routedTaskSessionId || activeSessionId;
    const resolvedSession = resolvedSessionId ? this.getRuntimeSession(resolvedSessionId) : null;
    const supervisorBrief = getSupervisorBrief(conversation, activeSession);
    const preferredProvider = selectRuntimeProvider({
      conversation,
      activeSession: resolvedSession || activeSession,
      rememberedBrief: supervisorBrief,
      defaultRuntimeProvider: getPreferredConversationProvider(conversation, resolvedSession || activeSession, defaultRuntimeProvider),
      preferenceStore: this.preferenceStore
      ,
      memoryService: this.memoryService,
      cwd,
      metadata
    });

    if (!parsed?.command && !activeSessionId && conversation?.id && isPreferenceMemoryIntent(text)) {
      const savedPreferences = this.memoryService.savePreferencesFromText({
        conversation,
        runtimeSession: activeSession,
        text,
        cwd,
        metadata
      }, {
        store: this.preferenceStore
      });
      const savedMessage = this.memoryService.buildSavedMessage(savedPreferences)
        || buildPreferenceSavedMessage(savedPreferences);
      if (savedMessage) {
        return {
          type: 'preference_saved',
          message: savedMessage
        };
      }
    }

    if (resolvedSessionId && pendingApprovalId && !parsed?.command) {
      const approval = this.runtimeSessionManager.approvalService.getApproval(resolvedSessionId, pendingApprovalId);
      if (approval && approval.status === 'pending') {
        if (isApprovalAffirmative(text) || isApprovalNegative(text)) {
          let policy = null;
          if (isApprovalAffirmative(text) && wantsRememberedApproval(text)) {
            const scope = wantsConversationRememberedApproval(text) && conversation?.id
              ? 'conversation'
              : 'runtime_session';
            const scopeRef = scope === 'conversation' ? conversation.id : resolvedSessionId;
            policy = this.policyService.rememberApproval({
              approval,
              scope,
              scopeRef
            });
          }

          const resolved = await this.resolveApproval({
            sessionId: resolvedSessionId,
            approvalId: pendingApprovalId,
            decision: isApprovalAffirmative(text) ? 'approve' : 'deny'
          });

          return {
            type: 'approval_resolved',
            approval: resolved,
            policy,
            message: policy
              ? (policy.scope === 'conversation'
                ? 'Approved. I will remember this permission for this conversation.'
                : 'Approved. I will remember this permission for the current session.')
              : (resolved.status === 'approved' ? 'Approved.' : 'Denied.')
          };
        }
      }
    }

    const aliased = parseProviderAlias(parsed?.command, parsed?.args);
    if (aliased) {
      if (!aliased.input) {
        return {
          type: 'command_error',
          message: aliased.provider === 'codex'
            ? 'Usage: /cx <task>'
            : 'Usage: /cc <task>'
        };
      }

      const session = await this.startRuntimeTask({
        provider: aliased.provider,
        input: aliased.input,
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider: aliased.provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId
      };
    }

    if (parsed?.command === 'agent') {
      const spec = parseAgentCommand(parsed.args);
      if (!spec) {
        return {
          type: 'command_error',
          message: 'Usage: /agent codex <task>, /agent claude <task>, /cx <task>, or /cc <task>'
        };
      }

      const session = await this.startRuntimeTask({
        provider: spec.provider,
        input: spec.input,
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider: spec.provider,
        session
      };
    }

    if (parsed?.command === 'new') {
      if (!parsed.args) {
        return buildResetResponse(
          activeSessionId
            ? 'Detached the active runtime session. Your next message will start a fresh task.'
            : 'No active runtime session is attached. Your next message will start a fresh task.',
          activeSessionId
        );
      }

      const spec = parseRuntimeTarget(parsed.args);
      const provider = spec?.provider || defaultRuntimeProvider;
      const input = spec?.input || parsed.args;
      const session = await this.startRuntimeTask({
        provider,
        input,
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId
      };
    }

    if (parsed?.command === 'detach') {
      return buildResetResponse(
        resolvedSessionId
          ? 'Detached the active runtime session from this conversation.'
          : 'No active runtime session is attached to this conversation.',
        resolvedSessionId
      );
    }

    if (parsed?.command === 'continue') {
      if (!resolvedSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to continue'
        };
      }
      if (isSessionBusy(resolvedSession)) {
        return buildBusyResponse(resolvedSession, conversation);
      }
      const session = await this.continueRuntimeTask({
        sessionId: resolvedSessionId,
        input: parsed.args || text
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    if (parsed?.command === 'cancel') {
      if (!resolvedSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to cancel'
        };
      }
      return {
        type: 'runtime_cancelled',
        session: this.cancelRuntimeSession({ sessionId: resolvedSessionId })
      };
    }

    if (parsed?.command === 'status') {
      if (!resolvedSessionId || !resolvedSession) {
        return buildSupervisorStatusResponse(conversation, null);
      }
      return {
        type: 'runtime_status',
        session: resolvedSession
      };
    }

    if (parsed?.command === 'approve' || parsed?.command === 'deny') {
      if (!resolvedSessionId || !pendingApprovalId) {
        return {
          type: 'command_error',
          message: 'No pending approval request'
        };
      }
      const approval = await this.resolveApproval({
        sessionId: resolvedSessionId,
        approvalId: pendingApprovalId,
        decision: parsed.command === 'approve' ? 'approve' : 'deny'
      });
      return {
        type: 'approval_resolved',
        approval,
        message: parsed.command === 'approve' ? 'Approved.' : 'Denied.'
      };
    }

    if (resolvedSessionId && pendingQuestionId) {
      const question = await this.answerQuestion({
        sessionId: resolvedSessionId,
        questionId: pendingQuestionId,
        answer: text
      });
      return {
        type: 'question_answered',
        question
      };
    }

    if (!parsed?.command && taskRoute.kind === 'needs_clarification') {
      return buildTaskClarificationResponse(taskRoute.activeTasks);
    }

    if (!parsed?.command && isNaturalLanguageStatusIntent(text)) {
      return buildSupervisorStatusResponse(conversation, resolvedSession || activeSession || null);
    }

    if (!parsed?.command && routedTaskId && resolvedSessionId && isNaturalLanguageTaskContinueIntent(text)) {
      if (isSessionBusy(resolvedSession)) {
        return buildBusyResponse(resolvedSession, conversation);
      }
      const session = await this.continueRuntimeTask({
        taskId: routedTaskId,
        sessionId: resolvedSessionId,
        input: text
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    if (resolvedSessionId) {
      if (isSessionBusy(resolvedSession)) {
        return buildBusyResponse(resolvedSession, conversation);
      }
      const session = await this.continueRuntimeTask({
        taskId: routedTaskId || '',
        sessionId: resolvedSessionId,
        input: text
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    const session = await this.startRuntimeTask({
      provider: preferredProvider,
      input: text,
      cwd,
      model,
      metadata
    });

    if (shouldStartFreshFromRememberedContext(supervisorBrief)) {
      return {
        type: 'runtime_started',
        provider: preferredProvider,
        session,
        startedFresh: true,
        message: buildRememberedContextMessage(supervisorBrief),
        supervisorContext: buildRememberedSupervisorContext(supervisorBrief)
      };
    }

    return {
      type: 'runtime_started',
      provider: preferredProvider,
      session
    };
  }
}

export const agentOrchestratorMessageService = new AgentOrchestratorMessageService();

export default agentOrchestratorMessageService;
