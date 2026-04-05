/**
 * Claude Account Manager
 * Manages multiple Claude accounts with token refresh
 * Mirrors account-manager.js pattern but for Claude OAuth accounts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { refreshAccessToken, fetchProfile } from './claude-oauth.js';

const CONFIG_DIR = join(homedir(), '.proxypool-hub');
const CLAUDE_ACCOUNTS_FILE = join(CONFIG_DIR, 'claude-accounts.json');
const CLAUDE_ACCOUNTS_DIR = join(CONFIG_DIR, 'claude-accounts');

const TOKEN_CHECK_INTERVAL_MS = 10 * 60 * 1000;  // Check every 10 minutes
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;    // Refresh when < 5 min left
const CLAUDE_CODE_CREDENTIALS_FILE = join(homedir(), '.claude', '.credentials.json');

const DEFAULT_ACCOUNTS = {
    accounts: [],
    activeAccount: null,
    version: 1
};

let autoRefreshIntervalId = null;
const tokenCache = new Map();
let accountsData = null;

function normalizeScopes(scopes) {
    if (Array.isArray(scopes)) return scopes.filter(Boolean);
    if (typeof scopes === 'string') {
        return scopes.split(/\s+/).map(scope => scope.trim()).filter(Boolean);
    }
    return [];
}

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(CLAUDE_ACCOUNTS_DIR)) {
        mkdirSync(CLAUDE_ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
    }
}

function sanitizeEmailForPath(email) {
    return email.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getAccountDir(email) {
    return join(CLAUDE_ACCOUNTS_DIR, sanitizeEmailForPath(email));
}

function loadAccounts() {
    if (accountsData !== null) {
        return accountsData;
    }

    ensureConfigDir();

    if (!existsSync(CLAUDE_ACCOUNTS_FILE)) {
        accountsData = { ...DEFAULT_ACCOUNTS };
        return accountsData;
    }

    try {
        const data = JSON.parse(readFileSync(CLAUDE_ACCOUNTS_FILE, 'utf8'));
        accountsData = { ...DEFAULT_ACCOUNTS, ...data };
        return accountsData;
    } catch (e) {
        console.error('[ClaudeAccountManager] Error loading accounts:', e.message);
        accountsData = { ...DEFAULT_ACCOUNTS };
        return accountsData;
    }
}

function saveAccounts(data) {
    ensureConfigDir();
    accountsData = data;
    writeFileSync(CLAUDE_ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function save() {
    if (accountsData === null) {
        loadAccounts();
    }
    ensureConfigDir();
    writeFileSync(CLAUDE_ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2), { mode: 0o600 });
}

function getAccount(email) {
    const data = loadAccounts();
    return data.accounts.find(a => a.email === email) || null;
}

function getActiveAccount() {
    const data = loadAccounts();
    if (!data.activeAccount) return null;
    return data.accounts.find(a => a.email === data.activeAccount) || null;
}

function setActiveAccount(email) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);

    if (!account) {
        return { success: false, message: `Claude account not found: ${email}` };
    }

    data.activeAccount = email;
    saveAccounts(data);

    return { success: true, message: `Switched to Claude account: ${email}` };
}

function removeAccount(email) {
    const data = loadAccounts();
    const index = data.accounts.findIndex(a => a.email === email);

    if (index < 0) {
        return { success: false, message: `Claude account not found: ${email}` };
    }

    const accountDir = getAccountDir(email);
    try {
        if (existsSync(accountDir)) {
            rmSync(accountDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('[ClaudeAccountManager] Failed to remove account directory:', e.message);
    }

    data.accounts.splice(index, 1);

    if (data.activeAccount === email) {
        data.activeAccount = data.accounts[0]?.email || null;
    }

    saveAccounts(data);

    return { success: true, message: `Claude account removed: ${email}` };
}

function toggleAccount(email, enabled) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);
    if (!account) {
        return { success: false, message: `Claude account not found: ${email}` };
    }
    account.enabled = enabled;
    saveAccounts(data);
    return { success: true, message: `Claude account ${email} ${enabled ? 'enabled' : 'disabled'}`, enabled };
}

function listAccounts() {
    const data = loadAccounts();

    const accounts = data.accounts.map(account => ({
        email: account.email,
        accountId: account.accountId,
        displayName: account.displayName,
        subscriptionType: account.subscriptionType || 'free',
        hasClaudePro: account.hasClaudePro || false,
        hasClaudeMax: account.hasClaudeMax || false,
        organizationName: account.organizationName || null,
        addedAt: account.addedAt,
        lastUsed: account.lastUsed,
        isActive: account.email === data.activeAccount,
        enabled: account.enabled !== false,
        tokenExpired: account.expiresAt ? account.expiresAt < Date.now() : false,
        hasProfileScope: normalizeScopes(account.scopes).includes('user:profile'),
        rateLimitTier: account.rateLimitTier || null
    }));

    return {
        accounts,
        activeAccount: data.activeAccount,
        total: accounts.length
    };
}

function isTokenExpiredOrExpiringSoon(account) {
    if (!account.expiresAt) return true;
    return Date.now() >= (account.expiresAt - TOKEN_EXPIRY_BUFFER_MS);
}

/**
 * Write refreshed tokens back to Claude Code's credentials file.
 * Only called for accounts with source === 'claude-code-import'.
 */
