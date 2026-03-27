/**
 * Model Mapping Module
 *
 * Maps any incoming model name (from Codex, Claude Code, etc.) to the
 * correct model on the target API provider using a capability tier system.
 *
 * Tiers:
 *   flagship  — Most capable, highest cost (gpt-5.4, opus, gemini-2.5-pro)
 *   standard  — Daily workhorse (gpt-5.2, sonnet, gemini-2.5-flash)
 *   fast      — Quick & cheap (gpt-4o-mini, haiku, gemini-2.0-flash)
 *   reasoning — Deep thinking (o1, o3, o4)
 *
 * Recognition is keyword-based so future model versions auto-classify.
 * Users only configure which model each tier maps to per provider.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';

const MAPPINGS_FILE = join(CONFIG_DIR, 'model-mappings.json');

// ─── Tier definitions ───────────────────────────────────────────────────────

const TIERS = ['flagship', 'standard', 'fast', 'reasoning'];

const TIER_INFO = {
    flagship:  { label: 'Flagship',  description: 'Most capable, highest quality' },
    standard:  { label: 'Standard',  description: 'Daily workhorse, balanced' },
    fast:      { label: 'Fast',      description: 'Quick and low cost' },
    reasoning: { label: 'Reasoning', description: 'Deep thinking and analysis' },
};

// ─── Default provider tier mappings ─────────────────────────────────────────

const DEFAULT_PROVIDER_MAPPINGS = {
    gemini: {
        flagship:  'gemini-3.1-pro-preview',
        standard:  'gemini-3-flash-preview',
        fast:      'gemini-3.1-flash-lite-preview',
        reasoning: 'gemini-3.1-pro-preview',
    },
    openai: {
        flagship:  'gpt-5.4',
        standard:  'gpt-5.4-mini',
        fast:      'gpt-5.4-nano',
        reasoning: 'o4-mini',
    },
    anthropic: {
        flagship:  'claude-opus-4-6',
        standard:  'claude-sonnet-4-6',
        fast:      'claude-haiku-4-5',
        reasoning: 'claude-opus-4-6',
    },
    'azure-openai': {
        flagship:  'gpt-5.4',
        standard:  'gpt-5.4-mini',
        fast:      'gpt-5.4-nano',
        reasoning: 'o4-mini',
    },
    'vertex-ai': {
        flagship:  'claude-opus-4-6',
        standard:  'claude-sonnet-4-6',
        fast:      'claude-haiku-4-5',
        reasoning: 'claude-opus-4-6',
    },
};

// ─── Known models per provider (for UI dropdowns) ───────────────────────────
// Static defaults — dynamically updated by model-discovery.js via refreshProviderModels().

const STATIC_PROVIDER_MODELS = {
    gemini: [
        'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview',
        'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash',
    ],
    openai: [
        'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
        'gpt-5.3-codex', 'gpt-5.2',
        'o3', 'o3-pro', 'o4-mini',
    ],
    anthropic: [
        'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
        'claude-opus-4-5', 'claude-sonnet-4-5',
    ],
    'azure-openai': [
        'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
        'gpt-4o', 'gpt-4o-mini',
        'o3', 'o4-mini',
    ],
    'vertex-ai': [
        'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview',
        'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash',
        'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-haiku-4-5',
    ],
};

// Dynamic model lists populated by model-discovery.js
const dynamicProviderModels = {};

// ─── Tier recognition — keyword-based, version-agnostic ─────────────────────

/**
 * Recognize tier from any model name using keyword patterns.
 * Designed to work with future model versions automatically.
 */
export function recognizeTier(model) {
    if (!model) return 'standard';
    const m = model.toLowerCase();

    // Reasoning models — check first (o1, o3, o4-mini, deep-think, etc.)
    if (/^o[134](-|$)/.test(m)) return 'reasoning';
    if (m.includes('deep-think') || m.includes('deep_think')) return 'reasoning';

    // Fast / mini models — use word boundary to avoid matching "gemini"
    if (/[-_]mini|^mini/.test(m)) return 'fast';
    if (m.includes('haiku')) return 'fast';

    // Flagship models
    if (m.includes('opus')) return 'flagship';
    if (m.includes('pro') && !m.includes('oprox')) return 'flagship';

    // Flash / Lite models — context-dependent
    if (m.includes('lite')) return 'fast';
    if (m.includes('nano')) return 'fast';
    if (m.includes('flash')) {
        // gemini-3-flash / gemini-2.5-flash = standard workhorse
        // gemini-2.0-flash / older = fast
        if (m.includes('3-flash') || m.includes('2.5-flash') || m.includes('3.1-flash')) return 'standard';
        return 'fast';
    }
    // gpt-5.3+, gpt-6+, etc. with "codex" suffix are flagship
    if (m.includes('codex') && m.includes('gpt-')) return 'flagship';

    // Experimental / open-source models — treat as standard but deprioritized
    if (m.includes('-oss') || m.includes('oss-')) return 'standard';

    // Standard models
    if (m.includes('sonnet')) return 'standard';
    if (m.startsWith('gpt-')) return 'standard';
    if (m.startsWith('gemini-')) return 'standard';
    if (m.startsWith('claude-')) return 'standard';

    return 'standard';
}

// ─── Config persistence ─────────────────────────────────────────────────────

let cachedMappings = null;

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
}

