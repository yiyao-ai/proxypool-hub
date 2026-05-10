/**
 * Account Manager
 * Manages multiple ChatGPT accounts with manual switching
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { refreshAccessToken, extractAccountInfo } from './oauth.js';
import { getAccountQuota as fetchQuota } from './model-api.js';

const CONFIG_DIR = process.env.CLIGATE_CONFIG_DIR
    ? process.env.CLIGATE_CONFIG_DIR
    : join(homedir(), '.cligate');
const ACCOUNTS_FILE = join(CONFIG_DIR, 'accounts.json');
const ACCOUNTS_DIR = join(CONFIG_DIR, 'accounts');

const TOKEN_CHECK_INTERVAL_MS = 10 * 60 * 1000;  // Check every 10 minutes
const AUTO_REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Low-frequency fallback check every 6 hours
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;    // Refresh when < 5 min left
const CODEX_AUTH_FILE = process.env.CLIGATE_CODEX_AUTH_FILE
    ? process.env.CLIGATE_CODEX_AUTH_FILE
    : join(homedir(), '.codex', 'auth.json');

const DEFAULT_ACCOUNTS = {
    accounts: [],
    activeAccount: null,
    version: 1
};

let autoRefreshIntervalId = null;
const tokenCache = new Map();
const refreshInFlight = new Map();
let accountsData = null;

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(ACCOUNTS_DIR)) {
        mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
    }
}

function sanitizeEmailForPath(email) {
    return email.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getAccountDir(email) {
    const safeEmail = sanitizeEmailForPath(email);
    return join(ACCOUNTS_DIR, safeEmail);
}

function getAccountAuthFile(email) {
    return join(getAccountDir(email), 'auth.json');
}

function _readAccountsFromDisk() {
    ensureConfigDir();

    if (!existsSync(ACCOUNTS_FILE)) {
        return { ...DEFAULT_ACCOUNTS };
    }

    try {
        const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
        return { ...DEFAULT_ACCOUNTS, ...data };
    } catch (e) {
        console.error('[AccountManager] Error loading accounts:', e.message);
        return { ...DEFAULT_ACCOUNTS };
    }
}

function reloadAccounts() {
    accountsData = _readAccountsFromDisk();
    return accountsData;
}

function loadAccounts() {
    if (accountsData !== null) {
        return accountsData;
    }

    accountsData = _readAccountsFromDisk();
    return accountsData;
}

function saveAccounts(data) {
    ensureConfigDir();
    accountsData = data;
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function save() {
    if (accountsData === null) {
        loadAccounts();
    }
    ensureConfigDir();
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(accountsData, null, 2), { mode: 0o600 });
}

function _isPermanentRefreshFailureCode(code) {
    return code === 'refresh_token_reused'
        || code === 'refresh_token_expired'
        || code === 'refresh_token_invalidated';
}

function _setRefreshFailure(data, index, code, message) {
    data.accounts[index].refreshFailure = {
        code,
        message,
        failedAt: new Date().toISOString(),
        refreshToken: data.accounts[index].refreshToken || null
    };
    saveAccounts(data);
}

function _clearRefreshFailure(data, index) {
    if (data.accounts[index].refreshFailure) {
        delete data.accounts[index].refreshFailure;
    }
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

function updateAccountAuth(account) {
    if (!account) return;
    
    const accountDir = getAccountDir(account.email);
    const authFile = getAccountAuthFile(account.email);
    
    if (!existsSync(accountDir)) {
        mkdirSync(accountDir, { recursive: true, mode: 0o700 });
    }
    
    const authData = {
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
    
    try {
        writeFileSync(authFile, JSON.stringify(authData, null, 2), { mode: 0o600 });
        console.log(`[AccountManager] Updated auth for: ${account.email}`);
    } catch (e) {
        console.error('[AccountManager] Failed to update auth:', e.message);
    }
}

function setActiveAccount(email) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);
    
    if (!account) {
        return { success: false, message: `Account not found: ${email}` };
    }
    
    data.activeAccount = email;
    saveAccounts(data);
    
    updateAccountAuth(account);
    
    return { success: true, message: `Switched to account: ${email}` };
}

function removeAccount(email) {
    const data = loadAccounts();
    const index = data.accounts.findIndex(a => a.email === email);
    
    if (index < 0) {
        return { success: false, message: `Account not found: ${email}` };
    }
    
    const accountDir = getAccountDir(email);
    try {
        if (existsSync(accountDir)) {
            rmSync(accountDir, { recursive: true, force: true });
        }
    } catch (e) {
        console.error('[AccountManager] Failed to remove account directory:', e.message);
    }
    
    data.accounts.splice(index, 1);
    
    if (data.activeAccount === email) {
        data.activeAccount = data.accounts[0]?.email || null;
        
        if (data.activeAccount) {
            const newActive = data.accounts.find(a => a.email === data.activeAccount);
            updateAccountAuth(newActive);
        }
    }
    
    saveAccounts(data);
    
    return { success: true, message: `Account removed: ${email}` };
}

function toggleAccount(email, enabled) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);
    if (!account) {
        return { success: false, message: `Account not found: ${email}` };
    }
    account.enabled = enabled;
    saveAccounts(data);
    return { success: true, message: `Account ${email} ${enabled ? 'enabled' : 'disabled'}`, enabled };
}

function listAccounts() {
    const data = loadAccounts();

    const accounts = data.accounts.map(account => {
        const info = extractAccountInfo(account.accessToken);
        return {
            email: account.email,
            accountId: account.accountId,
            planType: info?.planType || account.planType || 'unknown',
            addedAt: account.addedAt,
            lastUsed: account.lastUsed,
            isActive: account.email === data.activeAccount,
            enabled: account.enabled !== false,
            tokenExpired: info?.expiresAt ? info.expiresAt < Date.now() : false,
            quota: account.quota || null,
            refreshFailure: account.refreshFailure || null
        };
    });
    
    return {
        accounts,
        activeAccount: data.activeAccount,
        total: accounts.length
    };
}

function updateAccountQuota(email, quotaData) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);
    
    if (!account) {
        return { success: false, message: `Account not found: ${email}` };
    }
    
    account.quota = {
        ...quotaData,
        lastChecked: new Date().toISOString()
    };
    
    saveAccounts(data);
    return { success: true, message: `Quota updated for: ${email}` };
}

function getAccountQuota(email) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);
    
    if (!account) {
        return null;
    }
    
    return account.quota || null;
}

function _derivePlanTypeFromQuota(quotaData, fallbackPlanType = 'unknown') {
    const usagePlan = quotaData?.usage?.planType;
    if (usagePlan) return usagePlan;

    const defaultAccountId = quotaData?.account?.default_account_id;
    const matchedAccount = quotaData?.account?.accounts?.find(acc =>
        acc?.id && defaultAccountId && acc.id === defaultAccountId
    );
    if (matchedAccount?.plan_type) return matchedAccount.plan_type;

    const firstAccountPlan = quotaData?.account?.accounts?.find(acc => acc?.plan_type)?.plan_type;
    if (firstAccountPlan) return firstAccountPlan;

    return fallbackPlanType;
}

function isTokenExpiredOrExpiringSoon(account) {
    if (!account.expiresAt) return true;
    return Date.now() >= (account.expiresAt - TOKEN_EXPIRY_BUFFER_MS);
}

/**
 * Write refreshed tokens back to Codex CLI's auth.json.
 * Only called for accounts with source === 'imported'.
 */
