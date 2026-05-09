import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';
import { createDefaultAppRouting, normalizeAppRoutingConfig } from './app-routing.js';
import { normalizeStrategyName } from './account-rotation/strategies/index.js';

const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
    haikuKiloModel: 'minimax/minimax-m2.5:free',
    accountStrategy: 'sequential',
    routingPriority: 'account-first',   // 'account-first' | 'apikey-first'
    routingMode: 'automatic',           // 'automatic' | 'app-assigned'
    localModelRoutingEnabled: false,    // Enable local runtime routing (default off)
    strictCodexCompatibility: true,
    strictTranslatorCompatibility: false,
    appRouting: createDefaultAppRouting(),
    antigravityEnabled: true,
    enableFreeModels: true,              // Allow routing to system free models (Kilo)
    enableRequestLogging: true,          // Log full request/response content
    requestLogRetentionDays: 7,          // Days to keep request logs
    assistantAgent: {
        enabled: true,
        bindingConfigured: false,
        boundModelSource: null,
        // New (preferred) shape. boundCredential = null means "supervisor not
        // configured"; the runtime falls back to the deterministic runner.
        boundCredential: null,
        fallbacks: [],
        circuitBreaker: {
            failureThreshold: 3,
            probeIntervalMs: 300_000
        },
        // Legacy toggle-based config kept as a read-only migration source. The
        // runtime resolves the first available credential per the old priority
        // order on first call and rewrites this into `boundCredential`. Fresh
        // installs leave this populated as the default so existing setups keep
        // working until the user explicitly picks a binding.
        sources: {
            chatgptAccount: false,
            claudeAccount: false,
            anthropicApiKey: false,
            openaiApiKeyBridge: false,
            azureOpenaiApiKeyBridge: false
        }
    },
    channels: {
        telegram: {
            enabled: false,
            mode: 'polling',
            botToken: '',
            pollingIntervalMs: 2000,
            defaultRuntimeProvider: 'codex',
            cwd: '',
            requirePairing: false
        },
        feishu: {
            enabled: false,
            mode: 'websocket',
            appId: '',
            appSecret: '',
            encryptKey: '',
            verificationToken: '',
            defaultRuntimeProvider: 'codex',
            cwd: '',
            requirePairing: false
        },
        dingtalk: {
            enabled: false,
            mode: 'stream',
            appKey: '',
            appSecret: '',
            clientId: '',
            clientSecret: '',
            robotCode: '',
            signingSecret: '',
            defaultRuntimeProvider: 'codex',
            cwd: '',
            requirePairing: false
        }
    }
};

