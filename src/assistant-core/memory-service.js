import agentPreferenceStore from '../agent-core/preference-store.js';
import {
  extractPreferencesFromText,
  buildPreferenceSavedMessage
} from '../agent-core/preference-service.js';
import {
  buildScopeRefs,
  buildScopeCandidates,
  normalizeScope
} from './scope-resolver.js';
import assistantWorkspaceStore from './workspace-store.js';
import assistantRuntimeSessionMemoryStore from './runtime-session-memory-store.js';
import assistantPolicyService from './policy-service.js';

function normalizeText(value) {
  return String(value || '').trim();
}

function buildUserProfile(values = {}) {
  const profile = {
    replyLanguage: normalizeText(values.reply_language),
    responseStyle: normalizeText(values.response_style),
    preferredRuntimeProvider: normalizeText(values.preferred_runtime_provider),
    executionStyle: normalizeText(values.execution_style)
  };
  if (!profile.replyLanguage && !profile.responseStyle && !profile.preferredRuntimeProvider && !profile.executionStyle) {
    return null;
  }
  return profile;
}

function detectSaveScope(text, scopeRefs = {}) {
  const source = normalizeText(text).toLowerCase();
  if (!source) return { scope: 'conversation', scopeRef: scopeRefs.conversation || '' };

  if (/(以后都|总是|所有对话|全局|global|always|for all chats)/i.test(source)) {
    return { scope: 'global_user', scopeRef: scopeRefs.global_user || 'default-user' };
  }

  if (/(这个项目|当前项目|这个仓库|当前仓库|workspace|project|repo)/i.test(source)) {
    return { scope: 'workspace', scopeRef: scopeRefs.workspace || '' };
  }

  if (/(这个会话|当前会话|本次会话|runtime session|this runtime)/i.test(source)) {
    return { scope: 'runtime_session', scopeRef: scopeRefs.runtime_session || '' };
  }

  return { scope: 'conversation', scopeRef: scopeRefs.conversation || '' };
}

export class AssistantMemoryService {
  constructor({
    preferenceStore = agentPreferenceStore,
    workspaceStore = assistantWorkspaceStore,
    runtimeSessionMemoryStore = assistantRuntimeSessionMemoryStore,
    policyService = assistantPolicyService
  } = {}) {
    this.preferenceStore = preferenceStore;
    this.workspaceStore = workspaceStore;
    this.runtimeSessionMemoryStore = runtimeSessionMemoryStore;
    this.policyService = policyService;
  }

  buildScopeRefs(context = {}) {
    return buildScopeRefs(context);
  }

  buildScopeCandidates(context = {}) {
    return buildScopeCandidates(context);
  }

  listMemory({ scope, scopeRef } = {}, { store = this.preferenceStore } = {}) {
    const normalizedScope = normalizeScope(scope);
    const normalizedScopeRef = normalizeText(scopeRef);
    const preferences = store.listPreferences({
      scope: normalizedScope,
      scopeRef: normalizedScopeRef
    });
    if (normalizedScope !== 'runtime_session') {
      return preferences;
    }
    const sessionEntries = this.listRuntimeSessionMemory({
      sessionId: normalizedScopeRef
    });
    return [
      ...preferences,
      ...sessionEntries.map((entry) => ({
        scope: 'runtime_session',
        scopeRef: normalizedScopeRef,
        key: entry.key,
        value: entry.value,
        kind: entry.kind,
        metadata: entry.metadata || {},
        updatedAt: entry.updatedAt || '',
        createdAt: entry.createdAt || ''
      }))
    ];
  }

  resolvePreferences(context = {}, { store = this.preferenceStore } = {}) {
    const workspaceRef = this.buildScopeRefs(context).workspace || '';
    if (workspaceRef) {
      this.workspaceStore.upsert({
        workspaceRef,
        patch: {
          metadata: {
            source: 'memory_resolve'
          }
        }
      });
    }

    const candidates = this.buildScopeCandidates(context);
    const layers = [];
    const merged = {};

    for (const candidate of [...candidates].reverse()) {
      const records = store.listPreferences({
        scope: candidate.scope,
        scopeRef: candidate.scopeRef
      });
      const values = records.reduce((acc, entry) => {
        acc[entry.key] = entry.value;
        return acc;
      }, {});
      layers.push({
        scope: candidate.scope,
        scopeRef: candidate.scopeRef,
        values
      });
      Object.assign(merged, values);
    }

    return {
      values: merged,
      layers,
      userProfile: buildUserProfile(merged)
    };
  }

  savePreferencesFromText({ text, conversation = null, runtimeSession = null, cwd = '', metadata = {} } = {}, { store = this.preferenceStore } = {}) {
    const entries = extractPreferencesFromText(text);
    if (entries.length === 0) {
      return [];
    }

    const scopeRefs = this.buildScopeRefs({ conversation, runtimeSession, cwd, metadata });
    const target = detectSaveScope(text, scopeRefs);
    if (!target.scopeRef) {
      return [];
    }

    if (target.scope === 'workspace') {
      this.workspaceStore.upsert({
        workspaceRef: target.scopeRef,
        patch: {
          metadata: {
            source: 'explicit_user_preference'
          }
        }
      });
    }

    return entries.map((entry) => store.upsertPreference({
      scope: target.scope,
      scopeRef: target.scopeRef,
      key: entry.key,
      value: entry.value,
      metadata: {
        sourceText: normalizeText(text),
        source: 'explicit_user',
        workspaceRef: scopeRefs.workspace || '',
        conversationId: scopeRefs.conversation || '',
        runtimeSessionId: scopeRefs.runtime_session || ''
      }
    }));
  }

