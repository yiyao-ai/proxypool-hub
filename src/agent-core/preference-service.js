import agentPreferenceStore from './preference-store.js';

function normalizeText(value) {
  return String(value || '').trim();
}

function detectReplyLanguage(text) {
  if (/(默认|以后|后续|记住).*(中文|汉语)/i.test(text) || /always.*chinese/i.test(text)) {
    return 'zh-CN';
  }
  if (/(默认|以后|后续|记住).*(英文|英语)/i.test(text) || /always.*english/i.test(text)) {
    return 'en';
  }
  return '';
}

function detectResponseStyle(text) {
  if (/(默认|以后|后续|记住).*(简洁|精简|简短)/i.test(text) || /keep.*concise|be concise|shorter replies/i.test(text)) {
    return 'concise';
  }
  if (/(默认|以后|后续|记住).*(详细|展开|具体一点)/i.test(text) || /be detailed|more detail|longer replies/i.test(text)) {
    return 'detailed';
  }
  return '';
}

function detectPreferredProvider(text) {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  if (/(前端|ui|界面).*(claude|claude code)/i.test(normalized) || /(默认|以后|后续|记住).*(claude|claude code)/i.test(normalized)) {
    return 'claude-code';
  }
  if (/(命令行|终端|排查|调试|后端).*(codex)/i.test(normalized) || /(默认|以后|后续|记住).*(codex)/i.test(normalized)) {
    return 'codex';
  }
  return '';
}

function detectExecutionStyle(text) {
  const normalized = normalizeText(text);
  if (!normalized) return '';
  if (/(默认|以后|后续|记住).*(最小改动|少改|尽量少改)/i.test(normalized) || /minimal changes|minimal diff|smallest change/i.test(normalized)) {
    return 'minimal-change';
  }
  return '';
}

export function extractPreferencesFromText(text) {
  const source = normalizeText(text);
  if (!source) return [];

  const entries = [];
  const language = detectReplyLanguage(source);
  if (language) {
    entries.push({ key: 'reply_language', value: language });
  }

  const responseStyle = detectResponseStyle(source);
  if (responseStyle) {
    entries.push({ key: 'response_style', value: responseStyle });
  }

  const preferredProvider = detectPreferredProvider(source);
  if (preferredProvider) {
    entries.push({ key: 'preferred_runtime_provider', value: preferredProvider });
  }

  const executionStyle = detectExecutionStyle(source);
  if (executionStyle) {
    entries.push({ key: 'execution_style', value: executionStyle });
  }

  return entries;
}

export function saveScopedPreferences({ scope = 'conversation', scopeRef, text }, {
  store = agentPreferenceStore
} = {}) {
  const normalizedScopeRef = String(scopeRef || '').trim();
  if (!normalizedScopeRef) {
    return [];
  }

  const entries = extractPreferencesFromText(text);
  return entries.map((entry) => store.upsertPreference({
    scope,
    scopeRef: normalizedScopeRef,
    key: entry.key,
    value: entry.value,
    metadata: {
      sourceText: normalizeText(text),
      source: 'explicit_user'
    }
  }));
}

export function resolveScopedPreferences({ scope = 'conversation', scopeRef }, {
  store = agentPreferenceStore
} = {}) {
  const normalizedScopeRef = String(scopeRef || '').trim();
  if (!normalizedScopeRef) {
    return {};
  }

  const records = store.listPreferences({
    scope,
    scopeRef: normalizedScopeRef
  });

  return records.reduce((acc, entry) => {
    acc[entry.key] = entry.value;
    return acc;
  }, {});
}

export function saveConversationPreferences(conversation, text, options = {}) {
  return saveScopedPreferences({
    scope: 'conversation',
    scopeRef: conversation?.id,
    text
  }, options);
}

export function resolveConversationPreferences(conversation, options = {}) {
  return resolveScopedPreferences({
    scope: 'conversation',
    scopeRef: conversation?.id
  }, options);
}

export function buildPreferenceSavedMessage(saved = []) {
  if (!Array.isArray(saved) || saved.length === 0) {
    return '';
  }

  const labels = saved.map((entry) => {
    if (entry.key === 'reply_language') {
      return entry.value === 'zh-CN' ? 'reply in Chinese' : 'reply in English';
    }
    if (entry.key === 'response_style') {
      return entry.value === 'concise' ? 'keep replies concise' : 'give more detailed replies';
    }
    if (entry.key === 'preferred_runtime_provider') {
      return entry.value === 'claude-code' ? 'prefer Claude Code' : 'prefer Codex';
    }
    if (entry.key === 'execution_style') {
      return 'prefer minimal changes';
    }
    return `${entry.key}=${entry.value}`;
  });

  return `Preference saved: ${labels.join(', ')}.`;
}

export default {
  extractPreferencesFromText,
  saveScopedPreferences,
  resolveScopedPreferences,
  saveConversationPreferences,
  resolveConversationPreferences,
  buildPreferenceSavedMessage
};
