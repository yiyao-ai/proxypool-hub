import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';
import {
    refreshAntigravityAccessToken,
    fetchGoogleUserInfo,
    fetchProjectId,
    fetchAvailableModels,
    toPublicAntigravityModel,
    mapAntigravityUpstreamModel
} from './antigravity-api.js';

const ACCOUNTS_FILE = join(CONFIG_DIR, 'antigravity-accounts.json');

const DEFAULT_DATA = {
    accounts: [],
    activeAccount: null,
    version: 1
};

let cache = null;
let autoRefreshIntervalId = null;
const TOKEN_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
}

export function loadAccounts() {
    if (cache) return cache;
    ensureConfigDir();
    if (!existsSync(ACCOUNTS_FILE)) {
        cache = { ...DEFAULT_DATA };
        return cache;
    }

    try {
        cache = { ...DEFAULT_DATA, ...JSON.parse(readFileSync(ACCOUNTS_FILE, 'utf8')) };
    } catch {
        cache = { ...DEFAULT_DATA };
    }
    return cache;
}

export function saveAccounts(data) {
    ensureConfigDir();
    cache = data;
    writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function getAccount(email) {
    return loadAccounts().accounts.find((account) => account.email === email) || null;
}

export function getActiveAccount() {
    const data = loadAccounts();
    return data.accounts.find((account) => account.email === data.activeAccount) || null;
}

export function setActiveAccount(email) {
    const data = loadAccounts();
    const account = data.accounts.find((item) => item.email === email);
    if (!account) {
        return { success: false, message: `Account not found: ${email}` };
    }
    data.activeAccount = email;
    saveAccounts(data);
    return { success: true, message: `Switched to antigravity account: ${email}` };
}

export function toggleAccount(email, enabled) {
    const data = loadAccounts();
    const account = data.accounts.find((item) => item.email === email);
    if (!account) return { success: false, message: `Account not found: ${email}` };
    account.enabled = enabled;
    saveAccounts(data);
    return { success: true, message: `Antigravity account ${email} ${enabled ? 'enabled' : 'disabled'}` };
}

export function removeAccount(email) {
    const data = loadAccounts();
    const index = data.accounts.findIndex((item) => item.email === email);
    if (index < 0) return { success: false, message: `Account not found: ${email}` };

    data.accounts.splice(index, 1);
    if (data.activeAccount === email) {
        data.activeAccount = data.accounts[0]?.email || null;
    }
    saveAccounts(data);
    return { success: true, message: `Removed antigravity account: ${email}` };
}

function summarizeAccount(account, activeAccount) {
    return {
        email: account.email,
        displayName: account.displayName || null,
        picture: account.picture || null,
        projectId: account.projectId || null,
        subscriptionType: account.subscriptionType || 'unknown',
        enabled: account.enabled !== false,
        isActive: account.email === activeAccount,
        tokenExpired: !account.expiresAt || account.expiresAt < Date.now(),
        addedAt: account.addedAt,
        lastUsed: account.lastUsed,
        modelCount: Array.isArray(account.models) ? account.models.length : 0,
        quotaFetchedAt: account.quotaFetchedAt || null,
        models: (account.models || []).map((model) => ({
            id: model.id,
            publicId: model.publicId || toPublicAntigravityModel(model.id),
            displayName: model.displayName || model.id,
            quota: model.quota || null
        }))
    };
}

export function listAccounts() {
    const data = loadAccounts();
    return {
        accounts: data.accounts.map((account) => summarizeAccount(account, data.activeAccount)),
        activeAccount: data.activeAccount,
        total: data.accounts.length
    };
}

export function getStatus() {
    const data = loadAccounts();
    return {
        total: data.accounts.length,
        activeAccount: data.activeAccount,
        available: data.accounts.filter((account) => account.enabled !== false && account.accessToken).length
    };
}

export function isTokenExpiredOrExpiringSoon(account) {
    if (!account?.expiresAt) return true;
    return Date.now() >= (account.expiresAt - TOKEN_EXPIRY_BUFFER_MS);
}

function upsertAccountRecord(accountInfo) {
    const data = loadAccounts();
    const index = data.accounts.findIndex((item) => item.email === accountInfo.email);
    const nextRecord = {
        enabled: true,
        addedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        models: [],
        ...data.accounts[index],
        ...accountInfo
    };

    if (index >= 0) {
        data.accounts[index] = nextRecord;
    } else {
        data.accounts.push(nextRecord);
    }

    if (!data.activeAccount) {
        data.activeAccount = nextRecord.email;
    }

    saveAccounts(data);
    return nextRecord;
}

function summarizeQuotaModel(model) {
    return {
        id: model.id,
        publicId: model.publicId || toPublicAntigravityModel(model.id),
        displayName: model.displayName || model.id,
        recommended: model.recommended === true,
        supportsImages: model.supportsImages === true,
        supportsThinking: model.supportsThinking === true,
        quota: model.quota || null
    };
}

function buildQuotaSummary(account) {
    return {
        email: account.email,
        displayName: account.displayName || null,
        subscriptionType: account.subscriptionType || 'unknown',
        projectId: account.projectId || null,
        source: 'fetch_available_models',
        fetchedAt: account.quotaFetchedAt || null,
        tokenExpired: !account.expiresAt || account.expiresAt < Date.now(),
        models: (account.models || []).map(summarizeQuotaModel)
    };
}

export async function refreshAccountToken(email) {
    const existing = getAccount(email);
    if (!existing?.refreshToken) {
        return { success: false, message: `Refresh token not found for ${email}` };
    }

    try {
        const refreshed = await refreshAntigravityAccessToken(existing.refreshToken, existing.oauthClientKey);
        const profile = await fetchGoogleUserInfo(refreshed.accessToken);
        const project = await fetchProjectId(refreshed.accessToken);
        const models = await fetchAvailableModels(refreshed.accessToken, project.projectId);

        upsertAccountRecord({
            ...existing,
            email: profile.email || existing.email,
            displayName: profile.displayName || existing.displayName,
            picture: profile.picture || existing.picture,
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
            expiresAt: refreshed.expiresAt,
            oauthClientKey: refreshed.oauthClientKey || existing.oauthClientKey,
            projectId: project.projectId,
            subscriptionType: project.subscriptionType || existing.subscriptionType || 'unknown',
            models,
            quotaFetchedAt: new Date().toISOString(),
            lastUsed: new Date().toISOString()
        });

        return { success: true, message: `Refreshed antigravity account: ${email}` };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

export async function refreshAllAccounts() {
    const data = loadAccounts();
    const results = [];
    for (const account of data.accounts) {
        results.push(await refreshAccountToken(account.email));
    }
    return {
        success: results.every((result) => result.success),
        results
    };
}

async function refreshExpiringAccounts(trigger) {
    const data = loadAccounts();
    for (const account of data.accounts) {
        if (account.enabled === false || !account.refreshToken) continue;
        if (!isTokenExpiredOrExpiringSoon(account)) continue;
        try {
            await refreshAccountToken(account.email);
        } catch {
            // Ignore per-account refresh failure; status remains visible in UI.
        }
    }
}

export function startAutoRefresh() {
    if (autoRefreshIntervalId) {
        clearInterval(autoRefreshIntervalId);
    }
    setTimeout(() => refreshExpiringAccounts('startup'), 5000);
    autoRefreshIntervalId = setInterval(() => refreshExpiringAccounts('periodic'), TOKEN_CHECK_INTERVAL_MS);
}

export function stopAutoRefresh() {
    if (!autoRefreshIntervalId) return;
    clearInterval(autoRefreshIntervalId);
    autoRefreshIntervalId = null;
}

export function ensureAccountsPersist() {
    loadAccounts();
}

export async function addManualAccount({ refreshToken, accessToken, expiresAt, email, displayName, oauthClientKey }) {
    if (!refreshToken && !accessToken) {
        throw new Error('refreshToken or accessToken is required');
    }

    let tokenState = {
        accessToken: accessToken || null,
        refreshToken: refreshToken || null,
        expiresAt: expiresAt || null,
        oauthClientKey: oauthClientKey || null
    };

    if (!tokenState.accessToken && tokenState.refreshToken) {
        tokenState = await refreshAntigravityAccessToken(tokenState.refreshToken, oauthClientKey);
    }

    const profile = await fetchGoogleUserInfo(tokenState.accessToken);
    const project = await fetchProjectId(tokenState.accessToken);
    const models = await fetchAvailableModels(tokenState.accessToken, project.projectId);

    const finalEmail = email || profile.email;
    if (!finalEmail) {
        throw new Error('Unable to resolve account email from token');
    }

    const account = upsertAccountRecord({
        email: finalEmail,
        displayName: displayName || profile.displayName,
        picture: profile.picture,
        accessToken: tokenState.accessToken,
        refreshToken: tokenState.refreshToken || refreshToken || null,
        expiresAt: tokenState.expiresAt || (Date.now() + 55 * 60 * 1000),
        oauthClientKey: tokenState.oauthClientKey || oauthClientKey || null,
        projectId: project.projectId,
        subscriptionType: project.subscriptionType || 'unknown',
        models,
        quotaFetchedAt: new Date().toISOString(),
        source: 'manual'
    });

    return {
        success: true,
        message: `Added antigravity account: ${account.email}`,
        account: summarizeAccount(account, loadAccounts().activeAccount)
    };
}

export async function addOAuthAccount({ accessToken, refreshToken, expiresIn, oauthClientKey }) {
    const profile = await fetchGoogleUserInfo(accessToken);
    const project = await fetchProjectId(accessToken);
    const models = await fetchAvailableModels(accessToken, project.projectId);

    if (!profile.email) {
        throw new Error('Unable to resolve account email from Google profile');
    }

    const account = upsertAccountRecord({
        email: profile.email,
        displayName: profile.displayName,
        picture: profile.picture,
        accessToken,
        refreshToken,
        expiresAt: Date.now() + ((expiresIn || 3600) * 1000),
        oauthClientKey: oauthClientKey || null,
        projectId: project.projectId,
        subscriptionType: project.subscriptionType || 'unknown',
        models,
        quotaFetchedAt: new Date().toISOString(),
        source: 'oauth'
    });

    return {
        success: true,
        message: `Added antigravity account: ${account.email}`,
        account: summarizeAccount(account, loadAccounts().activeAccount)
    };
}

function pickToken(source, keys) {
    for (const key of keys) {
        if (source?.[key]) return source[key];
    }
    return null;
}

export async function importAccount(payload = {}) {
    const source = payload.account || payload;
    const tokens = source.tokens || payload.tokens || {};
    return addManualAccount({
        refreshToken: pickToken(source, ['refreshToken', 'refresh_token']) || pickToken(tokens, ['refreshToken', 'refresh_token']),
        accessToken: pickToken(source, ['accessToken', 'access_token']) || pickToken(tokens, ['accessToken', 'access_token']),
        expiresAt: source.expiresAt || source.expires_at || null,
        email: source.email || null,
        displayName: source.displayName || source.name || null,
        oauthClientKey: source.oauthClientKey || source.oauth_client_key || null
    });
}

export function getAllModels() {
    const models = new Map();
    for (const account of loadAccounts().accounts) {
        if (account.enabled === false) continue;
        for (const model of account.models || []) {
            const publicId = model.publicId || toPublicAntigravityModel(model.id);
            if (!models.has(publicId)) {
                models.set(publicId, {
                    id: publicId,
                    object: 'model',
                    owned_by: 'google',
                    description: model.displayName || model.id
                });
            }
        }
    }
    return [...models.values()];
}

export async function listQuotaSummaries({ refresh = false } = {}) {
    if (refresh) {
        const accounts = loadAccounts().accounts.filter((account) => account.enabled !== false);
        for (const account of accounts) {
            await refreshAccountToken(account.email);
        }
    }

    const data = loadAccounts();
    return {
        accounts: data.accounts.map(buildQuotaSummary),
        activeAccount: data.activeAccount,
        total: data.accounts.length
    };
}

export async function refreshQuotaSummary(email) {
    const result = await refreshAccountToken(email);
    if (!result.success) {
        throw new Error(result.message || `Failed to refresh antigravity account: ${email}`);
    }

    const account = getAccount(email);
    if (!account) {
        throw new Error(`Account not found: ${email}`);
    }

    return buildQuotaSummary(account);
}

export function getAvailableAccountForModel(modelId, preferredEmail = null) {
    const normalized = modelId?.startsWith('antigravity/') ? modelId.slice('antigravity/'.length) : modelId;
    const mapped = mapAntigravityUpstreamModel(normalized);
    const accounts = loadAccounts().accounts.filter((account) =>
        account.enabled !== false &&
        account.accessToken &&
        (!account.expiresAt || account.expiresAt > Date.now())
    );

    const ordered = preferredEmail
        ? [
            ...accounts.filter((account) => account.email === preferredEmail),
            ...accounts.filter((account) => account.email !== preferredEmail)
        ]
        : accounts;

    const match = ordered.find((account) => (account.models || []).some((model) => model.id === normalized || model.id === mapped));
    return match || ordered[0] || null;
}

export function accountSupportsAntigravityModel(account, modelId) {
    const normalized = modelId?.startsWith('antigravity/') ? modelId.slice('antigravity/'.length) : modelId;
    const mapped = mapAntigravityUpstreamModel(normalized);
    return (account?.models || []).some((model) => model.id === normalized || model.id === mapped);
}

export { ACCOUNTS_FILE };

export default {
    loadAccounts,
    saveAccounts,
    getAccount,
    getActiveAccount,
    setActiveAccount,
    toggleAccount,
    removeAccount,
    listAccounts,
    getStatus,
    refreshAccountToken,
    refreshAllAccounts,
    addManualAccount,
    addOAuthAccount,
    importAccount,
    getAllModels,
    listQuotaSummaries,
    refreshQuotaSummary,
    getAvailableAccountForModel,
    startAutoRefresh,
    stopAutoRefresh,
    ensureAccountsPersist,
    isTokenExpiredOrExpiringSoon,
    ACCOUNTS_FILE
};