function _writeBackToClaudeCode(account) {
    try {
        if (!existsSync(CLAUDE_CODE_CREDENTIALS_FILE)) {
            console.warn('[ClaudeAccountManager] Claude Code credentials file not found, skip writeback');
            return;
        }

        const raw = JSON.parse(readFileSync(CLAUDE_CODE_CREDENTIALS_FILE, 'utf8'));
        const oauth = raw.claudeAiOauth;
        if (!oauth) return;

        // Update tokens while preserving Claude Code's own fields (subscriptionType, rateLimitTier, etc.)
        oauth.accessToken = account.accessToken;
        oauth.refreshToken = account.refreshToken;
        oauth.expiresAt = account.expiresAt;

        writeFileSync(CLAUDE_CODE_CREDENTIALS_FILE, JSON.stringify(raw), 'utf8');
        console.log(`[ClaudeAccountManager] Wrote back refreshed token to Claude Code credentials`);
    } catch (e) {
        console.warn(`[ClaudeAccountManager] Failed to write back to Claude Code: ${e.message}`);
    }
}

async function refreshAccountToken(email) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);

    if (!account) {
        return { success: false, message: `Claude account not found: ${email}` };
    }

    if (!account.refreshToken) {
        return { success: false, message: 'No refresh token available' };
    }

    try {
        const tokens = await refreshAccessToken(account.refreshToken);

        const index = data.accounts.findIndex(a => a.email === email);
        if (index >= 0) {
            data.accounts[index].accessToken = tokens.accessToken;
            data.accounts[index].refreshToken = tokens.refreshToken || data.accounts[index].refreshToken;
            data.accounts[index].expiresAt = tokens.expiresIn
                ? Date.now() + tokens.expiresIn * 1000
                : data.accounts[index].expiresAt;

            if (tokens.subscriptionType) {
                data.accounts[index].subscriptionType = tokens.subscriptionType;
            }

            saveAccounts(data);

            tokenCache.set(email, {
                token: tokens.accessToken,
                extractedAt: Date.now()
            });

            // Write back to Claude Code if this account was imported from there
            if (data.accounts[index].source === 'claude-code-import') {
                _writeBackToClaudeCode(data.accounts[index]);
            }
        }

        // Try to refresh profile info
        try {
            const profile = await fetchProfile(tokens.accessToken);
            if (profile && index >= 0) {
                data.accounts[index].subscriptionType = profile.subscriptionType || data.accounts[index].subscriptionType;
                data.accounts[index].hasClaudePro = profile.hasClaudePro;
                data.accounts[index].hasClaudeMax = profile.hasClaudeMax;
                data.accounts[index].organizationName = profile.organizationName;
                if (profile.displayName) {
                    data.accounts[index].displayName = profile.displayName;
                }
                saveAccounts(data);
            }
        } catch (profileErr) {
            console.warn(`[ClaudeAccountManager] Profile refresh failed for ${email}: ${profileErr.message}`);
        }

        console.log(`[ClaudeAccountManager] Token refreshed for: ${email}`);
        return { success: true, message: `Token refreshed for: ${email}` };
    } catch (error) {
        console.error(`[ClaudeAccountManager] Token refresh failed for ${email}:`, error.message);
        return { success: false, message: `Token refresh failed: ${error.message}` };
    }
}