function _writeBackToCodex(account) {
    try {
        if (!existsSync(CODEX_AUTH_FILE)) {
            console.warn('[AccountManager] Codex auth.json not found, skip writeback');
            return;
        }

        const raw = JSON.parse(readFileSync(CODEX_AUTH_FILE, 'utf8'));
        if (!raw.tokens) return;

        raw.tokens.access_token = account.accessToken;
        raw.tokens.refresh_token = account.refreshToken;
        if (account.idToken) raw.tokens.id_token = account.idToken;
        raw.last_refresh = new Date().toISOString();

        writeFileSync(CODEX_AUTH_FILE, JSON.stringify(raw, null, 2), 'utf8');
        console.log(`[AccountManager] Wrote back refreshed token to Codex auth.json`);
    } catch (e) {
        console.warn(`[AccountManager] Failed to write back to Codex: ${e.message}`);
    }
}

function _extractRefreshErrorCode(error) {
    const message = error?.message || String(error || '');
    const jsonStart = message.indexOf('{');
    if (jsonStart < 0) return null;

    try {
        const parsed = JSON.parse(message.slice(jsonStart));
        return parsed?.error?.code || parsed?.code || null;
    } catch {
        return null;
    }
}

function _persistRefreshedAccount(data, index, tokens, accountInfo) {
    data.accounts[index].accessToken = tokens.accessToken;
    data.accounts[index].refreshToken = tokens.refreshToken || data.accounts[index].refreshToken;
    data.accounts[index].idToken = tokens.idToken || data.accounts[index].idToken;
    data.accounts[index].expiresAt = accountInfo?.expiresAt || (Date.now() + tokens.expiresIn * 1000);
    if (accountInfo?.planType) {
        data.accounts[index].planType = accountInfo.planType;
    }
    _clearRefreshFailure(data, index);
    saveAccounts(data);

    tokenCache.set(data.accounts[index].email, {
        token: tokens.accessToken,
        extractedAt: Date.now()
    });

    if (data.activeAccount === data.accounts[index].email) {
        updateAccountAuth(data.accounts[index]);
    }

    if (data.accounts[index].source === 'imported') {
        _writeBackToCodex(data.accounts[index]);
    }
}

