/**
 * API Key Manager
 * Stores and manages API keys for multiple providers.
 * Handles key rotation, load balancing, and status tracking.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { CONFIG_DIR } from './account-manager.js';
import { join } from 'path';
import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GeminiProvider } from './providers/gemini.js';
import { AzureOpenAIProvider } from './providers/azure-openai.js';
import { VertexAIProvider } from './providers/vertex-ai.js';
import { MiniMaxProvider } from './providers/minimax.js';
import { MoonshotProvider } from './providers/moonshot.js';
import { ZhipuProvider } from './providers/zhipu.js';

const API_KEYS_FILE = join(CONFIG_DIR, 'api-keys.json');

const PROVIDER_CLASSES = {
    openai: OpenAIProvider,
    anthropic: AnthropicProvider,
    gemini: GeminiProvider,
    'azure-openai': AzureOpenAIProvider,
    'vertex-ai': VertexAIProvider,
    minimax: MiniMaxProvider,
    moonshot: MoonshotProvider,
    zhipu: ZhipuProvider
};

let keysData = null;
let providerInstances = new Map();

function loadKeys() {
    if (keysData !== null) return keysData;

    if (!existsSync(API_KEYS_FILE)) {
        keysData = { keys: [] };
        return keysData;
    }

    try {
        keysData = JSON.parse(readFileSync(API_KEYS_FILE, 'utf8'));
        if (!Array.isArray(keysData.keys)) keysData.keys = [];
    } catch {
        keysData = { keys: [] };
    }
    return keysData;
}

function saveKeys() {
    const data = loadKeys();
    // Save raw key data (serialize provider instances)
    const toSave = {
        keys: data.keys.map(k => {
            const instance = providerInstances.get(k.id);
            return instance ? instance.toJSON() : k;
        })
    };
    writeFileSync(API_KEYS_FILE, JSON.stringify(toSave, null, 2), { mode: 0o600 });
}

function getProvider(keyConfig) {
    if (providerInstances.has(keyConfig.id)) {
        return providerInstances.get(keyConfig.id);
    }
    const ProviderClass = PROVIDER_CLASSES[keyConfig.type];
    if (!ProviderClass) return null;

    const instance = new ProviderClass(keyConfig);
    providerInstances.set(keyConfig.id, instance);
    return instance;
}

function generateId() {
    return 'key_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Public API ────────────────────────────────────────────────────────────────

export function addApiKey({ type, name, apiKey, baseUrl, deploymentName, apiVersion, projectId, location }) {
    if (!PROVIDER_CLASSES[type]) {
        return { success: false, error: `Unknown provider type: ${type}. Supported: ${Object.keys(PROVIDER_CLASSES).join(', ')}` };
    }
    if (!apiKey) {
        return { success: false, error: 'API key is required' };
    }

    const data = loadKeys();
    const id = generateId();
    const keyConfig = {
        id,
        type,
        name: name || `${type}-${id.slice(-4)}`,
        apiKey,
        baseUrl: baseUrl || undefined,
        enabled: true,
        addedAt: new Date().toISOString(),
        totalRequests: 0,
        totalTokens: 0,
        totalCost: 0,
        errors: 0
    };

    // Azure OpenAI specific
    if (type === 'azure-openai') {
        keyConfig.deploymentName = deploymentName || '';
        keyConfig.apiVersion = apiVersion || '2024-10-21';
    }
    // Vertex AI specific
    if (type === 'vertex-ai') {
        keyConfig.projectId = projectId || '';
        keyConfig.location = location || 'us-central1';
    }

    data.keys.push(keyConfig);
    getProvider(keyConfig); // Create instance
    saveKeys();

    return { success: true, id, name: keyConfig.name };
}

export function removeApiKey(id) {
    const data = loadKeys();
    const index = data.keys.findIndex(k => k.id === id);
    if (index < 0) return { success: false, error: 'Key not found' };

    data.keys.splice(index, 1);
    providerInstances.delete(id);
    saveKeys();
    return { success: true };
}

export function updateApiKey(id, patch) {
    const data = loadKeys();
    const key = data.keys.find(k => k.id === id);
    if (!key) return { success: false, error: 'Key not found' };

    if (patch.name !== undefined) key.name = patch.name;
    if (patch.apiKey !== undefined) key.apiKey = patch.apiKey;
    if (patch.baseUrl !== undefined) key.baseUrl = patch.baseUrl;
    if (patch.enabled !== undefined) key.enabled = patch.enabled;

    // Rebuild provider instance
    providerInstances.delete(id);
    getProvider(key);
    saveKeys();
    return { success: true };
}

export function listApiKeys() {
    const data = loadKeys();
    return data.keys.map(k => {
        const provider = getProvider(k);
        return provider ? provider.toSafeJSON() : { ...k, apiKey: '****' };
    });
}

export function getApiKeysByType(type) {
    const data = loadKeys();
    return data.keys
        .filter(k => k.type === type && k.enabled)
        .map(k => getProvider(k))
        .filter(Boolean);
}

export function getAllProviders() {
    const data = loadKeys();
    return data.keys.map(k => getProvider(k)).filter(Boolean);
}

/**
 * Select the best available key for a given provider type.
 * Strategy: pick the key with the fewest requests (simple load balancing).
 */
