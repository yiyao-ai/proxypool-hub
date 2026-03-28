/**
 * OpenClaw Configuration Utility
 * Reads and writes ~/.openclaw/openclaw.json to configure OpenClaw
 * to use ProxyPool Hub as a custom model provider.
 *
 * Model list is built dynamically from the proxy's model discovery system
 * rather than hardcoded, so OpenClaw always reflects what the proxy can serve.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getDiscoveredModels } from './model-discovery.js';
import { listAccounts as listClaudeAccounts } from './claude-account-manager.js';

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const OPENCLAW_CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');
const PROXYPOOL_DIR = join(homedir(), '.proxypool-hub');
const BACKUP_FILE = join(PROXYPOOL_DIR, 'openclaw-backup.json');

const PROVIDER_ID = 'proxypool';

// ─── Model metadata for OpenClaw display ────────────────────────────────────
// Provides contextWindow, maxTokens, reasoning, input types, and cost info
// for known models. Unknown models get DEFAULT_METADATA.

const MODEL_METADATA = {
    // Anthropic
    'claude-opus-4-6':      { name: 'Claude Opus 4.6',      contextWindow: 200000, maxTokens: 32768, reasoning: true,  input: ['text', 'image'], cost: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 } },
    'claude-sonnet-4-6':    { name: 'Claude Sonnet 4.6',    contextWindow: 200000, maxTokens: 16384, reasoning: true,  input: ['text', 'image'], cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 } },
    'claude-haiku-4-5':     { name: 'Claude Haiku 4.5',     contextWindow: 200000, maxTokens: 8192,  reasoning: false, input: ['text', 'image'], cost: { input: 0.0008, output: 0.004, cacheRead: 0.00008, cacheWrite: 0.001 } },
    'claude-opus-4-5':      { name: 'Claude Opus 4.5',      contextWindow: 200000, maxTokens: 32768, reasoning: true,  input: ['text', 'image'], cost: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 } },
    'claude-sonnet-4-5':    { name: 'Claude Sonnet 4.5',    contextWindow: 200000, maxTokens: 16384, reasoning: true,  input: ['text', 'image'], cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 } },
    'claude-opus-4-6-1m':   { name: 'Claude Opus 4.6 1M',   contextWindow: 1000000, maxTokens: 32768, reasoning: true, input: ['text', 'image'], cost: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 } },
    'claude-sonnet-4-6-1m': { name: 'Claude Sonnet 4.6 1M', contextWindow: 1000000, maxTokens: 16384, reasoning: true, input: ['text', 'image'], cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 } },
    // OpenAI
    'gpt-5.4':              { name: 'GPT-5.4',              contextWindow: 128000, maxTokens: 16384, reasoning: true,  input: ['text', 'image'], cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } },
    'gpt-5.3-codex':        { name: 'GPT-5.3 Codex',        contextWindow: 192000, maxTokens: 32768, reasoning: true,  input: ['text'],          cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } },
    'gpt-5.2':              { name: 'GPT-5.2',              contextWindow: 128000, maxTokens: 16384, reasoning: true,  input: ['text', 'image'], cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } },
    'gpt-5.2-codex':        { name: 'GPT-5.2 Codex',        contextWindow: 192000, maxTokens: 32768, reasoning: true,  input: ['text'],          cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } },
    'gpt-5.1-codex':        { name: 'GPT-5.1 Codex',        contextWindow: 192000, maxTokens: 32768, reasoning: true,  input: ['text'],          cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 } },
    // Google
    'gemini-2.5-pro':       { name: 'Gemini 2.5 Pro',       contextWindow: 1000000, maxTokens: 8192, reasoning: true,  input: ['text', 'image'], cost: { input: 0.00125, output: 0.01, cacheRead: 0, cacheWrite: 0 } },
    'gemini-2.5-flash':     { name: 'Gemini 2.5 Flash',     contextWindow: 1000000, maxTokens: 8192, reasoning: false, input: ['text', 'image'], cost: { input: 0.00015, output: 0.0006, cacheRead: 0, cacheWrite: 0 } },
};

const DEFAULT_METADATA = {
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: false,
    input: ['text'],
    cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 }
};

// Claude models to include when Claude accounts are configured
// (model-discovery doesn't cover Claude OAuth accounts)
const CLAUDE_ACCOUNT_MODELS = [
    'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
    'claude-opus-4-6-1m', 'claude-sonnet-4-6-1m'
];

// Preferred default model order (first available wins)
const DEFAULT_MODEL_PREFERENCE = [
    'claude-sonnet-4-6', 'claude-opus-4-6',
    'gpt-5.4', 'gpt-5.3-codex', 'gpt-5.2',
    'gemini-2.5-pro'
];

function ensureOpenClawDir() {
    if (!existsSync(OPENCLAW_DIR)) {
        mkdirSync(OPENCLAW_DIR, { recursive: true });
    }
}

export function readOpenClawConfig() {
    if (!existsSync(OPENCLAW_CONFIG_FILE)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(OPENCLAW_CONFIG_FILE, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Check current proxy status from the config.
 */