async function refreshAllAccounts() {
    const data = loadAccounts();
    const results = [];

    for (const account of data.accounts) {
        if (account.refreshToken) {
            const result = await refreshAccountToken(account.email);
            results.push({ email: account.email, ...result });
        }
    }

    return results;
}

function startAutoRefresh() {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId);
    }

    // Initial check on startup (delayed 5s) — only refresh if expired or expiring soon
    setTimeout(() => _checkAndRefreshExpiring('startup'), 5000);

    // Periodic check every 10 minutes — only refresh tokens that are about to expire
    autoRefreshIntervalId = setInterval(() => _checkAndRefreshExpiring('periodic'), TOKEN_CHECK_INTERVAL_MS);

    console.log('[ClaudeAccountManager] Smart auto-refresh started (check every 10 min, refresh only when expiring)');
}

async function _checkAndRefreshExpiring(trigger) {
    const data = loadAccounts();
    for (const account of data.accounts) {
        if (!account.refreshToken || account.enabled === false) continue;

        if (isTokenExpiredOrExpiringSoon(account)) {
            const remainMs = account.expiresAt ? account.expiresAt - Date.now() : -1;
            const remainStr = remainMs > 0 ? `${Math.round(remainMs / 1000)}s left` : 'expired';
            console.log(`[ClaudeAccountManager] ${trigger}: refreshing ${account.email} (${remainStr})`);
            await refreshAccountToken(account.email);
        }
    }
}

function stopAutoRefresh() {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId);
        autoRefreshIntervalId = null;
        console.log('[ClaudeAccountManager] Auto-refresh stopped');
    }
}

function getCachedToken(email) {
    const cached = tokenCache.get(email);
    if (cached && (Date.now() - cached.extractedAt) < TOKEN_CHECK_INTERVAL_MS) {
        return cached.token;
    }
    return null;
}

function setCachedToken(email, token) {
    tokenCache.set(email, { token, extractedAt: Date.now() });
}

/**
 * Import Claude credentials from ~/.claude/.credentials.json
 * (Claude Code's credential file)
 */
function importFromClaudeCode() {
    const credentialsFile = join(homedir(), '.claude', '.credentials.json');

    try {
        if (!existsSync(credentialsFile)) {
            return { success: false, message: 'No Claude Code credentials file found (~/.claude/.credentials.json)' };
        }

        const raw = JSON.parse(readFileSync(credentialsFile, 'utf8'));
        const oauth = raw.claudeAiOauth;

        if (!oauth?.accessToken) {
            return { success: false, message: 'No valid OAuth tokens in Claude Code credentials' };
        }

        const expiresAt = oauth.expiresAt || null;
        const subscriptionType = oauth.subscriptionType || 'free';

        const newAccount = {
            email: 'imported@claude.ai',
            accountId: null,
            displayName: null,
            subscriptionType,
            rateLimitTier: oauth.rateLimitTier || null,
            hasClaudePro: false,
            hasClaudeMax: subscriptionType === 'max',
            organizationName: null,
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken || '',
            expiresAt,
            scopes: oauth.scopes || CLAUDE_OAUTH_CONFIG.scopes,
            addedAt: new Date().toISOString(),
            lastUsed: new Date().toISOString(),
            source: 'claude-code-import'
        };

        // Try to fetch profile to get email
        // (sync import, profile will be fetched on next refresh)

        const data = loadAccounts();
        const existingIndex = data.accounts.findIndex(a => a.source === 'claude-code-import');
        if (existingIndex >= 0) {
            data.accounts[existingIndex] = newAccount;
        } else {
            data.accounts.push(newAccount);
        }

        if (!data.activeAccount) {
            data.activeAccount = newAccount.email;
        }

        saveAccounts(data);

        return {
            success: true,
            message: `Imported Claude Code credentials (${subscriptionType})`
        };
    } catch (error) {
        return { success: false, message: `Import failed: ${error.message}` };
    }
}

