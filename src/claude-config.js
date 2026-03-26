/**
 * Claude CLI Configuration Utility
 * Handles reading and writing to the global Claude CLI settings file.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';

export function getClaudeConfigPath() {
    const configDir = process.env.CLAUDE_CONFIG_PATH;
    if (configDir) {
        return path.join(configDir, 'settings.json');
    }
    return path.join(os.homedir(), '.claude', 'settings.json');
}

export function readClaudeConfigSync() {
    const configPath = getClaudeConfigPath();
    try {
        if (!fsSync.existsSync(configPath)) {
            return { env: {} };
        }
        const content = fsSync.readFileSync(configPath, 'utf8');
        if (!content.trim()) return { env: {} };
        return JSON.parse(content);
    } catch (error) {
        console.error('[ClaudeConfig] Error reading config:', error.message);
        return { env: {} };
    }
}

export async function readClaudeConfig() {
    const configPath = getClaudeConfigPath();
    try {
        const content = await fs.readFile(configPath, 'utf8');
        if (!content.trim()) return { env: {} };
        return JSON.parse(content);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { env: {} };
        }
        console.error('[ClaudeConfig] Error reading config:', error.message);
        return { env: {} };
    }
}

export async function updateClaudeConfig(updates) {
    const configPath = getClaudeConfigPath();
    let currentConfig = {};
    
    try {
        currentConfig = await readClaudeConfig();
    } catch (error) {
        // Ignore
    }
    
    const newConfig = deepMerge(currentConfig, updates);
    
    const configDir = path.dirname(configPath);
    try {
        await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
    } catch (error) {
        // Ignore if exists
    }
    
    try {
        await fs.writeFile(configPath, JSON.stringify(newConfig, null, 2), { encoding: 'utf8', mode: 0o600 });
        console.log(`[ClaudeConfig] Updated config at ${configPath}`);
        return newConfig;
    } catch (error) {
        console.error('[ClaudeConfig] Failed to write config:', error.message);
        throw error;
    }
}

export async function setProxyMode(proxyUrl, models = {}) {
    const updates = {
        env: {
            ANTHROPIC_BASE_URL: proxyUrl,
            ANTHROPIC_API_KEY: 'sk-ant-proxy',
            ANTHROPIC_AUTH_TOKEN: undefined, // Explicitly unset to avoid conflict
            ANTHROPIC_MODEL: models.default || 'claude-sonnet-4-6',
            ANTHROPIC_DEFAULT_OPUS_MODEL: models.opus || 'claude-opus-4-6',
            ANTHROPIC_DEFAULT_SONNET_MODEL: models.sonnet || 'claude-sonnet-4-6',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: models.haiku || 'claude-haiku-4-5'
        }
    };
    
    return await updateClaudeConfig(updates);
}

export async function setDirectMode(apiKey) {
    const updates = {
        env: {
            ANTHROPIC_AUTH_TOKEN: undefined,
            ANTHROPIC_BASE_URL: undefined,
            ANTHROPIC_MODEL: undefined,
            ANTHROPIC_DEFAULT_OPUS_MODEL: undefined,
            ANTHROPIC_DEFAULT_SONNET_MODEL: undefined,
            ANTHROPIC_DEFAULT_HAIKU_MODEL: undefined
        }
    };
    if (apiKey) {
        updates.env.ANTHROPIC_API_KEY = apiKey;
    } else {
        updates.env.ANTHROPIC_API_KEY = undefined;
    }

    return await updateClaudeConfig(updates);
}

export async function setApiEndpoint({ apiUrl, apiKey }) {
    const updates = {
        env: {
            ANTHROPIC_BASE_URL: apiUrl,
            ANTHROPIC_API_KEY: apiKey
        }
    };

    return await updateClaudeConfig(updates);
}

function deepMerge(target, source) {
    const output = { ...target };
    
    if (isObject(target) && isObject(source)) {
        Object.keys(source).forEach(key => {
            if (source[key] === undefined) {
                // Remove keys if explicitly set to undefined
                delete output[key];
            } else if (isObject(source[key])) {
                if (!(key in target)) {
                    Object.assign(output, { [key]: source[key] });
                } else {
                    output[key] = deepMerge(target[key], source[key]);
                }
            } else {
                Object.assign(output, { [key]: source[key] });
            }
        });
    }
    
    return output;
}

function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
}

export default {
    getClaudeConfigPath,
    readClaudeConfig,
    readClaudeConfigSync,
    updateClaudeConfig,
    setProxyMode,
    setDirectMode,
    setApiEndpoint
};
