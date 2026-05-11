import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import assistantPolicyService, { AssistantPolicyService } from './policy-service.js';

function normalizeText(value) {
  return String(value || '').trim();
}

function detectApprovalRememberPreference(conversation = null) {
  const deliveries = Array.isArray(conversation?.metadata?.uiChatMessages)
    ? conversation.metadata.uiChatMessages
    : [];
  const textPool = [
    conversation?.metadata?.assistantCore?.lastUserMessage || '',
    ...deliveries.slice(-8).map((entry) => entry?.content || entry?.text || '')
  ].map((entry) => normalizeText(entry).toLowerCase()).filter(Boolean);

  const combined = textPool.join('\n');
  if (!combined) return 'none';
  if (/(这个对话|这次对话|当前对话|this conversation|this chat)/i.test(combined)) {
    return 'conversation';
  }
  if (/(以后|后续|别再问|都允许|全部允许|from now on|don'?t ask again|remember)/i.test(combined)) {
    return 'runtime_session';
  }
  return 'none';
}

function resolveConversationScopeRef(conversation = null, runtimeSession = null) {
  return normalizeText(conversation?.id || runtimeSession?.metadata?.conversationId || '');
}

function resolveRuntimeScopeRef(runtimeSession = null) {
  return normalizeText(runtimeSession?.id);
}

export class AssistantApprovalGovernor {
  constructor({
    messageService = agentOrchestratorMessageService,
    policyService = assistantPolicyService
  } = {}) {
    this.messageService = messageService;
    this.policyService = policyService instanceof AssistantPolicyService
      ? policyService
      : policyService;
  }

  resolveAutoDecision({ conversation = null, runtimeSession = null, approval = null } = {}) {
    if (!runtimeSession?.id || !approval?.approvalId) {
      return {
        action: 'ask_user',
        reason: 'approval_context_missing',
        policy: null,
        remember: 'none'
      };
    }

    const match = this.policyService.findAutoApprovalPolicy({
      conversation,
      runtimeSession,
      cwd: runtimeSession?.cwd || '',
      metadata: runtimeSession?.metadata || {},
      provider: approval?.provider || runtimeSession?.provider || '',
      rawRequest: approval?.rawRequest || {}
    });

    if (!match) {
      return {
        action: 'ask_user',
        reason: 'no_matching_approval_policy',
        policy: null,
        remember: 'none'
      };
    }

    return {
      action: match.decision === 'deny' ? 'deny' : 'approve',
      reason: 'matched_saved_approval_policy',
      policy: match,
      remember: 'none'
    };
  }

  async governApproval({ conversation = null, runtimeSession = null, approval = null } = {}) {
    const decision = this.resolveAutoDecision({ conversation, runtimeSession, approval });
    if (decision.action === 'ask_user') {
      return decision;
    }

    const rememberPreference = detectApprovalRememberPreference(conversation);
    const resolved = await this.messageService.resolveApproval({
      sessionId: runtimeSession.id,
      approvalId: approval.approvalId,
      decision: decision.action,
      remember: decision.action === 'approve'
        ? (rememberPreference === 'conversation' ? 'conversation' : 'none')
        : 'none',
      conversationId: resolveConversationScopeRef(conversation, runtimeSession)
    });

    return {
      ...decision,
      resolvedApproval: resolved,
      remember: rememberPreference === 'conversation' ? 'conversation' : 'none'
    };
  }

  rememberApprovalPreference({
    conversation = null,
    runtimeSession = null,
    approval = null,
    scope = 'runtime_session'
  } = {}) {
    const normalizedScope = String(scope || 'runtime_session').trim() || 'runtime_session';
    const scopeRef = normalizedScope === 'conversation'
      ? resolveConversationScopeRef(conversation, runtimeSession)
      : resolveRuntimeScopeRef(runtimeSession);
    if (!scopeRef) return null;

    return this.policyService.rememberApproval({
      approval,
      scope: normalizedScope,
      scopeRef
    });
  }
}

export const assistantApprovalGovernor = new AssistantApprovalGovernor();

export default assistantApprovalGovernor;