function loadMappings() {
    if (cachedMappings) return cachedMappings;

    if (existsSync(MAPPINGS_FILE)) {
        try {
            const data = JSON.parse(readFileSync(MAPPINGS_FILE, 'utf8'));
            // Merge with defaults so new providers/tiers are always present
            cachedMappings = { providers: {} };
            for (const provider of Object.keys(DEFAULT_PROVIDER_MAPPINGS)) {
                cachedMappings.providers[provider] = {
                    ...DEFAULT_PROVIDER_MAPPINGS[provider],
                    ...(data.providers?.[provider] || {}),
                };
            }
            return cachedMappings;
        } catch {
            // fall through to defaults
        }
    }

    cachedMappings = { providers: { ...DEFAULT_PROVIDER_MAPPINGS } };
    return cachedMappings;
}

function saveMappings() {
    ensureConfigDir();
    writeFileSync(MAPPINGS_FILE, JSON.stringify(cachedMappings, null, 2), { mode: 0o600 });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve a model name to the target provider's actual model.
 *
 * @param {string} providerType - e.g. 'gemini', 'openai', 'anthropic'
 * @param {string} sourceModel  - model name from CLI (e.g. 'gpt-5.4', 'claude-opus-4-6')
 * @returns {string} The provider-native model name
 */
export function resolveModel(providerType, sourceModel) {
    // If the source model already belongs to the target provider, pass through
    if (isNativeModel(providerType, sourceModel)) {
        return sourceModel;
    }

    const tier = recognizeTier(sourceModel);
    const mappings = loadMappings();
    const providerMap = mappings.providers[providerType];

    if (!providerMap) return sourceModel; // Unknown provider, pass through
    return providerMap[tier] || providerMap.standard || sourceModel;
}

/**
 * Check if a model name is native to a provider (no mapping needed).
 */
function isNativeModel(providerType, model) {
    if (!model) return false;
    const m = model.toLowerCase();
    switch (providerType) {
        case 'gemini':
            return m.startsWith('gemini-');
        case 'vertex-ai':
            return m.startsWith('gemini-') || m.startsWith('claude-');
        case 'openai':
        case 'azure-openai':
            return m.startsWith('gpt-') || /^o[134](-|$)/.test(m);
        case 'anthropic':
            return m.startsWith('claude-');
        default:
            return false;
    }
}

/**
 * Get the full mappings config (for API/UI).
 */
export function getMappings() {
    return loadMappings();
}

/**
 * Update mappings for a specific provider.
 * @param {string} provider
 * @param {object} tierMap - e.g. { flagship: 'gemini-2.5-pro', standard: 'gemini-2.5-flash' }
 */
export function setProviderMappings(provider, tierMap) {
    const mappings = loadMappings();
    if (!mappings.providers[provider]) {
        mappings.providers[provider] = { ...DEFAULT_PROVIDER_MAPPINGS[provider] || {} };
    }

    for (const tier of TIERS) {
        if (tierMap[tier] !== undefined) {
            mappings.providers[provider][tier] = tierMap[tier];
        }
    }

    saveMappings();
    return mappings;
}

/**
 * Reset all mappings to defaults.
 */
export function resetMappings() {
    cachedMappings = {
        providers: JSON.parse(JSON.stringify(DEFAULT_PROVIDER_MAPPINGS)),
    };
    saveMappings();
    return cachedMappings;
}

/**
 * Get tier info, provider models list, and defaults (for UI).
 * Merges static and dynamically discovered models for each provider.
 */
export function getMappingsMeta() {
    // Merge static + dynamic model lists, deduplicating
    const mergedModels = {};
    const allProviders = new Set([...Object.keys(STATIC_PROVIDER_MODELS), ...Object.keys(dynamicProviderModels)]);
    for (const provider of allProviders) {
        const staticList = STATIC_PROVIDER_MODELS[provider] || [];
        const dynamicList = dynamicProviderModels[provider] || [];
        const seen = new Set();
        mergedModels[provider] = [...dynamicList, ...staticList].filter(id => {
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });
    }

    return {
        tiers: TIER_INFO,
        tierOrder: TIERS,
        providerModels: mergedModels,
        defaults: DEFAULT_PROVIDER_MAPPINGS,
    };
}

// ─── Dynamic discovery integration ──────────────────────────────────────────

/**
 * Update the dynamic model list for a provider (called by model-discovery.js).
 * These models appear in the UI dropdown alongside the static defaults.
 * @param {string} providerType
 * @param {Array} models - [{id, name, ...}]
 */
export function refreshProviderModels(providerType, models) {
    dynamicProviderModels[providerType] = models.map(m => m.id || m);
}

/**
 * Auto-update tier mappings from discovered models.
 * Only updates tiers where the user has NOT manually overridden the default.
 * @param {string} providerType
 * @param {object} tierMap - { flagship: 'model-id', standard: 'model-id', ... }
 */
export function autoUpdateMappings(providerType, tierMap) {
    if (!tierMap || Object.keys(tierMap).length === 0) return;

    const mappings = loadMappings();
    const defaults = DEFAULT_PROVIDER_MAPPINGS[providerType] || {};
    const current = mappings.providers[providerType] || {};

    let updated = false;
    for (const tier of TIERS) {
        if (!tierMap[tier]) continue;
        // Only auto-update if the current value is the hardcoded default
        // (user hasn't manually changed it)
        if (current[tier] === defaults[tier] || !current[tier]) {
            if (current[tier] !== tierMap[tier]) {
                current[tier] = tierMap[tier];
                updated = true;
            }
        }
    }

    if (updated) {
        mappings.providers[providerType] = current;
        saveMappings();
    }
}
