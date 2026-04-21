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

function isStatusInquiry(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(进展|状态|结果|完成了吗|做到哪|现在到哪|现在怎么样|汇报一下|目前如何|什么情况|status|progress|update|done\??|result)/i.test(text);
}

function isWrapUpInquiry(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(总结一下|总结下|收尾|收个尾|整理一下|整理下|归纳一下|列一下结果|给我结果|给我总结|总结当前产出|wrap up|summarize|summary|recap|final status)/i.test(text);
}

function hasExecutionIntent(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return false;

  // When a message mixes status wording with explicit implementation/debugging asks,
  // prefer forwarding it to the active runtime instead of answering locally.
  const directTaskPattern = /(请重新查看代码|重新查看代码|查看代码|检查代码|重新检查|请进行修复|进行修复|继续修复|帮我修复|请修复|修一下|改一下|修改代码|实现一下|排查一下|定位一下|处理一下|提交并推送|提交代码|推送到git|fix|debug|investigate|inspect the code|check the code|review the code|modify the code|implement the fix)/i;
  if (directTaskPattern.test(text)) {
    return true;
  }

  const requestCuePattern = /^(请|帮我|麻烦|继续|重新|再|并|然后|直接|先)\b/i;
  const actionVerbPattern = /(查看|检查|修复|修改|实现|排查|定位|处理|提交|推送|完善|优化|重构|新增|删除|更新|fix|debug|investigate|inspect|review|modify|implement|update)/i;
  return requestCuePattern.test(text) && actionVerbPattern.test(text);
}

function detectProviderSwitchIntent(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  if (/(切到|改用|换成|使用|用)\s*claude\s*code/i.test(text) || /(切到|改用|换成|使用|用)\s*claude/i.test(text)) {
    return 'claude-code';
  }
  if (/(切到|改用|换成|使用|用)\s*codex/i.test(text)) {
    return 'codex';
  }
  if (/^(use|switch to)\s+claude(?:\s*code)?/i.test(text)) {
    return 'claude-code';
  }
  if (/^(use|switch to)\s+codex/i.test(text)) {
    return 'codex';
  }
  return null;
}

function isPreferenceMemoryIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return /(记住|以后|后续|默认|总是|prefer|always|default)/i.test(text)
    && /(中文|英文|claude|codex|简洁|详细|最小改动|concise|detailed|minimal)/i.test(text);
}

function parseSupervisorStartIntent(input, defaultProvider = 'codex') {
  const text = String(input || '').trim();
  if (!text) return null;

  const patterns = [
    /^(开始新任务|新任务|重新开始|新开一个任务|新建任务)\s*[:：]?\s*(.+)$/i,
    /^(另外再做一个|另外做一个|单独做一个|另起一个|再开一个新任务)\s*[:：]?\s*(.+)$/i,
    /^(start a new task|new task|start over)\s*[:：]?\s*(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        provider: defaultProvider,
        input: String(match[2] || '').trim()
      };
    }
  }

  return null;
}

function parseSupervisorRelatedTaskIntent(input, defaultProvider = 'codex') {
  const text = String(input || '').trim();
  if (!text) return null;

  const patterns = [
    /^(基于刚才那个再做一个|基于刚才的结果再做一个|在刚才那个基础上再做一个|基于上一个结果再做一个)\s*[:：]?\s*(.+)$/i,
    /^(based on (?:that|the previous result),?\s*(?:also )?(?:make|create|do) another)\s*[:：]?\s*(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        provider: defaultProvider,
        input: String(match[2] || '').trim()
      };
    }
  }

  return null;
}

function detectTaskRevisionIntent(input) {
  const text = String(input || '').trim();
  if (!text) return null;

  const patterns = [
    /^(再加一个|顺便加上|顺便补一个|另外补一个|把.+改成|改成.+|补一个)\s*(.+)?$/i,
    /^(also add|add another|update it to|change it to|modify it to)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      return text;
    }
  }

  return null;
}

function parseSupervisorContinuationIntent(input, defaultProvider = 'codex') {
  const text = String(input || '').trim();
  if (!text) return null;

  const patterns = [
    /^(继续刚才那个|接着刚才那个|按刚才那个继续|延续刚才那个|在刚才那个基础上继续|在这个基础上继续)\s*[:：]?\s*(.+)$/i,
    /^(continue the previous task|continue from the previous task|carry on from that)\s*[:：]?\s*(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        provider: defaultProvider,
        input: String(match[2] || '').trim()
      };
    }
  }

  return null;
}

function detectRetryIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return /^(重试刚才那个|再试一次|重来一次|retry(?: that| the previous task)?|try again)$/i.test(text);
}

function detectReturnToSourceIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return /^(回到上一个任务|回到刚才那个任务|返回上一个任务|返回刚才那个任务|go back to the previous task|return to the previous task)$/i.test(text);
}

function buildRememberedFollowUpInput(brief, input) {
  const summary = String(brief?.summary || brief?.result || brief?.error || '').trim();
  const lines = [
    'Continue from the remembered conversation context below.',
    brief?.title ? `Previous task: ${brief.title}` : null,
    brief?.providerLabel ? `Previous provider: ${brief.providerLabel}` : null,
    brief?.status ? `Previous status: ${brief.status}` : null,
    summary ? `Previous summary: ${summary}` : null,
    `Follow-up request: ${String(input || '').trim()}`
  ].filter(Boolean);
  return lines.join('\n');
}

function buildRetryTaskInput(brief) {
  const summary = String(brief?.summary || brief?.result || '').trim();
  const error = String(brief?.error || '').trim();
  return [
    'Retry the previous task using the same provider.',
    brief?.title ? `Previous task: ${brief.title}` : null,
    brief?.status ? `Previous status: ${brief.status}` : null,
    error ? `Previous error: ${error}` : null,
    summary ? `Previous summary: ${summary}` : null,
    'Retry the task and continue from the latest known context if possible.'
  ].filter(Boolean).join('\n');
}

function buildReturnToSourceInput(brief) {
  return [
    'Return to the earlier remembered source task.',
    brief?.sourceTitle ? `Source task: ${brief.sourceTitle}` : null,
    brief?.sourceStatus ? `Source status: ${brief.sourceStatus}` : null,
    brief?.title ? `Most recent derived task: ${brief.title}` : null,
    brief?.error ? `Recent failure: ${brief.error}` : null,
    'Continue with the earlier source task and treat the failed derived task as context only.'
  ].filter(Boolean).join('\n');
}

