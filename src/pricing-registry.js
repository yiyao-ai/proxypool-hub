import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';

const PRICING_FILE = join(CONFIG_DIR, 'model-pricing.json');

const DEFAULT_PRICING = {
    openai: {
        'gpt-5.4': { input: 2.50, output: 15.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-5.4-pro': { input: 30.00, output: 180.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-5.4-mini': { input: 0.75, output: 4.50, cacheRead: 0, cacheWrite: 0 },
        'gpt-5.4-nano': { input: 0.20, output: 1.25, cacheRead: 0, cacheWrite: 0 },
        'gpt-5.3-codex': { input: 2.50, output: 10.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-5.2': { input: 1.75, output: 14.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-4o': { input: 2.50, output: 10.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0, cacheWrite: 0 },
        o3: { input: 2.00, output: 8.00, cacheRead: 0, cacheWrite: 0 },
        'o3-pro': { input: 20.00, output: 80.00, cacheRead: 0, cacheWrite: 0 },
        'o4-mini': { input: 1.10, output: 4.40, cacheRead: 0, cacheWrite: 0 }
    },
    'azure-openai': {
        'gpt-5.4': { input: 2.50, output: 15.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-5.4-mini': { input: 0.75, output: 4.50, cacheRead: 0, cacheWrite: 0 },
        'gpt-5.4-nano': { input: 0.20, output: 1.25, cacheRead: 0, cacheWrite: 0 },
        'gpt-4o': { input: 2.50, output: 10.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-4o-mini': { input: 0.15, output: 0.60, cacheRead: 0, cacheWrite: 0 },
        'gpt-4-turbo': { input: 10.00, output: 30.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-4': { input: 30.00, output: 60.00, cacheRead: 0, cacheWrite: 0 },
        'gpt-35-turbo': { input: 0.50, output: 1.50, cacheRead: 0, cacheWrite: 0 },
        'gpt-3.5-turbo': { input: 0.50, output: 1.50, cacheRead: 0, cacheWrite: 0 },
        o1: { input: 15.00, output: 60.00, cacheRead: 0, cacheWrite: 0 },
        'o1-mini': { input: 3.00, output: 12.00, cacheRead: 0, cacheWrite: 0 },
        o3: { input: 2.00, output: 8.00, cacheRead: 0, cacheWrite: 0 },
        'o3-mini': { input: 1.10, output: 4.40, cacheRead: 0, cacheWrite: 0 },
        'o4-mini': { input: 1.10, output: 4.40, cacheRead: 0, cacheWrite: 0 }
    },
    anthropic: {
        'claude-opus-4-6': { input: 5.00, output: 25.00, cacheRead: 0, cacheWrite: 0 },
        'claude-opus-4-6-20250219': { input: 5.00, output: 25.00, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-6-20250219': { input: 3.00, output: 15.00, cacheRead: 0, cacheWrite: 0 },
        'claude-opus-4-5': { input: 5.00, output: 25.00, cacheRead: 0, cacheWrite: 0 },
        'claude-opus-4-5-20250514': { input: 5.00, output: 25.00, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-5': { input: 3.00, output: 15.00, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-5-20250514': { input: 3.00, output: 15.00, cacheRead: 0, cacheWrite: 0 },
        'claude-haiku-4-5': { input: 1.00, output: 5.00, cacheRead: 0, cacheWrite: 0 },
        'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00, cacheRead: 0, cacheWrite: 0 }
    },
    gemini: {
        'gemini-3.1-pro-preview': { input: 2.00, output: 12.00, cacheRead: 0, cacheWrite: 0 },
        'gemini-3-flash-preview': { input: 0.50, output: 3.00, cacheRead: 0, cacheWrite: 0 },
        'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50, cacheRead: 0, cacheWrite: 0 },
        'gemini-2.5-pro': { input: 1.25, output: 10.00, cacheRead: 0, cacheWrite: 0 },
        'gemini-2.5-flash': { input: 0.30, output: 2.50, cacheRead: 0, cacheWrite: 0 },
        'gemini-2.0-flash': { input: 0.10, output: 0.40, cacheRead: 0, cacheWrite: 0 }
    },
    'vertex-ai': {
        'gemini-3.1-pro-preview': { input: 2.00, output: 12.00, cacheRead: 0, cacheWrite: 0 },
        'gemini-3-flash-preview': { input: 0.50, output: 3.00, cacheRead: 0, cacheWrite: 0 },
        'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50, cacheRead: 0, cacheWrite: 0 },
        'gemini-2.5-pro': { input: 1.25, output: 10.00, cacheRead: 0, cacheWrite: 0 },
        'gemini-2.5-flash': { input: 0.30, output: 2.50, cacheRead: 0, cacheWrite: 0 },
        'gemini-2.0-flash': { input: 0.10, output: 0.40, cacheRead: 0, cacheWrite: 0 },
        'claude-opus-4-6': { input: 5.00, output: 25.00, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0, cacheWrite: 0 },
        'claude-sonnet-4-5': { input: 3.00, output: 15.00, cacheRead: 0, cacheWrite: 0 },
        'claude-haiku-4-5': { input: 1.00, output: 5.00, cacheRead: 0, cacheWrite: 0 }
    },
    minimax: {
        'MiniMax-M2.7': { input: 0.30, output: 1.20, cacheRead: 0, cacheWrite: 0 },
        'MiniMax-M2.7-highspeed': { input: 0.30, output: 2.40, cacheRead: 0, cacheWrite: 0 },
        'MiniMax-M2.5': { input: 0.30, output: 1.20, cacheRead: 0, cacheWrite: 0 },
        'MiniMax-M2.5-highspeed': { input: 0.30, output: 2.40, cacheRead: 0, cacheWrite: 0 },
        'MiniMax-M2.1': { input: 0.20, output: 0.80, cacheRead: 0, cacheWrite: 0 },
        'MiniMax-M2.1-highspeed': { input: 0.20, output: 1.60, cacheRead: 0, cacheWrite: 0 },
        'MiniMax-M2': { input: 0.15, output: 0.60, cacheRead: 0, cacheWrite: 0 }
    },
    moonshot: {
        'kimi-k2.5': { input: 0.60, output: 2.50, cacheRead: 0, cacheWrite: 0 },
        'kimi-k2-thinking': { input: 0.60, output: 2.50, cacheRead: 0, cacheWrite: 0 },
        'kimi-k2-thinking-turbo': { input: 0.30, output: 1.20, cacheRead: 0, cacheWrite: 0 }
    },
    zhipu: {
        'glm-5': { input: 0.72, output: 2.30, cacheRead: 0, cacheWrite: 0 },
        'glm-5-turbo': { input: 0.36, output: 1.15, cacheRead: 0, cacheWrite: 0 },
        'glm-4.7': { input: 0.40, output: 1.20, cacheRead: 0, cacheWrite: 0 },
        'glm-4-plus': { input: 0.30, output: 0.90, cacheRead: 0, cacheWrite: 0 },
        'glm-4-air': { input: 0.07, output: 0.07, cacheRead: 0, cacheWrite: 0 },
        'glm-4-airx': { input: 0.14, output: 0.14, cacheRead: 0, cacheWrite: 0 },
        'glm-4-flash': { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 }
    },
    deepseek: {
        'deepseek-v4-flash': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0 },
        'deepseek-v4-pro': { input: 2.00, output: 8.00, cacheRead: 0.50, cacheWrite: 0 },
        'deepseek-chat': { input: 0.27, output: 1.10, cacheRead: 0.07, cacheWrite: 0 },
        'deepseek-reasoner': { input: 2.00, output: 8.00, cacheRead: 0.50, cacheWrite: 0 }
    }
};

let overrideData = null;

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function loadOverrides() {
    if (overrideData !== null) return overrideData;
    if (!existsSync(PRICING_FILE)) {
        overrideData = { providers: {} };
        return overrideData;
    }
    try {
        const parsed = JSON.parse(readFileSync(PRICING_FILE, 'utf8'));
        overrideData = { providers: parsed?.providers || {} };
    } catch {
        overrideData = { providers: {} };
    }
    return overrideData;
}

function saveOverrides() {
    const data = loadOverrides();
    writeFileSync(PRICING_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function normalizePriceValue(value) {
    if (value === undefined || value === null || value === '') return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('Price values must be non-negative numbers');
    }
    return parsed;
}

function getOverride(provider, model) {
    return loadOverrides().providers?.[provider]?.[model] || null;
}

export function getDefaultPricing(provider = null) {
    if (!provider) return clone(DEFAULT_PRICING);
    return clone(DEFAULT_PRICING[provider] || {});
}

export function getEffectivePricing(provider, model) {
    const defaults = DEFAULT_PRICING[provider]?.[model] || null;
    const override = getOverride(provider, model);
    if (!defaults && !override) return null;
    return {
        input: override?.input ?? defaults?.input ?? 0,
        output: override?.output ?? defaults?.output ?? 0,
        cacheRead: override?.cacheRead ?? defaults?.cacheRead ?? 0,
        cacheWrite: override?.cacheWrite ?? defaults?.cacheWrite ?? 0,
        source: override ? 'custom' : 'default'
    };
}

export function estimateCostWithRegistry(provider, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0) {
    const pricing = getEffectivePricing(provider, model);
    if (!pricing) return 0;
    return (
        (inputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output +
        (cacheReadTokens / 1_000_000) * pricing.cacheRead +
        (cacheWriteTokens / 1_000_000) * pricing.cacheWrite
    );
}

export function listPricingEntries() {
    const overrides = loadOverrides().providers || {};
    const providers = new Set([
        ...Object.keys(DEFAULT_PRICING),
        ...Object.keys(overrides)
    ]);

    const entries = [];
    for (const provider of providers) {
        const models = new Set([
            ...Object.keys(DEFAULT_PRICING[provider] || {}),
            ...Object.keys(overrides[provider] || {})
        ]);

        for (const model of models) {
            const defaults = DEFAULT_PRICING[provider]?.[model] || null;
            const override = overrides[provider]?.[model] || null;
            const effective = getEffectivePricing(provider, model);
            entries.push({
                provider,
                model,
                unit: 'USD / 1M tokens',
                default: defaults ? { ...defaults } : null,
                override: override ? { ...override } : null,
                effective,
                hasOverride: !!override
            });
        }
    }

    entries.sort((a, b) => {
        if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
        return a.model.localeCompare(b.model);
    });
    return entries;
}

export function updatePricingEntry(provider, model, patch) {
    if (!provider || !model) {
        throw new Error('provider and model are required');
    }
    const data = loadOverrides();
    if (!data.providers[provider]) data.providers[provider] = {};
    data.providers[provider][model] = {
        input: normalizePriceValue(patch.input),
        output: normalizePriceValue(patch.output),
        cacheRead: normalizePriceValue(patch.cacheRead),
        cacheWrite: normalizePriceValue(patch.cacheWrite),
        updatedAt: new Date().toISOString()
    };
    saveOverrides();
    return listPricingEntries().find(entry => entry.provider === provider && entry.model === model);
}

export function resetPricingEntry(provider, model) {
    const data = loadOverrides();
    if (data.providers?.[provider]?.[model]) {
        delete data.providers[provider][model];
        if (Object.keys(data.providers[provider]).length === 0) {
            delete data.providers[provider];
        }
        saveOverrides();
    }
    return listPricingEntries().find(entry => entry.provider === provider && entry.model === model) || null;
}

export function getPricingSummary() {
    const entries = listPricingEntries();
    return {
        providers: [...new Set(entries.map(entry => entry.provider))].length,
        models: entries.length,
        customOverrides: entries.filter(entry => entry.hasOverride).length,
        unit: 'USD / 1M tokens'
    };
}

export { DEFAULT_PRICING, PRICING_FILE };
