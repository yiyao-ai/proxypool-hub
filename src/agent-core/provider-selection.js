import assistantMemoryService from '../assistant-core/memory-service.js';

export function selectRuntimeProvider({
  conversation = null,
  activeSession = null,
  rememberedBrief = null,
  defaultRuntimeProvider = 'codex',
  preferenceStore,
  memoryService = assistantMemoryService,
  cwd = '',
  metadata = {}
} = {}) {
  if (activeSession?.provider) {
    return String(activeSession.provider);
  }

  const preferences = memoryService.resolvePreferences({
    conversation,
    runtimeSession: activeSession,
    cwd,
    metadata
  }, {
    store: preferenceStore
  });
  if (preferences?.values?.preferred_runtime_provider) {
    return String(preferences.values.preferred_runtime_provider);
  }

  if (rememberedBrief?.provider) {
    return String(rememberedBrief.provider);
  }

  return String(defaultRuntimeProvider || 'codex');
}

export default {
  selectRuntimeProvider
};
