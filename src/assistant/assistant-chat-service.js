import agentPreferenceStore from '../agent-core/preference-store.js';
import { resolveManualLanguage } from './language-service.js';
import { detectAssistantIntent } from './intent-service.js';
import { getManualContext } from './manual-service.js';
import { buildAssistantMessages } from './prompt-builder.js';
import {
  buildPreferenceSavedMessage,
  extractPreferencesFromText,
  resolveScopedPreferences,
  saveScopedPreferences
} from '../agent-core/preference-service.js';

function isPreferenceMemoryIntent(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return /(记住|以后|后续|默认|总是|prefer|always|default)/i.test(normalized)
    && /(中文|英文|claude|codex|简洁|详细|最小改动|concise|detailed|minimal)/i.test(normalized);
}

export function prepareAssistantRequest({ messages, uiLang, sessionId, preferenceStore = agentPreferenceStore } = {}) {
  const intent = detectAssistantIntent(messages);
  const latestUserText = intent.latestUserText || '';
  const scope = sessionId ? { scope: 'chat-session', scopeRef: sessionId } : null;
  const savedPreferences = scope && isPreferenceMemoryIntent(latestUserText)
    ? saveScopedPreferences({
      ...scope,
      text: latestUserText
    }, { store: preferenceStore })
    : [];
  const scopedPreferences = scope
    ? resolveScopedPreferences(scope, { store: preferenceStore })
    : {};
  const language = scopedPreferences.reply_language || resolveManualLanguage({ uiLang, messages });

  if (savedPreferences.length > 0) {
    return {
      intent: {
        type: 'preference_saved',
        latestUserText
      },
      language,
      messages,
      manualContext: null,
      citations: [],
      preferenceMessage: buildPreferenceSavedMessage(savedPreferences),
      preferences: scopedPreferences
    };
  }

  if (intent.type === 'general') {
    const hasScopedPreferences = Object.keys(scopedPreferences).length > 0;
    return {
      intent,
      language,
      messages: hasScopedPreferences
        ? buildAssistantMessages(messages, {
          manualContext: null,
          language,
          intent,
          preferences: scopedPreferences
        })
        : messages,
      manualContext: null,
      citations: [],
      preferences: scopedPreferences
    };
  }

  const manualContext = getManualContext({
    language,
    query: intent.latestUserText
  });

  return {
    intent,
    language,
    manualContext,
    citations: manualContext.citations,
    messages: buildAssistantMessages(messages, {
      manualContext,
      language,
      intent,
      preferences: scopedPreferences
    })
  };
}

export default {
  prepareAssistantRequest
};