async function _refreshAccountTokenInternal(email) {
    const initialData = loadAccounts();
    const initialAccount = initialData.accounts.find(a => a.email === email);

    if (!initialAccount) {
        return { success: false, message: `Account not found: ${email}` };
    }

    if (!initialAccount.refreshToken) {
        return { success: false, message: 'No refresh token available' };
    }

    const initialRefreshToken = initialAccount.refreshToken;
    const latestData = reloadAccounts();
    const latestAccount = latestData.accounts.find(a => a.email === email);

    if (!latestAccount) {
        return { success: false, message: `Account not found: ${email}` };
    }

    if (!latestAccount.refreshToken) {
        return { success: false, message: 'No refresh token available' };
    }

    if (latestAccount.refreshToken !== initialRefreshToken) {
        console.log(`[AccountManager] Skipping refresh for ${email}: token already rotated`);
        return { success: true, message: `Token already refreshed for: ${email}` };
    }

    const refreshTokenToUse = latestAccount.refreshToken;
    if (latestAccount.refreshFailure?.refreshToken === refreshTokenToUse
        && _isPermanentRefreshFailureCode(latestAccount.refreshFailure.code)) {
        return {
            success: false,
            message: latestAccount.refreshFailure.message || 'Refresh token is no longer valid. Please sign in again.'
        };
    }

    try {
        const tokens = await refreshAccessToken(refreshTokenToUse);
        const accountInfo = extractAccountInfo(tokens.accessToken);

        const data = reloadAccounts();
        const index = data.accounts.findIndex(a => a.email === email);
        if (index >= 0) {
            if (data.accounts[index].refreshToken !== refreshTokenToUse) {
                console.log(`[AccountManager] Skipping persist for ${email}: newer token already saved`);
            } else {
                _persistRefreshedAccount(data, index, tokens, accountInfo);
            }
        }

        console.log(`[AccountManager] Token refreshed for: ${email}`);

        // Auto-fetch quota after refresh
        try {
            const quotaData = await fetchQuota(tokens.accessToken, accountInfo.accountId);
            updateAccountQuota(email, quotaData);
            console.log(`[AccountManager] Quota refreshed for: ${email}`);
        } catch (qErr) {
            console.warn(`[AccountManager] Failed to auto-fetch quota for ${email}: ${qErr.message}`);
        }

        return { success: true, message: `Token refreshed for: ${email}` };
    } catch (error) {
        if (_extractRefreshErrorCode(error) === 'refresh_token_reused') {
            const reloaded = reloadAccounts();
            const reloadedAccount = reloaded.accounts.find(a => a.email === email);
            if (reloadedAccount?.refreshToken && reloadedAccount.refreshToken !== refreshTokenToUse && reloadedAccount.accessToken) {
                console.warn(`[AccountManager] Concurrent refresh detected for ${email}, using newly persisted token`);
                return { success: true, message: `Token already refreshed for: ${email}` };
            }
        }

        console.error(`[AccountManager] Token refresh failed for ${email}:`, error.message);
        const errorCode = _extractRefreshErrorCode(error);
        if (_isPermanentRefreshFailureCode(errorCode)) {
            const failedData = reloadAccounts();
            const failedIndex = failedData.accounts.findIndex(a => a.email === email);
            if (failedIndex >= 0 && failedData.accounts[failedIndex].refreshToken === refreshTokenToUse) {
                const permanentMessage = errorCode === 'refresh_token_reused'
                    ? 'Refresh token already used or rotated elsewhere. Please sign in again or re-import the latest source credentials.'
                    : errorCode === 'refresh_token_expired'
                        ? 'Refresh token expired. Please sign in again.'
                        : 'Refresh token was invalidated. Please sign in again.';
                _setRefreshFailure(failedData, failedIndex, errorCode, permanentMessage);
                return { success: false, message: permanentMessage };
            }
        }
        return { success: false, message: `Token refresh failed: ${error.message}` };
    }
}

