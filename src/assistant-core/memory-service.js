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

function normalizeText(value) {
  return String(value || '').trim();
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
    preferenceStore = agentPreferenceStore
  } = {}) {
    this.preferenceStore = preferenceStore;
  }

  buildScopeRefs(context = {}) {
    return buildScopeRefs(context);
  }

  buildScopeCandidates(context = {}) {
    return buildScopeCandidates(context);
  }

  listMemory({ scope, scopeRef } = {}, { store = this.preferenceStore } = {}) {
    return store.listPreferences({
      scope: normalizeScope(scope),
      scopeRef: normalizeText(scopeRef)
    });
  }

  resolvePreferences(context = {}, { store = this.preferenceStore } = {}) {
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
      layers
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
}

export const assistantMemoryService = new AssistantMemoryService();

export default assistantMemoryService;