  buildSavedMessage(saved = []) {
    return buildPreferenceSavedMessage(saved);
  }

  rememberRuntimeSessionState({
    runtimeSession = null,
    sessionId = '',
    detail = null,
    metadata = {}
  } = {}) {
    const normalizedSessionId = normalizeText(sessionId || runtimeSession?.id);
    if (!normalizedSessionId) {
      return [];
    }

    const session = detail?.session || runtimeSession || {};
    const turns = Array.isArray(detail?.turns) ? detail.turns : [];
    const pendingApprovals = Array.isArray(detail?.pendingApprovals) ? detail.pendingApprovals : [];
    const pendingQuestions = Array.isArray(detail?.pendingQuestions) ? detail.pendingQuestions : [];
    const records = [];

    const pushRecord = (kind, key, value, extra = {}) => {
      const saved = this.runtimeSessionMemoryStore.upsert({
        sessionId: normalizedSessionId,
        kind,
        key,
        value,
        metadata: {
          source: 'runtime_session_observation',
          ...metadata,
          ...extra
        }
      });
      if (saved) {
        records.push(saved);
      }
    };

    pushRecord('session', 'session:status', {
      status: normalizeText(session?.status),
      provider: normalizeText(session?.provider),
      title: normalizeText(session?.title),
      summary: normalizeText(session?.summary),
      error: normalizeText(session?.error),
      currentTurnId: normalizeText(runtimeSession?.currentTurnId || session?.currentTurnId),
      updatedAt: normalizeText(session?.updatedAt)
    });

    const latestTurn = turns[0] || detail?.session?.latestTurn || null;
    if (latestTurn?.id) {
      pushRecord('turn', 'turn:current', {
        turnId: latestTurn.id,
        status: normalizeText(latestTurn.status),
        input: normalizeText(latestTurn.input),
        summary: normalizeText(latestTurn.summary),
        error: normalizeText(latestTurn.error),
        stats: latestTurn.stats || {},
        startedAt: normalizeText(latestTurn.startedAt),
        completedAt: normalizeText(latestTurn.completedAt)
      }, {
        turnId: latestTurn.id
      });
    }

    pushRecord('turn', 'turn:list', turns.map((turn) => ({
      turnId: normalizeText(turn?.id),
      status: normalizeText(turn?.status),
      summary: normalizeText(turn?.summary),
      input: normalizeText(turn?.input),
      completedAt: normalizeText(turn?.completedAt),
      updatedAt: normalizeText(turn?.updatedAt)
    })));

    pushRecord('approval', 'approval:pending', pendingApprovals.map((entry) => ({
      approvalId: normalizeText(entry?.approvalId),
      turnId: normalizeText(entry?.turnId),
      title: normalizeText(entry?.title),
      summary: normalizeText(entry?.summary),
      createdAt: normalizeText(entry?.createdAt),
      rawRequest: entry?.rawRequest || null
    })));

    pushRecord('question', 'question:pending', pendingQuestions.map((entry) => ({
      questionId: normalizeText(entry?.questionId),
      turnId: normalizeText(entry?.turnId),
      text: normalizeText(entry?.text),
      options: Array.isArray(entry?.options) ? entry.options : [],
      createdAt: normalizeText(entry?.createdAt),
      rawRequest: entry?.rawRequest || null
    })));

    const rememberedPolicies = this.policyService?.listPolicies?.({
      scope: 'runtime_session',
      scopeRef: normalizedSessionId
    }) || [];
    pushRecord('authorization', 'authorization:remembered_policies', rememberedPolicies.map((entry) => ({
      policyId: normalizeText(entry?.id),
      scope: normalizeText(entry?.scope),
      scopeRef: normalizeText(entry?.scopeRef),
      provider: normalizeText(entry?.provider),
      toolName: normalizeText(entry?.toolName),
      decision: normalizeText(entry?.decision),
      pathPatterns: Array.isArray(entry?.pathPatterns) ? entry.pathPatterns : [],
      commandPrefixes: Array.isArray(entry?.commandPrefixes) ? entry.commandPrefixes : [],
      createdAt: normalizeText(entry?.createdAt),
      updatedAt: normalizeText(entry?.updatedAt),
      metadata: entry?.metadata || {}
    })));

    return records;
  }

  listRuntimeSessionMemory({ sessionId = '', kind = '', limit = 50 } = {}) {
    return this.runtimeSessionMemoryStore.listBySession(sessionId, {
      kind,
      limit
    });
  }
}

export const assistantMemoryService = new AssistantMemoryService();

export default assistantMemoryService;
