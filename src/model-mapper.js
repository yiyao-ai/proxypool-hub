/**
 * Model Mapper
 *
 * Maps any incoming model name to upstream routing info using a tier-based system.
 * Delegates to model-mapping.js for tier recognition and provider model resolution.
 *
 * Flow:
 *   1. recognizeTier(requestedModel) → flagship / standard / fast / reasoning
 *   2. fast tier + enableFreeModels → route to Kilo (free)
 *   3. Otherwise → resolveModel('openai', requestedModel) for ChatGPT account pool
 *
 * The legacy CLAUDE_MODEL_MAP is kept as a fallback for the first ~30s of startup
 * before model discovery has run.
 */

import { getServerSettings } from './server-settings.js';
import { recognizeTier, resolveModel } from './model-mapping.js';

// ─── Legacy static map (fallback only) ──────────────────────────────────────
// Kept so that the very first requests after cold start still route correctly
// before model-discovery.js has populated dynamic tier mappings.

const CLAUDE_MODEL_MAP = {
  'claude-opus-4-6': 'gpt-5.3-codex',
  'claude-opus-4-6-20250219': 'gpt-5.3-codex',
  'claude-sonnet-4-6': 'gpt-5.2',
  'claude-sonnet-4-6-20250219': 'gpt-5.2',
  'claude-haiku-4-5': 'kilo',
  'claude-haiku-4-5-20250219': 'kilo',
  'claude-opus-4-6-1m': 'gpt-5.3-codex',
  'claude-sonnet-4-6-1m': 'gpt-5.2',
  'claude-opus-4-5': 'gpt-5.3-codex',
  'claude-opus-4-5-20250514': 'gpt-5.3-codex',
  'claude-sonnet-4-5': 'gpt-5.2',
  'claude-sonnet-4-5-20250514': 'gpt-5.2',
  'claude-sonnet-4-20250514': 'gpt-5.2',
  'claude-haiku-4-20250514': 'kilo',
  'claude-haiku-3-5-20250514': 'kilo',
  'claude-3-5-sonnet-20240620': 'gpt-5.2',
  'claude-3-opus-20240229': 'gpt-5.3-codex',
  'claude-3-sonnet-20240229': 'gpt-5.2',
  'claude-3-haiku-20240307': 'kilo',
  'sonnet': 'gpt-5.2',
  'opus': 'gpt-5.3-codex',
  'haiku': 'kilo',
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

// ─── Tier-based model resolution ────────────────────────────────────────────

/**
 * Resolve the upstream model for a requested model name using the tier system.
 * Falls back to the legacy static map if model-mapping returns the input unchanged
 * (meaning no mapping was found — e.g. before discovery runs).
 *
 * @param {string} model - The requested model name
 * @returns {string} The upstream model identifier
 */
function resolveUpstreamModel(model) {
  if (!model) return 'gpt-5.2';

  // If it's a direct OpenAI model, pass through
  const lower = model.toLowerCase();
  if (lower.startsWith('gpt-') || /^o[134](-|$)/.test(lower)) {
    return model;
  }

  // Use the tier-based mapping system (model-mapping.js)
  const resolved = resolveModel('openai', model);

  // If resolveModel returned the input unchanged, it means no mapping was found.
  // Fall back to the legacy static map.
  if (resolved === model && CLAUDE_MODEL_MAP[model]) {
    return CLAUDE_MODEL_MAP[model];
  }

  return resolved;
}

// ─── Kilo (free model) resolution ───────────────────────────────────────────

/**
 * Resolves the actual Kilo model identifier based on server settings.
 * @returns {string}
 */
export function resolveKiloModel() {
  const settings = getServerSettings();
  return settings.haikuKiloModel || 'minimax/minimax-m2.5:free';
}

// ─── Main routing entry point ───────────────────────────────────────────────

/**
 * Resolves all model routing info from a requested model name.
 *
 * Uses tier-based classification:
 *   - fast tier + enableFreeModels → route to Kilo (free model)
 *   - Otherwise → resolve to upstream OpenAI model via tier system
 *
 * @param {string} requestedModel
 * @returns {{ mappedModel: string, isKilo: boolean, kiloTarget: string|null, upstreamModel: string }}
 */
export function resolveModelRouting(requestedModel) {
  const model = requestedModel || 'gpt-5.2';
  const tier = recognizeTier(model);
  const settings = getServerSettings();
  const freeEnabled = settings.enableFreeModels !== false;

  // Fast tier + free models enabled → route to Kilo
  if (tier === 'fast' && freeEnabled) {
    const kiloTarget = resolveKiloModel();
    return { mappedModel: 'kilo', isKilo: true, kiloTarget, upstreamModel: kiloTarget };
  }

  // All other cases → resolve to upstream OpenAI model
  const upstreamModel = resolveUpstreamModel(model);
  return { mappedModel: upstreamModel, isKilo: false, kiloTarget: null, upstreamModel };
}

// ─── Legacy compatibility exports ───────────────────────────────────────────

/** @deprecated Use resolveModelRouting() instead */
export function mapClaudeModel(model) {
  return resolveUpstreamModel(model);
}

/** @deprecated Use resolveModelRouting() instead */
export function isKiloModel(mappedModel) {
  return mappedModel === 'kilo';
}

export default { mapClaudeModel, isKiloModel, resolveKiloModel, resolveModelRouting, CLAUDE_MODEL_MAP };
