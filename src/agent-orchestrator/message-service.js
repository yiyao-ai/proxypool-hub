import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentRuntimeApprovalPolicyStore from '../agent-runtime/approval-policy-store.js';
import agentPreferenceStore from '../agent-core/preference-store.js';
import { buildPreferenceSavedMessage, saveConversationPreferences } from '../agent-core/preference-service.js';
import { selectRuntimeProvider } from '../agent-core/provider-selection.js';
import { AGENT_SESSION_STATUS } from '../agent-runtime/models.js';
import { buildApprovalSessionPolicy } from '../agent-runtime/approval-policy.js';
import { buildSupervisorBrief } from './supervisor-brief.js';

function withDefaultRuntimeOptions(provider, metadata = {}) {
  const next = { ...(metadata || {}) };
  const runtimeOptions = { ...(next.runtimeOptions || {}) };

  if (provider === 'codex' && String(next.cwd || '').trim()) {
    runtimeOptions.codex = {
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ...(runtimeOptions.codex || {})
    };
  }

  if (Object.keys(runtimeOptions).length > 0) {
    next.runtimeOptions = runtimeOptions;
  }

  return next;
}

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
  return String(session?.provider || brief?.provider || defaultRuntimeProvider || 'codex');
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
  const current = session || {};
  const brief = getSupervisorBrief(conversation, session);
  const intro = brief?.title
    ? `${brief.providerLabel || providerLabel(current.provider || brief.provider)} is still busy with "${brief.title}".`
    : `I am still working on the current task with ${providerLabel(current.provider)}.`;

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
    preferenceStore = agentPreferenceStore
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.approvalPolicyStore = approvalPolicyStore;
    this.preferenceStore = preferenceStore;
  }

  async startRuntimeTask({ provider, input, cwd, model = '', metadata = {} } = {}) {
    return this.runtimeSessionManager.createSession({
      provider,
      input,
      cwd,
      model,
      metadata: withDefaultRuntimeOptions(provider, {
        ...(metadata || {}),
        cwd
      })
    });
  }

  async continueRuntimeTask({ sessionId, input } = {}) {
    return this.runtimeSessionManager.sendInput(String(sessionId || ''), input);
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
    const activeSessionId = conversation?.activeRuntimeSessionId || null;
    const pendingApprovalId = conversation?.lastPendingApprovalId || null;
    const pendingQuestionId = conversation?.lastPendingQuestionId || null;
    const activeSession = activeSessionId ? this.getRuntimeSession(activeSessionId) : null;
    const supervisorBrief = getSupervisorBrief(conversation, activeSession);
    const preferredProvider = selectRuntimeProvider({
      conversation,
      activeSession,
      rememberedBrief: supervisorBrief,
      defaultRuntimeProvider: getPreferredConversationProvider(conversation, activeSession, defaultRuntimeProvider),
      preferenceStore: this.preferenceStore
    });

    if (!parsed?.command && !activeSessionId && conversation?.id && isPreferenceMemoryIntent(text)) {
      const savedPreferences = saveConversationPreferences(conversation, text, {
        store: this.preferenceStore
      });
      const savedMessage = buildPreferenceSavedMessage(savedPreferences);
      if (savedMessage) {
        return {
          type: 'preference_saved',
          message: savedMessage
        };
      }
    }

    if (activeSessionId && pendingApprovalId && !parsed?.command) {
      const approval = this.runtimeSessionManager.approvalService.getApproval(activeSessionId, pendingApprovalId);
      if (approval && approval.status === 'pending') {
        if (isApprovalAffirmative(text) || isApprovalNegative(text)) {
          let policy = null;
          if (isApprovalAffirmative(text) && wantsRememberedApproval(text)) {
            const policyDraft = buildApprovalSessionPolicy(approval);
            if (policyDraft) {
              const scope = wantsConversationRememberedApproval(text) && conversation?.id
                ? 'conversation'
                : 'session';
              const scopeRef = scope === 'conversation' ? conversation.id : activeSessionId;
              policy = this.approvalPolicyStore.createPolicy({
                ...policyDraft,
                scope,
                scopeRef,
                metadata: {
                  ...(policyDraft.metadata || {}),
                  sourceText: text
                }
              });
            }
          }

          const resolved = await this.resolveApproval({
            sessionId: activeSessionId,
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
        activeSessionId
          ? 'Detached the active runtime session from this conversation.'
          : 'No active runtime session is attached to this conversation.',
        activeSessionId
      );
    }

    if (parsed?.command === 'continue') {
      if (!activeSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to continue'
        };
      }
      const activeSession = this.getRuntimeSession(activeSessionId);
      if (isSessionBusy(activeSession)) {
        return buildBusyResponse(activeSession);
      }
      const session = await this.continueRuntimeTask({
        sessionId: activeSessionId,
        input: parsed.args || text
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    if (parsed?.command === 'cancel') {
      if (!activeSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to cancel'
        };
      }
      return {
        type: 'runtime_cancelled',
        session: this.cancelRuntimeSession({ sessionId: activeSessionId })
      };
    }

    if (parsed?.command === 'status') {
      if (!activeSessionId) {
        return buildSupervisorStatusResponse(conversation, null);
      }
      return {
        type: 'runtime_status',
        session: activeSession
      };
    }

    if (parsed?.command === 'approve' || parsed?.command === 'deny') {
      if (!activeSessionId || !pendingApprovalId) {
        return {
          type: 'command_error',
          message: 'No pending approval request'
        };
      }
      const approval = await this.resolveApproval({
        sessionId: activeSessionId,
        approvalId: pendingApprovalId,
        decision: parsed.command === 'approve' ? 'approve' : 'deny'
      });
      return {
        type: 'approval_resolved',
        approval,
        message: parsed.command === 'approve' ? 'Approved.' : 'Denied.'
      };
    }

    if (activeSessionId && pendingQuestionId) {
      const question = await this.answerQuestion({
        sessionId: activeSessionId,
        questionId: pendingQuestionId,
        answer: text
      });
      return {
        type: 'question_answered',
        question
      };
    }

    if (activeSessionId) {
      if (isSessionBusy(activeSession)) {
        return buildBusyResponse(activeSession, conversation);
      }
      const session = await this.continueRuntimeTask({
        sessionId: activeSessionId,
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
