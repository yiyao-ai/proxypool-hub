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
        sources: {
            chatgptAccount: false,
            claudeAccount: false,
            anthropicApiKey: true,
            openaiApiKeyBridge: true,
            azureOpenaiApiKeyBridge: true
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

function normalizeAssistantAgentConfig(config = {}) {
    const current = config && typeof config === 'object' ? config : {};
    const sources = current.sources && typeof current.sources === 'object'
        ? current.sources
        : {};

    return {
        enabled: current.enabled === true,
        sources: {
            chatgptAccount: sources.chatgptAccount === true,
            claudeAccount: sources.claudeAccount === true,
            anthropicApiKey: sources.anthropicApiKey !== false,
            openaiApiKeyBridge: sources.openaiApiKeyBridge !== false,
            azureOpenaiApiKeyBridge: sources.azureOpenaiApiKeyBridge !== false
        }
    };
}

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
