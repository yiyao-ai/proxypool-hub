/**
 * Model Mapper
 * Maps Anthropic/Claude model names to upstream OpenAI/Kilo model identifiers.
 */

import { getServerSettings } from './server-settings.js';

const CLAUDE_MODEL_MAP = {
  // Current Claude 4.6 models (Feb 2026)
  'claude-opus-4-6': 'gpt-5.3-codex',
  'claude-opus-4-6-20250219': 'gpt-5.3-codex',
  'claude-sonnet-4-6': 'gpt-5.2',
  'claude-sonnet-4-6-20250219': 'gpt-5.2',
  'claude-haiku-4-5': 'kilo',
  'claude-haiku-4-5-20250219': 'kilo',
  
  // 1M context variants
  'claude-opus-4-6-1m': 'gpt-5.3-codex',
  'claude-sonnet-4-6-1m': 'gpt-5.2',
  
  // Legacy Claude 4.5 models (deprecated but still supported)
  'claude-opus-4-5': 'gpt-5.3-codex',
  'claude-opus-4-5-20250514': 'gpt-5.3-codex',
  'claude-sonnet-4-5': 'gpt-5.2',
  'claude-sonnet-4-5-20250514': 'gpt-5.2',
  'claude-sonnet-4-20250514': 'gpt-5.2',
  'claude-haiku-4-20250514': 'kilo',
  'claude-haiku-3-5-20250514': 'kilo',
  
  // Legacy Claude 3.x models
  'claude-3-5-sonnet-20240620': 'gpt-5.2',
  'claude-3-opus-20240229': 'gpt-5.3-codex',
  'claude-3-sonnet-20240229': 'gpt-5.2',
  'claude-3-haiku-20240307': 'kilo',
  
  // Short aliases
  'sonnet': 'gpt-5.2',
  'opus': 'gpt-5.3-codex',
  'haiku': 'kilo',
  
  // Direct OpenAI models
  'gpt-5.3-codex': 'gpt-5.3-codex',
  'gpt-5.2-codex': 'gpt-5.2-codex',
  'gpt-5.1-codex-max': 'gpt-5.1-codex-max',
  'gpt-5.1-codex': 'gpt-5.1-codex',
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-5.2': 'gpt-5.2',
  'gpt-5.1': 'gpt-5.1',
  'gpt-5': 'gpt-5',
  'gpt-5.1-codex-mini': 'gpt-5.1-codex-mini',
  'gpt-5-codex-mini': 'gpt-5-codex-mini'
};

/**
 * Maps a Claude/Anthropic model name to the upstream model identifier.
 * Falls back to 'gpt-5.2' for unknown models.
 * @param {string} model
 * @returns {string}
 */
export function mapClaudeModel(model) {
  if (!model) return 'gpt-5.2';

  if (CLAUDE_MODEL_MAP[model]) {
    return CLAUDE_MODEL_MAP[model];
  }

  const modelLower = model.toLowerCase();

  if (modelLower.startsWith('claude-')) {
    const cleanModel = modelLower.replace(/^claude-/, '');
    if (cleanModel.includes('opus')) return 'gpt-5.3-codex';
    if (cleanModel.includes('sonnet')) return 'gpt-5.2';
    if (cleanModel.includes('haiku')) return 'kilo';
  }

  for (const [key, value] of Object.entries(CLAUDE_MODEL_MAP)) {
    if (modelLower.includes(key.toLowerCase())) {
      return value;
    }
  }

  return 'gpt-5.2';
}

/**
 * Returns true if the mapped model should be routed through Kilo.
 * @param {string} mappedModel
 * @returns {boolean}
 */
export function isKiloModel(mappedModel) {
  return mappedModel === 'kilo';
}

/**
 * Resolves the actual Kilo model identifier based on server settings.
 * The setting stores the full Kilo model ID (e.g. 'minimax/minimax-m2.5:free').
 * @returns {string}
 */
export function resolveKiloModel() {
  const settings = getServerSettings();
  return settings.haikuKiloModel || 'minimax/minimax-m2.5:free';
}

/**
 * Resolves all model routing info from a requested model name.
 * @param {string} requestedModel
 * @returns {{ mappedModel: string, isKilo: boolean, kiloTarget: string|null, upstreamModel: string }}
 */
export function resolveModelRouting(requestedModel) {
  const mappedModel = mapClaudeModel(requestedModel || 'gpt-5.2');
  const isKilo = isKiloModel(mappedModel);
  const kiloTarget = isKilo ? resolveKiloModel() : null;
  const upstreamModel = isKilo ? kiloTarget : mappedModel;
  return { mappedModel, isKilo, kiloTarget, upstreamModel };
}

export default { mapClaudeModel, isKiloModel, resolveKiloModel, resolveModelRouting, CLAUDE_MODEL_MAP };