export function selectKey(type) {
    const available = getApiKeysByType(type).filter(p => p.isAvailable);
    if (available.length === 0) return null;

    // Simple load balancing: least requests first
    available.sort((a, b) => a.totalRequests - b.totalRequests);
    return available[0];
}

/**
 * Check if any enabled keys exist for the given types (ignores rate limit status).
 * Used to distinguish "no keys configured" from "all keys rate-limited".
 */
export function hasKeysForTypes(types) {
    const data = loadKeys();
    return types.some(type =>
        data.keys.some(k => k.type === type && k.enabled)
    );
}

/**
 * Get rate limit info for keys of given types.
 * Returns { allRateLimited, minWaitMs } if keys exist but are all rate-limited.
 */
export function getKeyRateLimitInfo(types) {
    let hasAnyKey = false;
    let minUntil = Infinity;

    for (const type of types) {
        const keys = getApiKeysByType(type);
        for (const k of keys) {
            hasAnyKey = true;
            if (k.isAvailable) return { allRateLimited: false, minWaitMs: 0 };
            if (k.rateLimitedUntil) {
                const wait = k.rateLimitedUntil - Date.now();
                if (wait > 0 && wait < minUntil) minUntil = wait;
            }
        }
    }

    if (!hasAnyKey) return { allRateLimited: false, minWaitMs: 0 };
    return { allRateLimited: true, minWaitMs: minUntil === Infinity ? 60000 : minUntil };
}

export async function validateApiKey(id) {
    const data = loadKeys();
    const key = data.keys.find(k => k.id === id);
    if (!key) return { valid: false, error: 'Key not found' };

    const provider = getProvider(key);
    if (!provider) return { valid: false, error: 'Unknown provider type' };

    const valid = await provider.validateKey();
    return { valid };
}

export function recordUsage(id, { inputTokens = 0, outputTokens = 0, model = '' } = {}) {
    const provider = providerInstances.get(id);
    if (!provider) return;

    const cost = provider.estimateCost(model, inputTokens, outputTokens);
    provider.markUsed(inputTokens + outputTokens, cost);
    saveKeys();
}

export function recordError(id) {
    const provider = providerInstances.get(id);
    if (!provider) return;
    provider.markError();
    saveKeys();
}

export function recordRateLimit(id, durationMs = 60000) {
    const provider = providerInstances.get(id);
    if (!provider) return;
    provider.markRateLimited(durationMs);
}

export function getStats() {
    const providers = getAllProviders();
    const byType = {};

    for (const p of providers) {
        if (!byType[p.type]) {
            byType[p.type] = { total: 0, active: 0, requests: 0, tokens: 0, cost: 0, errors: 0 };
        }
        byType[p.type].total++;
        if (p.isAvailable) byType[p.type].active++;
        byType[p.type].requests += p.totalRequests;
        byType[p.type].tokens += p.totalTokens;
        byType[p.type].cost += p.totalCost;
        byType[p.type].errors += p.errors;
    }

    return {
        totalKeys: providers.length,
        activeKeys: providers.filter(p => p.isAvailable).length,
        totalRequests: providers.reduce((s, p) => s + p.totalRequests, 0),
        totalTokens: providers.reduce((s, p) => s + p.totalTokens, 0),
        totalCost: providers.reduce((s, p) => s + p.totalCost, 0),
        byType
    };
}

export { API_KEYS_FILE };