export function getProxyStatus() {
    const config = readOpenClawConfig();
    if (!config) {
        return { installed: false, configured: false };
    }

    const provider = config.models?.providers?.[PROVIDER_ID];
    const primaryModel = config.agents?.defaults?.model?.primary || '';
    const isUsingProxy = primaryModel.startsWith(`${PROVIDER_ID}/`);

    return {
        installed: true,
        configured: !!provider,
        active: isUsingProxy,
        baseUrl: provider?.baseUrl || null,
        apiType: provider?.api || null,
        primaryModel,
        models: provider?.models?.map(m => m.id) || [],
        configPath: OPENCLAW_CONFIG_FILE
    };
}

/**
 * Build the model list dynamically from discovery data and Claude accounts.
 * Returns an array of OpenClaw model objects with metadata.
 */
function _buildModelList() {
    const seen = new Set();
    const models = [];

    function addModel(id) {
        if (seen.has(id)) return;
        seen.add(id);
        const meta = MODEL_METADATA[id] || { ...DEFAULT_METADATA, name: id };
        models.push({
            id,
            name: meta.name || id,
            reasoning: meta.reasoning,
            input: meta.input,
            contextWindow: meta.contextWindow,
            maxTokens: meta.maxTokens,
            cost: meta.cost
        });
    }

    // 1. Add Claude account models if any Claude accounts exist
    try {
        const { total } = listClaudeAccounts();
        if (total > 0) {
            for (const id of CLAUDE_ACCOUNT_MODELS) addModel(id);
        }
    } catch { /* no Claude accounts */ }

    // 2. Add models from discovery (ChatGPT accounts, API keys, etc.)
    const discovery = getDiscoveredModels();
    if (discovery.lastRun) {
        for (const data of Object.values(discovery.providers)) {
            for (const m of data.models || []) {
                addModel(m.id);
            }
        }
    }

    return models;
}

/**
 * Pick the best default model from available models.
 */
function _pickDefaultModel(models) {
    const ids = new Set(models.map(m => m.id));
    for (const preferred of DEFAULT_MODEL_PREFERENCE) {
        if (ids.has(preferred)) return preferred;
    }
    return models.length > 0 ? models[0].id : 'claude-sonnet-4-6';
}

/**
 * Set proxy mode: add proxypool provider and set it as default model.
 * Model list is built dynamically from discovery data and Claude accounts.
 */
export function setProxyMode(port) {
    ensureOpenClawDir();

    let config = readOpenClawConfig();
    if (!config) {
        config = {};
    }

    // Ensure nested structures exist
    if (!config.models) config.models = {};
    config.models.mode = 'merge';
    if (!config.models.providers) config.models.providers = {};
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};

    const baseUrl = `http://localhost:${port}`;
    const models = _buildModelList();
    const defaultModel = _pickDefaultModel(models);
    const previousModel = config.agents.defaults.model.primary || '';

    // Backup original config to our own file for restoration in setDirectMode
    if (!existsSync(BACKUP_FILE)) {
        if (!existsSync(PROXYPOOL_DIR)) mkdirSync(PROXYPOOL_DIR, { recursive: true });
        writeFileSync(BACKUP_FILE, JSON.stringify({
            primaryModel: previousModel,
            models: config.agents.defaults.models || null
        }), 'utf8');
    }

    // Set the custom provider — always use anthropic-messages API
    // (the proxy handles format conversion for all backends)
    config.models.providers[PROVIDER_ID] = {
        baseUrl,
        apiKey: 'sk-ant-proxy',
        api: 'anthropic-messages',
        models
    };

    // Set default model to use our provider
    config.agents.defaults.model.primary = `${PROVIDER_ID}/${defaultModel}`;

    // Set allowlist to ONLY proxy models so OpenClaw hides everything else
    config.agents.defaults.models = {};
    for (const m of models) {
        config.agents.defaults.models[`${PROVIDER_ID}/${m.id}`] = {};
    }

    writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    return {
        previousModel,
        baseUrl,
        apiType: 'anthropic-messages',
        defaultModel: `${PROVIDER_ID}/${defaultModel}`,
        models: models.map(m => `${PROVIDER_ID}/${m.id}`)
    };
}

/**
 * Remove proxy provider and restore original configuration.
 */
export function setDirectMode() {
    const config = readOpenClawConfig();
    if (!config) {
        return { success: false, message: 'OpenClaw config not found' };
    }

    // Remove the provider
    if (config.models?.providers?.[PROVIDER_ID]) {
        delete config.models.providers[PROVIDER_ID];
    }

    // Restore original allowlist and default model from backup file
    let backup = null;
    try {
        if (existsSync(BACKUP_FILE)) {
            backup = JSON.parse(readFileSync(BACKUP_FILE, 'utf8'));
        }
    } catch { /* corrupt backup, fall through */ }

    if (backup) {
        if (backup.models) {
            config.agents.defaults.models = backup.models;
        } else if (config.agents?.defaults) {
            delete config.agents.defaults.models;
        }
        config.agents.defaults.model.primary = backup.primaryModel || '';
        try { rmSync(BACKUP_FILE); } catch { /* ignore */ }
    } else {
        // No backup — clean up manually
        if (config.agents?.defaults?.models) {
            for (const key of Object.keys(config.agents.defaults.models)) {
                if (key.startsWith(`${PROVIDER_ID}/`)) {
                    delete config.agents.defaults.models[key];
                }
            }
        }
        if (config.agents?.defaults?.model?.primary?.startsWith(`${PROVIDER_ID}/`)) {
            config.agents.defaults.model.primary = '';
        }
    }

    writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    return { success: true };
}

export default { readOpenClawConfig, getProxyStatus, setProxyMode, setDirectMode };
