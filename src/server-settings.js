import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';
import { createDefaultAppRouting, normalizeAppRoutingConfig } from './app-routing.js';

const SETTINGS_FILE = join(CONFIG_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
    haikuKiloModel: 'minimax/minimax-m2.5:free',
    accountStrategy: 'sticky',
    routingPriority: 'account-first',   // 'account-first' | 'apikey-first'
    routingMode: 'automatic',           // 'automatic' | 'app-assigned'
    appRouting: createDefaultAppRouting(),
    enableFreeModels: true,              // Allow routing to system free models (Kilo)
    enableRequestLogging: true,          // Log full request/response content
    requestLogRetentionDays: 7           // Days to keep request logs
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
            appRouting: normalizeAppRoutingConfig(data.appRouting)
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
        appRouting: normalizeAppRoutingConfig(patch.appRouting || current.appRouting)
    };

    ensureConfigDir();
    writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
}

export { SETTINGS_FILE };

export default {
    getServerSettings,
    setServerSettings,
    SETTINGS_FILE
};