/**
 * Import from ~/.claude/.account.json (profile data)
 * Enriches an existing imported account with profile info
 */
async function enrichWithProfile(email) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);
    if (!account || !account.accessToken) return;

    const profile = await fetchProfile(account.accessToken);
    if (!profile) return;

    const index = data.accounts.findIndex(a => a.email === email);
    if (index < 0) return;

    if (profile.email && profile.email !== email) {
        data.accounts[index].email = profile.email;
        if (data.activeAccount === email) {
            data.activeAccount = profile.email;
        }
    }

    data.accounts[index].accountId = profile.accountId;
    data.accounts[index].displayName = profile.displayName;
    data.accounts[index].subscriptionType = profile.subscriptionType;
    data.accounts[index].hasClaudePro = profile.hasClaudePro;
    data.accounts[index].hasClaudeMax = profile.hasClaudeMax;
    data.accounts[index].organizationName = profile.organizationName;

    saveAccounts(data);
    console.log(`[ClaudeAccountManager] Profile enriched for: ${data.accounts[index].email}`);
}

function getStatus() {
    const data = loadAccounts();
    const accounts = data.accounts.map(a => ({
        email: a.email,
        displayName: a.displayName,
        subscriptionType: a.subscriptionType || 'free',
        isActive: a.email === data.activeAccount,
        tokenExpired: a.expiresAt ? a.expiresAt < Date.now() : false,
        lastUsed: a.lastUsed
    }));

    return {
        total: data.accounts.length,
        active: data.activeAccount,
        accounts
    };
}

function ensureAccountsPersist() {
    const data = loadAccounts();
    if (data.accounts.length > 0 && data.activeAccount) {
        const active = data.accounts.find(a => a.email === data.activeAccount);
        if (active) {
            console.log(`[ClaudeAccountManager] Restored active Claude account: ${active.email}`);
        }
    }
}

export {
    loadAccounts,
    saveAccounts,
    save,
    getAccount,
    getActiveAccount,
    setActiveAccount,
    removeAccount,
    toggleAccount,
    listAccounts,
    refreshAccountToken,
    refreshAllAccounts,
    importFromClaudeCode,
    enrichWithProfile,
    getStatus,
    ensureAccountsPersist,
    startAutoRefresh,
    stopAutoRefresh,
    isTokenExpiredOrExpiringSoon,
    getCachedToken,
    setCachedToken,
    TOKEN_CHECK_INTERVAL_MS,
    CLAUDE_ACCOUNTS_FILE,
    CONFIG_DIR
};

export default {
    getActiveAccount,
    setActiveAccount,
    removeAccount,
    toggleAccount,
    listAccounts,
    refreshAccountToken,
    refreshAllAccounts,
    importFromClaudeCode,
    enrichWithProfile,
    getStatus,
    ensureAccountsPersist,
    startAutoRefresh,
    stopAutoRefresh,
    isTokenExpiredOrExpiringSoon,
    getCachedToken,
    setCachedToken,
    save,
    getAccount
};