async function refreshAccountToken(email) {
    const inFlight = refreshInFlight.get(email);
    if (inFlight) {
        return inFlight;
    }

    const refreshPromise = _refreshAccountTokenInternal(email)
        .finally(() => {
            if (refreshInFlight.get(email) === refreshPromise) {
                refreshInFlight.delete(email);
            }
        });

    refreshInFlight.set(email, refreshPromise);
    return refreshPromise;
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

async function refreshAccountStatus(email) {
    const data = reloadAccounts();
    const account = data.accounts.find(a => a.email === email);

    if (!account) {
        return { success: false, message: `Account not found: ${email}` };
    }

    if (!account.accessToken || !account.accountId) {
        return { success: false, message: `Account ${email} missing token or accountId` };
    }

    if (isTokenExpiredOrExpiringSoon(account)) {
        return refreshAccountToken(email);
    }

    try {
        const quotaData = await fetchQuota(account.accessToken, account.accountId);
        updateAccountQuota(email, quotaData);

        const refreshedData = loadAccounts();
        const index = refreshedData.accounts.findIndex(a => a.email === email);
        if (index >= 0) {
            const nextPlanType = _derivePlanTypeFromQuota(quotaData, refreshedData.accounts[index].planType);
            if (nextPlanType && nextPlanType !== refreshedData.accounts[index].planType) {
                refreshedData.accounts[index].planType = nextPlanType;
                saveAccounts(refreshedData);
            }
        }

        console.log(`[AccountManager] Account status refreshed for: ${email}`);
        return { success: true, message: `Account status refreshed for: ${email}` };
    } catch (error) {
        console.error(`[AccountManager] Status refresh failed for ${email}:`, error.message);
        return { success: false, message: `Status refresh failed: ${error.message}` };
    }
}

async function refreshAllAccountStatus() {
    const data = loadAccounts();
    const results = [];

    for (const account of data.accounts) {
        results.push({ email: account.email, ...(await refreshAccountStatus(account.email)) });
    }

    return results;
}

function startAutoRefresh() {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId);
    }

    // Initial check on startup (delayed 3s) — only refresh if expired or expiring soon
    setTimeout(() => _checkAndRefreshExpiring('startup'), 3000);

    // Periodic fallback check every 6 hours — request-time refresh remains the primary path
    autoRefreshIntervalId = setInterval(() => _checkAndRefreshExpiring('periodic'), AUTO_REFRESH_CHECK_INTERVAL_MS);

    console.log('[AccountManager] Smart auto-refresh started (check every 6 hours, refresh only when expiring)');
}

