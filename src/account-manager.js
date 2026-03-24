/**
 * Account Manager
 * Manages multiple ChatGPT accounts with manual switching
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { refreshAccessToken, extractAccountInfo } from './oauth.js';
import { getAccountQuota as fetchQuota } from './model-api.js';

const CONFIG_DIR = join(homedir(), '.proxypool-hub');
const ACCOUNTS_FILE = join(CONFIG_DIR, 'accounts.json');
const ACCOUNTS_DIR = join(CONFIG_DIR, 'accounts');

const TOKEN_REFRESH_INTERVAL_MS = 55 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const DEFAULT_ACCOUNTS = {
    accounts: [],
    activeAccount: null,
    version: 1
};

let autoRefreshIntervalId = null;
const tokenCache = new Map();
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

function loadAccounts() {
    if (accountsData !== null) {
        return accountsData;
    }
    
    ensureConfigDir();
    
    if (!existsSync(ACCOUNTS_FILE)) {
        accountsData = { ...DEFAULT_ACCOUNTS };
        return accountsData;
    }
    
    try {
        const data = JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8'));
        accountsData = { ...DEFAULT_ACCOUNTS, ...data };
        return accountsData;
    } catch (e) {
        console.error('[AccountManager] Error loading accounts:', e.message);
        accountsData = { ...DEFAULT_ACCOUNTS };
        return accountsData;
    }
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
            quota: account.quota || null
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

function isTokenExpiredOrExpiringSoon(account) {
    if (!account.expiresAt) return true;
    return Date.now() >= (account.expiresAt - TOKEN_EXPIRY_BUFFER_MS);
}

async function refreshAccountToken(email) {
    const data = loadAccounts();
    const account = data.accounts.find(a => a.email === email);
    
    if (!account) {
        return { success: false, message: `Account not found: ${email}` };
    }
    
    if (!account.refreshToken) {
        return { success: false, message: 'No refresh token available' };
    }
    
    try {
        const tokens = await refreshAccessToken(account.refreshToken);
        const accountInfo = extractAccountInfo(tokens.accessToken);
        
        const index = data.accounts.findIndex(a => a.email === email);
        if (index >= 0) {
            data.accounts[index].accessToken = tokens.accessToken;
            data.accounts[index].refreshToken = tokens.refreshToken || data.accounts[index].refreshToken;
            data.accounts[index].idToken = tokens.idToken || data.accounts[index].idToken;
            data.accounts[index].expiresAt = accountInfo?.expiresAt || (Date.now() + tokens.expiresIn * 1000);
            if (accountInfo?.planType) {
                data.accounts[index].planType = accountInfo.planType;
            }
            saveAccounts(data);
            
            tokenCache.set(email, {
                token: tokens.accessToken,
                extractedAt: Date.now()
            });
            
            if (data.activeAccount === email) {
                updateAccountAuth(data.accounts[index]);
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
        console.error(`[AccountManager] Token refresh failed for ${email}:`, error.message);
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
    
    setTimeout(async () => {
        console.log('[AccountManager] Startup: refreshing all account tokens...');
        const data = loadAccounts();
        for (const account of data.accounts) {
            if (account.refreshToken) {
                console.log(`[AccountManager] Startup refresh for ${account.email}`);
                await refreshAccountToken(account.email);
            }
        }
    }, 2000);
    
    autoRefreshIntervalId = setInterval(async () => {
        const data = loadAccounts();
        
        for (const account of data.accounts) {
            if (account.refreshToken) {
                console.log(`[AccountManager] Periodic refresh for ${account.email}`);
                await refreshAccountToken(account.email);
            }
        }
    }, TOKEN_REFRESH_INTERVAL_MS);
    
    console.log('[AccountManager] Auto-refresh started (every 55 minutes)');
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
    if (cached && (Date.now() - cached.extractedAt) < TOKEN_REFRESH_INTERVAL_MS) {
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
    
    if (!account.refreshToken) {
        return { success: false, message: 'No refresh token available' };
    }
    
    try {
        const tokens = await refreshAccessToken(account.refreshToken);
        const accountInfo = extractAccountInfo(tokens.accessToken);
        
        const data = loadAccounts();
        const index = data.accounts.findIndex(a => a.email === account.email);
        
        if (index >= 0) {
            data.accounts[index].accessToken = tokens.accessToken;
            data.accounts[index].refreshToken = tokens.refreshToken || data.accounts[index].refreshToken;
            data.accounts[index].idToken = tokens.idToken || data.accounts[index].idToken;
            data.accounts[index].expiresAt = accountInfo?.expiresAt || (Date.now() + tokens.expiresIn * 1000);
            if (accountInfo?.planType) {
                data.accounts[index].planType = accountInfo.planType;
            }
            saveAccounts(data);
            
            updateAccountAuth(data.accounts[index]);
            console.log(`[AccountManager] Active account token refreshed: ${account.email}`);
        }
        
        return { success: true, message: `Token refreshed for: ${account.email}` };
    } catch (error) {
        console.error(`[AccountManager] Token refresh failed for ${account.email}:`, error.message);
        return { success: false, message: `Token refresh failed: ${error.message}` };
    }
}

function importFromCodex() {
    const codeAuthFile = join(homedir(), '.codex', 'auth.json');
    
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
    refreshAllAccounts,
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
    TOKEN_REFRESH_INTERVAL_MS,
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
    refreshAllAccounts,
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