function slugifyChannelInstanceId(value, fallback = 'default') {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || fallback;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function sanitizeLegacyChannelInstance(instance = {}) {
    if (!instance || typeof instance !== 'object') {
        return {};
    }
    const { model: _legacyModel, ...sanitized } = instance;
    return sanitized;
}

function buildDefaultChannelInstance(channelId, overrides = {}, index = 0) {
    const base = {
        id: index === 0 ? 'default' : `${slugifyChannelInstanceId(channelId, channelId)}-${index + 1}`,
        label: index === 0 ? 'Default' : `Instance ${index + 1}`,
        ...clone(DEFAULT_SETTINGS.channels[channelId] || {}),
        ...sanitizeLegacyChannelInstance(overrides || {})
    };

    return {
        ...base,
        id: slugifyChannelInstanceId(base.id, index === 0 ? 'default' : `${slugifyChannelInstanceId(channelId, channelId)}-${index + 1}`),
        label: String(base.label || (index === 0 ? 'Default' : `Instance ${index + 1}`))
    };
}

function normalizeChannelProviderConfig(channelId, config = {}) {
    const base = clone(DEFAULT_SETTINGS.channels[channelId] || {});
    const current = config && typeof config === 'object'
        ? sanitizeLegacyChannelInstance(config)
        : {};
    const instancesSource = Array.isArray(current.instances)
        ? current.instances
        : [current];

    const normalizedInstances = instancesSource.map((instance, index) =>
        buildDefaultChannelInstance(channelId, {
            ...base,
            ...sanitizeLegacyChannelInstance(instance || {})
        }, index)
    );

    if (normalizedInstances.length === 0) {
        normalizedInstances.push(buildDefaultChannelInstance(channelId, base, 0));
    }

    return {
        instances: normalizedInstances
    };
}

function normalizeChannelsConfig(channels = {}) {
    return {
        telegram: normalizeChannelProviderConfig('telegram', channels.telegram),
        feishu: normalizeChannelProviderConfig('feishu', channels.feishu),
        dingtalk: normalizeChannelProviderConfig('dingtalk', channels.dingtalk)
    };
}

const ASSISTANT_CREDENTIAL_TYPES = new Set(['api-key', 'chatgpt-account', 'claude-account']);
const ASSISTANT_FALLBACKS_MAX = 3;
const ASSISTANT_BREAKER_DEFAULTS = Object.freeze({
    failureThreshold: 3,
    probeIntervalMs: 300_000
});
const ASSISTANT_BREAKER_BOUNDS = Object.freeze({
    failureThresholdMin: 1,
    failureThresholdMax: 10,
    probeIntervalMsMin: 60_000,        // 1 minute
    probeIntervalMsMax: 3_600_000      // 60 minutes
});

function normalizeBoundCredential(value) {
    if (!value || typeof value !== 'object') return null;
    const type = String(value.type || '').trim();
    const id = String(value.id || '').trim();
    if (!ASSISTANT_CREDENTIAL_TYPES.has(type) || !id) return null;
    const model = typeof value.model === 'string' && value.model.trim()
        ? value.model.trim()
        : '';
    return model ? { type, id, model } : { type, id };
}

function normalizeFallbacks(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const entry of value) {
        const normalized = normalizeBoundCredential(entry);
        if (!normalized) continue;
        const key = `${normalized.type}::${normalized.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(normalized);
        if (result.length >= ASSISTANT_FALLBACKS_MAX) break;
    }
    return result;
}

function clampNumber(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(Math.floor(n), min), max);
}

function normalizeCircuitBreaker(value) {
    const v = value && typeof value === 'object' ? value : {};
    return {
        failureThreshold: clampNumber(
            v.failureThreshold,
            ASSISTANT_BREAKER_DEFAULTS.failureThreshold,
            ASSISTANT_BREAKER_BOUNDS.failureThresholdMin,
            ASSISTANT_BREAKER_BOUNDS.failureThresholdMax
        ),
        probeIntervalMs: clampNumber(
            v.probeIntervalMs,
            ASSISTANT_BREAKER_DEFAULTS.probeIntervalMs,
            ASSISTANT_BREAKER_BOUNDS.probeIntervalMsMin,
            ASSISTANT_BREAKER_BOUNDS.probeIntervalMsMax
        )
    };
}

function normalizeAssistantAgentConfig(config = {}) {
    const current = config && typeof config === 'object' ? config : {};
    const sources = current.sources && typeof current.sources === 'object'
        ? current.sources
        : {};
    const boundModelSource = normalizeBoundCredential(current.boundModelSource || current.boundCredential);
    const fallbacks = normalizeFallbacks(current.fallbacks);

    return {
        enabled: current.enabled === true,
        bindingConfigured: current.bindingConfigured === true || !!boundModelSource || fallbacks.length > 0,
        boundModelSource,
        boundCredential: boundModelSource,
        fallbacks,
        circuitBreaker: normalizeCircuitBreaker(current.circuitBreaker),
        // Legacy field — kept for one-time runtime migration. Fresh installs
        // populate this from DEFAULT_SETTINGS; once `boundCredential` is set
        // the migration step in llm-client.js leaves `sources` in place but
        // ignores it. Existing route handlers still read this field.
        sources: {
            chatgptAccount: sources.chatgptAccount === true,
            claudeAccount: sources.claudeAccount === true,
            anthropicApiKey: sources.anthropicApiKey !== false,
            openaiApiKeyBridge: sources.openaiApiKeyBridge !== false,
            azureOpenaiApiKeyBridge: sources.azureOpenaiApiKeyBridge !== false
        }
    };
}

export {
    normalizeAssistantAgentConfig,
    normalizeBoundCredential,
    normalizeFallbacks,
    normalizeCircuitBreaker,
    ASSISTANT_CREDENTIAL_TYPES,
    ASSISTANT_FALLBACKS_MAX,
    ASSISTANT_BREAKER_DEFAULTS,
    ASSISTANT_BREAKER_BOUNDS
};

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
}

export function getServerSettings() {
    ensureConfigDir();

    if (!existsSync(SETTINGS_FILE)) {
        return { ...DEFAULT_SETTINGS };
    }

    try {
        const data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
        return {
            ...DEFAULT_SETTINGS,
            ...data,
            accountStrategy: normalizeStrategyName(data.accountStrategy),
            appRouting: normalizeAppRoutingConfig(data.appRouting),
            assistantAgent: normalizeAssistantAgentConfig(data.assistantAgent),
            channels: normalizeChannelsConfig(data.channels)
        };
    } catch (error) {
        console.error('[ServerSettings] Failed to read settings:', error.message);
        return { ...DEFAULT_SETTINGS };
    }
}

export function setServerSettings(patch = {}) {
    const current = getServerSettings();
    const next = {
        ...current,
        ...patch,
        accountStrategy: normalizeStrategyName(patch.accountStrategy ?? current.accountStrategy),
        appRouting: normalizeAppRoutingConfig(patch.appRouting || current.appRouting),
        assistantAgent: normalizeAssistantAgentConfig(patch.assistantAgent || current.assistantAgent),
        channels: normalizeChannelsConfig(patch.channels || current.channels)
    };

    ensureConfigDir();
    writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
}

export { SETTINGS_FILE };
export { normalizeChannelsConfig };

export default {
    getServerSettings,
    setServerSettings,
    SETTINGS_FILE,
    normalizeChannelsConfig
};
