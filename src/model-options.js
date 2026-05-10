import { getMappingsMeta } from './model-mapping.js';

function normalizeProviderType(providerType) {
  const type = String(providerType || '').trim();
  switch (type) {
    case 'openai':
    case 'azure-openai':
    case 'anthropic':
    case 'gemini':
    case 'vertex-ai':
    case 'deepseek':
    case 'ollama':
      return type;
    case 'google':
      return 'gemini';
    default:
      return type || null;
  }
}

export function getProviderModelOptions(providerType) {
  const normalized = normalizeProviderType(providerType);
  if (!normalized) return [];
  const meta = getMappingsMeta();
  return Array.isArray(meta.providerModels?.[normalized])
    ? meta.providerModels[normalized]
    : [];
}

export { normalizeProviderType };

export default {
  getProviderModelOptions,
  normalizeProviderType
};
