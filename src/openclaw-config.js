/**
 * OpenClaw Configuration Utility
 * Reads and writes ~/.openclaw/openclaw.json to configure OpenClaw
 * to use ProxyPool Hub as a custom model provider.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const OPENCLAW_CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');

const PROVIDER_ID = 'proxypool';

const ANTHROPIC_MODELS = [
    {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 32768,
        cost: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 }
    },
    {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 16384,
        cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 }
    },
    {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        reasoning: false,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 8192,
        cost: { input: 0.0008, output: 0.004, cacheRead: 0.00008, cacheWrite: 0.001 }
    }
];

const OPENAI_MODELS = [
    {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 }
    },
    {
        id: 'gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        reasoning: true,
        input: ['text'],
        contextWindow: 192000,
        maxTokens: 32768,
        cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 }
    },
    {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6 (via proxy)',
        reasoning: true,
        input: ['text', 'image'],
        contextWindow: 200000,
        maxTokens: 16384,
        cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 }
    }
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
 * Set proxy mode: add proxypool provider and set it as default model.
 */
export function setProxyMode(port, { apiType = 'anthropic-messages' } = {}) {
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

    const models = apiType === 'anthropic-messages'
        ? ANTHROPIC_MODELS
        : OPENAI_MODELS;

    const defaultModel = apiType === 'anthropic-messages'
        ? 'claude-sonnet-4-6'
        : 'gpt-5.2';

    // Set the custom provider (store previousModel inside provider entry to avoid unknown-key config errors)
    config.models.providers[PROVIDER_ID] = {
        baseUrl,
        apiKey: 'sk-ant-proxy',
        api: apiType,
        models,
        _previousModel: (!previousModel.startsWith(`${PROVIDER_ID}/`)) ? previousModel : (config.models.providers[PROVIDER_ID]?._previousModel || '')
    };

    // Save previous model for later restoration (stored inside the provider entry to avoid unknown-key errors)
    const previousModel = config.agents.defaults.model.primary || '';

    // Set default model to use our provider
    config.agents.defaults.model.primary = `${PROVIDER_ID}/${defaultModel}`;

    // Add models to allowlist only if user already has an allowlist
    const existingAllowlist = config.agents.defaults.models;
    if (existingAllowlist && Object.keys(existingAllowlist).length > 0) {
        for (const m of models) {
            if (!existingAllowlist[`${PROVIDER_ID}/${m.id}`]) {
                existingAllowlist[`${PROVIDER_ID}/${m.id}`] = {};
            }
        }
    }

    writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    return {
        previousModel,
        baseUrl,
        apiType,
        defaultModel: `${PROVIDER_ID}/${defaultModel}`,
        models: models.map(m => `${PROVIDER_ID}/${m.id}`)
    };
}

/**
 * Remove proxy provider and restore previous model.
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

    // Remove model entries from allowlist
    if (config.agents?.defaults?.models) {
        for (const key of Object.keys(config.agents.defaults.models)) {
            if (key.startsWith(`${PROVIDER_ID}/`)) {
                delete config.agents.defaults.models[key];
            }
        }
    }

    // Restore previous model if currently using our provider
    if (config.agents?.defaults?.model?.primary?.startsWith(`${PROVIDER_ID}/`)) {
        const savedModel = config.models?.providers?.[PROVIDER_ID]?._previousModel;
        config.agents.defaults.model.primary = savedModel || '';
    }

    writeFileSync(OPENCLAW_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    return { success: true };
}

export default { readOpenClawConfig, getProxyStatus, setProxyMode, setDirectMode };
