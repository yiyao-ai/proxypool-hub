import agentRuntimeApprovalPolicyStore from '../agent-runtime/approval-policy-store.js';
import {
  buildApprovalSessionPolicy,
  approvalPolicyMatchesRequest
} from '../agent-runtime/approval-policy.js';
import {
  buildScopeRefs,
  buildScopeCandidates,
  normalizeScope
} from './scope-resolver.js';

function normalizeText(value) {
  return String(value || '').trim();
}

export class AssistantPolicyService {
  constructor({
    approvalPolicyStore = agentRuntimeApprovalPolicyStore
  } = {}) {
    this.approvalPolicyStore = approvalPolicyStore;
  }

  buildScopeRefs(context = {}) {
    return buildScopeRefs(context);
  }

  buildScopeCandidates(context = {}) {
    return buildScopeCandidates(context);
  }

  listPolicies({ scope, scopeRef } = {}) {
    const normalizedScope = normalizeScope(scope);
    const normalizedScopeRef = normalizeText(scopeRef);
    const records = this.approvalPolicyStore.listPolicies({
      scope: normalizedScope,
      scopeRef: normalizedScopeRef
    });

    if (normalizedScope !== 'runtime_session') {
      return records;
    }

    const legacy = this.approvalPolicyStore.listPolicies({
      scope: 'session',
      scopeRef: normalizedScopeRef
    });
    return [...records, ...legacy];
  }

  createApprovalPolicy({
    scope = 'runtime_session',
    scopeRef,
    provider,
    toolName,
    decision = 'allow',
    pathPatterns = [],
    commandPrefixes = [],
    metadata = {}
  } = {}) {
    return this.approvalPolicyStore.createPolicy({
      scope: normalizeScope(scope) || 'runtime_session',
      scopeRef: normalizeText(scopeRef),
      provider,
      toolName,
      decision,
      pathPatterns,
      commandPrefixes,
      metadata
    });
  }

  rememberApproval({
    approval,
    scope = 'runtime_session',
    scopeRef,
    options = {}
  } = {}) {
    const draft = buildApprovalSessionPolicy(approval, options);
    if (!draft || !scopeRef) {
      return null;
    }
    return this.createApprovalPolicy({
      scope,
      scopeRef,
      provider: draft.provider,
      toolName: draft.toolName,
      decision: draft.decision,
      pathPatterns: draft.pathPatterns,
      commandPrefixes: draft.commandPrefixes,
      metadata: draft.metadata
    });
  }

  findAutoApprovalPolicy({
    conversation = null,
    runtimeSession = null,
    cwd = '',
    metadata = {},
    provider = '',
    rawRequest = {}
  } = {}) {
    const candidates = this.buildScopeCandidates({
      conversation,
      runtimeSession,
      cwd,
      metadata
    });

    for (const candidate of candidates) {
      const scopesToCheck = candidate.scope === 'runtime_session'
        ? ['runtime_session', 'session']
        : [candidate.scope];

      for (const scope of scopesToCheck) {
        const records = this.approvalPolicyStore.listPolicies({
          scope,
          scopeRef: candidate.scopeRef
        });
        const match = records.find((entry) => (
          (!provider || !entry.provider || entry.provider === provider)
          && approvalPolicyMatchesRequest(entry, rawRequest)
        )) || null;
        if (match) {
          return match;
        }
      }
    }

    return null;
  }

  canAutoApproveAssistantAction({ conversation = null, cwd = '', metadata = {} } = {}) {
    const refs = this.buildScopeRefs({ conversation, cwd, metadata });
    return Boolean(refs.conversation || refs.workspace);
  }

  canExecuteToolCall({
    toolName = '',
    conversation = null,
    runtimeSession = null,
    cwd = '',
    metadata = {},
    input = {}
  } = {}) {
    const normalizedTool = normalizeText(toolName);
    if (!normalizedTool) {
      return {
        allowed: false,
        reason: 'tool_name_required'
      };
    }

    const safeTools = new Set([
      'get_workspace_context',
      'list_runtime_sessions',
      'get_runtime_session',
      'list_conversations',
      'get_conversation_context',
      'summarize_runtime_result',
      'list_tasks',
      'get_task',
      'list_project_artifacts',
      'search_project_memory'
    ]);
    if (safeTools.has(normalizedTool)) {
      return {
        allowed: true,
        reason: 'safe_read_only_tool'
      };
    }

    if (normalizedTool === 'reset_conversation_binding') {
      return {
        allowed: Boolean(conversation?.id || input.conversationId),
        reason: conversation?.id || input.conversationId ? 'conversation_scope_available' : 'conversation_scope_required'
      };
    }

    if (['delegate_to_codex', 'delegate_to_claude_code', 'delegate_to_runtime', 'start_runtime_task', 'reuse_or_delegate'].includes(normalizedTool)) {
      return {
        allowed: Boolean(this.canAutoApproveAssistantAction({ conversation, cwd, metadata })),
        reason: 'assistant_delegation_within_scope'
      };
    }

    if (['send_runtime_input', 'cancel_runtime_session', 'resolve_runtime_approval', 'answer_runtime_question'].includes(normalizedTool)) {
      return {
        allowed: Boolean(runtimeSession?.id || input.sessionId),
        reason: runtimeSession?.id || input.sessionId ? 'runtime_scope_available' : 'runtime_scope_required'
      };
    }

    return {
      allowed: false,
      reason: 'tool_not_permitted_by_policy'
    };
  }
}

export const assistantPolicyService = new AssistantPolicyService();

export default assistantPolicyService;
