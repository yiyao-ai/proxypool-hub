import { resolveConversationPreferences } from './preference-service.js';

export function selectRuntimeProvider({
  conversation = null,
  activeSession = null,
  rememberedBrief = null,
  defaultRuntimeProvider = 'codex'
} = {}) {
  if (activeSession?.provider) {
    return String(activeSession.provider);
  }

  const preferences = resolveConversationPreferences(conversation);
  if (preferences.preferred_runtime_provider) {
    return String(preferences.preferred_runtime_provider);
  }

  if (rememberedBrief?.provider) {
    return String(rememberedBrief.provider);
  }

  return String(defaultRuntimeProvider || 'codex');
}

export default {
  selectRuntimeProvider
};