async function _checkAndRefreshExpiring(trigger) {
    const data = loadAccounts();
    for (const account of data.accounts) {
        if (!account.refreshToken || account.enabled === false) continue;

        if (isTokenExpiredOrExpiringSoon(account)) {
            const remainMs = account.expiresAt ? account.expiresAt - Date.now() : -1;
            const remainStr = remainMs > 0 ? `${Math.round(remainMs / 1000)}s left` : 'expired';
            console.log(`[AccountManager] ${trigger}: refreshing ${account.email} (${remainStr})`);
            await refreshAccountToken(account.email);
        }
    }
}

function stopAutoRefresh() {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId);
        autoRefreshIntervalId = null;
        console.log('[AccountManager] Auto-refresh stopped');
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

async function refreshActiveAccount() {
    const account = getActiveAccount();
    if (!account) {
        return { success: false, message: 'No active account' };
    }

    return refreshAccountToken(account.email);
}

function importFromCodex() {
    const codeAuthFile = CODEX_AUTH_FILE;
    
    try {
        if (!existsSync(codeAuthFile)) {
            return { success: false, message: 'No Codex auth.json found' };
        }
        
        const codexAuth = JSON.parse(readFileSync(codeAuthFile, 'utf8'));
        
        if (!codexAuth.tokens?.access_token) {
            return { success: false, message: 'No valid tokens in Codex auth.json' };
        }
        
        const info = extractAccountInfo(codexAuth.tokens.access_token);
        
        const newAccount = {
            email: info?.email || 'imported@unknown.com',
            accountId: codexAuth.tokens.account_id,
            planType: info?.planType || 'unknown',
            accessToken: codexAuth.tokens.access_token,
            refreshToken: codexAuth.tokens.refresh_token,
            idToken: codexAuth.tokens.id_token,
            expiresAt: info?.expiresAt,
            addedAt: new Date().toISOString(),
            lastUsed: new Date().toISOString(),
            source: 'imported'
        };
        
        const data = loadAccounts();
        
        const existingIndex = data.accounts.findIndex(a => a.email === newAccount.email);
        if (existingIndex >= 0) {
            data.accounts[existingIndex] = newAccount;
        } else {
            data.accounts.push(newAccount);
        }
        
        if (!data.activeAccount) {
            data.activeAccount = newAccount.email;
        }
        
        saveAccounts(data);
        updateAccountAuth(newAccount);
        
        return {
            success: true,
            message: `Imported account: ${newAccount.email} (${newAccount.planType})`
        };
    } catch (error) {
        return { success: false, message: `Import failed: ${error.message}` };
    }
}

function getStatus() {
    const data = loadAccounts();
    const accounts = data.accounts.map(a => {
        const info = extractAccountInfo(a.accessToken);
        return {
            email: a.email,
            planType: a.planType,
            isActive: a.email === data.activeAccount,
            quota: a.quota || null,
            tokenExpired: info?.expiresAt ? info.expiresAt < Date.now() : false,
            lastUsed: a.lastUsed
        };
    });
    
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
            updateAccountAuth(active);
            console.log(`[AccountManager] Restored active account: ${active.email}`);
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
    refreshActiveAccount,
    refreshAccountToken,
    refreshAccountStatus,
    refreshAllAccounts,
    refreshAllAccountStatus,
    importFromCodex,
    getStatus,
    updateAccountAuth,
    ensureAccountsPersist,
    updateAccountQuota,
    getAccountQuota,
    startAutoRefresh,
    stopAutoRefresh,
    isTokenExpiredOrExpiringSoon,
    getCachedToken,
    setCachedToken,
    TOKEN_CHECK_INTERVAL_MS,
    ACCOUNTS_FILE,
    CONFIG_DIR
};

export default {
    getActiveAccount,
    setActiveAccount,
    removeAccount,
    listAccounts,
    refreshActiveAccount,
    refreshAccountToken,
    refreshAccountStatus,
    refreshAllAccounts,
    refreshAllAccountStatus,
    importFromCodex,
    getStatus,
    ensureAccountsPersist,
    updateAccountQuota,
    getAccountQuota,
    startAutoRefresh,
    stopAutoRefresh,
    isTokenExpiredOrExpiringSoon,
    getCachedToken,
    setCachedToken,
    save,
    getAccount
};
