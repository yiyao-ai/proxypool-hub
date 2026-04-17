/**
 * Codex Config Route
 * Handles Codex CLI configuration:
 *   POST /codex/config/proxy  — Configure Codex CLI to use this proxy
 *   GET  /codex/config        — Show current Codex config status
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getActiveAccount } from '../account-manager.js';
import { logger } from '../utils/logger.js';
import {
    CODEX_CONFIG_FILE,
    CODEX_DIR,
    ensureCodexRuntimeCompatibility,
    getCodexRuntimeCompatibilityStatus,
    readCodexConfig
} from '../codex-runtime-config.js';

const CODEX_AUTH_FILE = join(CODEX_DIR, 'auth.json');

function ensureCodexDir() {
    if (!existsSync(CODEX_DIR)) {
        mkdirSync(CODEX_DIR, { recursive: true });
    }
}

/**
 * POST /codex/config/proxy
 * 1. Sets chatgpt_base_url in config.toml
 * 2. Writes auth.json with a pool account's token (so Codex skips login)
 */
export async function handleSetCodexProxy(req, res, { port }) {
    const chatgptBaseUrl = `http://localhost:${port}/backend-api/`;
    const openaiBaseUrl = `http://localhost:${port}`;

    try {
        ensureCodexDir();

        // --- Update config.toml ---
        let configContent = '';
        if (existsSync(CODEX_CONFIG_FILE)) {
            configContent = readFileSync(CODEX_CONFIG_FILE, 'utf8');
        }

        // Set chatgpt_base_url
        if (/^chatgpt_base_url\s*=/m.test(configContent)) {
            configContent = configContent.replace(
                /^chatgpt_base_url\s*=\s*"[^"]*"/m,
                `chatgpt_base_url = "${chatgptBaseUrl}"`
            );
        } else {
            const lines = configContent.split('\n');
            let insertIdx = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('[')) break;
                insertIdx = i + 1;
            }
            lines.splice(insertIdx, 0, `chatgpt_base_url = "${chatgptBaseUrl}"`);
            configContent = lines.join('\n');
        }

        // Set openai_base_url (this is where /v1/responses calls go)
        if (/^openai_base_url\s*=/m.test(configContent)) {
            configContent = configContent.replace(
                /^openai_base_url\s*=\s*"[^"]*"/m,
                `openai_base_url = "${openaiBaseUrl}"`
            );
        } else {
            const lines = configContent.split('\n');
            let insertIdx = 0;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('[')) break;
                insertIdx = i + 1;
            }
            lines.splice(insertIdx, 0, `openai_base_url = "${openaiBaseUrl}"`);
            configContent = lines.join('\n');
        }

        writeFileSync(CODEX_CONFIG_FILE, configContent);
        logger.info(`[CodexConfig] Updated config.toml: chatgpt_base_url = "${chatgptBaseUrl}"`);

        const runtimeConfig = ensureCodexRuntimeCompatibility();

        // --- Write auth.json from pool account ---
        const account = getActiveAccount();
        if (!account) {
            return res.json({
                success: true,
                warning: 'Config updated but no accounts in pool. Add accounts first, then run this again.',
                config_updated: true,
                auth_updated: false,
                runtime_compatibility_updated: runtimeConfig.updated,
                compatibility: runtimeConfig.compatibility
            });
        }

        const authJson = {
            auth_mode: 'chatgpt',
            OPENAI_API_KEY: null,
            tokens: {
                id_token: account.idToken,
                access_token: account.accessToken,
                refresh_token: account.refreshToken,
                account_id: account.accountId
            },
            last_refresh: new Date().toISOString()
        };

        writeFileSync(CODEX_AUTH_FILE, JSON.stringify(authJson, null, 2));
        logger.info(`[CodexConfig] Updated auth.json with account: ${account.email}`);

        res.json({
            success: true,
            message: `Codex CLI configured to use proxy at ${openaiBaseUrl}`,
            config_updated: true,
            auth_updated: true,
            runtime_compatibility_updated: runtimeConfig.updated,
            compatibility: runtimeConfig.compatibility,
            account: account.email,
            config_path: CODEX_CONFIG_FILE,
            auth_path: CODEX_AUTH_FILE
        });
    } catch (error) {
        logger.error(`[CodexConfig] Failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * GET /codex/config
 * Shows current Codex CLI configuration status.
 */
export function handleGetCodexConfig(req, res) {
    const result = {
        codex_dir: CODEX_DIR,
        config_exists: existsSync(CODEX_CONFIG_FILE),
        auth_exists: existsSync(CODEX_AUTH_FILE),
        chatgpt_base_url: null,
        auth_mode: null
    };

    if (result.config_exists) {
        try {
            const content = readCodexConfig(CODEX_CONFIG_FILE);
            const match = content.match(/^chatgpt_base_url\s*=\s*"([^"]*)"/m);
            result.chatgpt_base_url = match ? match[1] : null;
            result.compatibility = getCodexRuntimeCompatibilityStatus(content);
        } catch { /* ignore */ }
    }

    if (result.auth_exists) {
        try {
            const auth = JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf8'));
            result.auth_mode = auth.auth_mode || null;
        } catch { /* ignore */ }
    }

    res.json(result);
}

/**
 * POST /codex/config/direct
 * Removes proxy config, restores direct ChatGPT connection.
 */
export function handleSetCodexDirect(req, res) {
    try {
        if (existsSync(CODEX_CONFIG_FILE)) {
            let content = readFileSync(CODEX_CONFIG_FILE, 'utf8');
            content = content.replace(/^chatgpt_base_url\s*=\s*"[^"]*"\n?/m, '');
            content = content.replace(/^openai_base_url\s*=\s*"[^"]*"\n?/m, '');
            writeFileSync(CODEX_CONFIG_FILE, content);
        }

        res.json({
            success: true,
            message: 'Codex CLI restored to direct ChatGPT connection'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export default { handleSetCodexProxy, handleGetCodexConfig, handleSetCodexDirect };