function buildSupervisorContext({
  kind,
  brief = null,
  title = '',
  input = ''
} = {}) {
  const cleanTitle = String(title || input || '').trim();
  const base = {
    kind: String(kind || '').trim() || 'direct',
    title: cleanTitle,
    sourceTitle: String(brief?.title || '').trim(),
    sourceProvider: String(brief?.provider || '').trim(),
    sourceStatus: String(brief?.status || '').trim()
  };

  if (!brief || brief.kind === 'empty') {
    return {
      ...base,
      summary: ''
    };
  }

  if (base.kind === 'related_sibling') {
    return {
      ...base,
      summary: `Started from remembered task "${base.sourceTitle}" as a related sibling task.`
    };
  }

  if (base.kind === 'remembered_follow_up') {
    return {
      ...base,
      summary: `Continuing from remembered task "${base.sourceTitle}" with a follow-up request.`
    };
  }

  if (base.kind === 'retry_task') {
    return {
      ...base,
      summary: `Retrying remembered task "${base.sourceTitle || base.title}".`
    };
  }

  if (base.kind === 'return_to_source') {
    return {
      ...base,
      summary: `Returning to remembered source task "${base.sourceTitle}".`
    };
  }

  return {
    ...base,
    summary: ''
  };
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

function buildSupervisorWrapUpResponse(conversation, session = null) {
  const brief = getSupervisorBrief(conversation, session);

  if (brief.kind !== 'empty') {
    return {
      type: 'supervisor_status',
      message: [
        `${brief.kind === 'current' ? 'Current task summary' : 'Task summary'}: ${brief.title || 'Untitled task'}`,
        `Provider: ${brief.providerLabel || providerLabel(brief.provider)}`,
        `Status: ${brief.status || 'unknown'}`,
        brief.summary ? `What is done: ${brief.summary}` : null,
        brief.result ? `Output: ${String(brief.result).slice(0, 400)}` : null,
        brief.error ? `Failure reason: ${brief.error}` : null,
        brief.waitingReason ? `Blocked on: ${brief.waitingReason}` : null,
        brief.nextSuggestion ? `Suggested next step: ${brief.nextSuggestion}` : null
      ].filter(Boolean).join('\n')
    };
  }

  return {
    type: 'command_error',
    message: 'There is no remembered task summary for this conversation yet.'
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
      defaultRuntimeProvider: getPreferredConversationProvider(conversation, activeSession, defaultRuntimeProvider)
    });
    const inferredProviderSwitch = !parsed?.command ? detectProviderSwitchIntent(text) : null;
    const inferredFreshTask = !parsed?.command ? parseSupervisorStartIntent(text, preferredProvider) : null;
    const inferredRelatedTask = !parsed?.command ? parseSupervisorRelatedTaskIntent(text, preferredProvider) : null;
    const inferredContinuation = !parsed?.command ? parseSupervisorContinuationIntent(text, preferredProvider) : null;
    const inferredRevision = !parsed?.command ? detectTaskRevisionIntent(text) : null;
    const inferredRetry = !parsed?.command ? detectRetryIntent(text) : false;
    const inferredReturnToSource = !parsed?.command ? detectReturnToSourceIntent(text) : false;
    const inferredExecutionIntent = !parsed?.command ? hasExecutionIntent(text) : false;

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

    if (!parsed?.command && !inferredExecutionIntent && isWrapUpInquiry(text)) {
      return buildSupervisorWrapUpResponse(conversation, activeSession);
    }

    if (!parsed?.command && !inferredExecutionIntent && isStatusInquiry(text)) {
      return buildSupervisorStatusResponse(conversation, activeSession);
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

    if (inferredProviderSwitch) {
      return {
        type: 'command_error',
        message: `To switch this conversation to ${providerLabel(inferredProviderSwitch)}, send /new ${inferredProviderSwitch === 'codex' ? 'cx' : 'cc'} <task>.`
      };
    }

    if (inferredFreshTask) {
      const session = await this.startRuntimeTask({
        provider: inferredFreshTask.provider,
        input: inferredFreshTask.input,
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider: inferredFreshTask.provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId,
        message: 'Started a fresh task from your new-task request.',
        supervisorContext: buildSupervisorContext({
          kind: 'fresh_task',
          title: inferredFreshTask.input
        })
      };
    }

    if (inferredRelatedTask) {
      const session = await this.startRuntimeTask({
        provider: inferredRelatedTask.provider,
        input: activeSessionId || supervisorBrief.kind === 'empty'
          ? inferredRelatedTask.input
          : buildRememberedFollowUpInput(supervisorBrief, inferredRelatedTask.input),
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider: inferredRelatedTask.provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId,
        message: 'Started a related sibling task based on your previous result.',
        supervisorContext: buildSupervisorContext({
          kind: 'related_sibling',
          brief: supervisorBrief,
          title: inferredRelatedTask.input
        })
      };
    }

    if (!activeSessionId && supervisorBrief.kind !== 'empty' && inferredRetry && supervisorBrief.status === 'failed') {
      const session = await this.startRuntimeTask({
        provider: preferredProvider,
        input: buildRetryTaskInput(supervisorBrief),
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider: preferredProvider,
        session,
        startedFresh: true,
        message: 'Started a retry from the remembered failed task.',
        supervisorContext: buildSupervisorContext({
          kind: 'retry_task',
          brief: supervisorBrief,
          title: supervisorBrief.title || text
        })
      };
    }

    if (!activeSessionId && supervisorBrief.kind !== 'empty' && inferredReturnToSource && supervisorBrief.sourceTitle) {
      const provider = supervisorBrief.sourceProvider || preferredProvider;
      const session = await this.startRuntimeTask({
        provider,
        input: buildReturnToSourceInput(supervisorBrief),
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider,
        session,
        startedFresh: true,
        message: 'Returned to the remembered source task.',
        supervisorContext: buildSupervisorContext({
          kind: 'return_to_source',
          brief: supervisorBrief,
          title: supervisorBrief.sourceTitle
        })
      };
    }

    if (!activeSessionId && supervisorBrief.kind !== 'empty' && (inferredContinuation || inferredRevision)) {
      const followUpTitle = inferredContinuation?.input || text;
      const session = await this.startRuntimeTask({
        provider: preferredProvider,
        input: buildRememberedFollowUpInput(
          supervisorBrief,
          followUpTitle
        ),
        cwd,
        model,
        metadata
      });

      return {
        type: 'runtime_started',
        provider: preferredProvider,
        session,
        startedFresh: true,
        message: 'Started a follow-up task from the remembered conversation context.',
        supervisorContext: buildSupervisorContext({
          kind: 'remembered_follow_up',
          brief: supervisorBrief,
          title: followUpTitle
        })
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
        session,
        message: inferredRevision
          ? 'I am treating this as an update to the current task and passing it to the active runtime.'
          : undefined
      };
    }

    const session = await this.startRuntimeTask({
      provider: preferredProvider,
      input: text,
      cwd,
      model,
      metadata
    });

    return {
      type: 'runtime_started',
      provider: preferredProvider,
      session
    };
  }
}

export const agentOrchestratorMessageService = new AgentOrchestratorMessageService();

export default agentOrchestratorMessageService;
