import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR, loadAccounts, getAccount } from './claude-account-manager.js';
import { logger } from './utils/logger.js';

const CLAUDE_USAGE_CACHE_FILE = join(CONFIG_DIR, 'claude-usage-cache.json');
const CACHE_VERSION = 1;
const USAGE_STALE_MS = 5 * 60 * 1000;
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const UNSUPPORTED_RETRY_MS = 30 * 60 * 1000;

const DEFAULT_CACHE = {
    version: CACHE_VERSION,
    accounts: {}
};

function ensureConfigDir() {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
}

function loadUsageCache() {
    ensureConfigDir();
    if (!existsSync(CLAUDE_USAGE_CACHE_FILE)) {
        return { ...DEFAULT_CACHE };
    }

    try {
        const parsed = JSON.parse(readFileSync(CLAUDE_USAGE_CACHE_FILE, 'utf8'));
        return {
            ...DEFAULT_CACHE,
            ...parsed,
            accounts: parsed?.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {}
        };
    } catch (error) {
        logger.warn(`[ClaudeUsage] Failed to load cache: ${error.message}`);
        return { ...DEFAULT_CACHE };
    }
}

function saveUsageCache(cache) {
    ensureConfigDir();
    writeFileSync(CLAUDE_USAGE_CACHE_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
}

function getUsageCacheEntry(email) {
    const cache = loadUsageCache();
    return cache.accounts[email] || null;
}

function updateUsageCacheEntry(email, updater) {
    const cache = loadUsageCache();
    const current = cache.accounts[email] || {};
    const next = updater(current);
    cache.accounts[email] = next;
    saveUsageCache(cache);
    return next;
}

function normalizeScopes(scopes) {
    if (Array.isArray(scopes)) return scopes.filter(Boolean);
    if (typeof scopes === 'string') {
        return scopes.split(/\s+/).map(scope => scope.trim()).filter(Boolean);
    }
    return [];
}

function hasProfileScope(account) {
    return normalizeScopes(account?.scopes).includes('user:profile');
}

function normalizeWindow(windowData) {
    if (!windowData || typeof windowData !== 'object') return null;
    const utilization = Number(windowData.utilization);
    return {
        utilization: Number.isFinite(utilization) ? utilization : null,
        resetsAt: windowData.resets_at || null
    };
}

function normalizeRuntimePercent(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    const percent = numeric <= 1 ? numeric * 100 : numeric;
    return Math.max(0, Math.min(100, Math.round(percent)));
}

function normalizeRuntimeReset(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        const ms = numeric < 1e12 ? numeric * 1000 : numeric;
        return new Date(ms).toISOString();
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function normalizeExtraUsage(extraUsage) {
    if (!extraUsage || typeof extraUsage !== 'object') return null;

    const monthlyLimit = Number(extraUsage.monthly_limit);
    const usedCredits = Number(extraUsage.used_credits);
    const utilization = Number(extraUsage.utilization);

    return {
        isEnabled: extraUsage.disabled_reason ? false : true,
        monthlyLimit: Number.isFinite(monthlyLimit) ? monthlyLimit : null,
        usedCredits: Number.isFinite(usedCredits) ? usedCredits : null,
        utilization: Number.isFinite(utilization) ? utilization : null,
        disabledReason: extraUsage.disabled_reason || null
    };
}

function normalizeOAuthUsage(payload) {
    return {
        fiveHour: normalizeWindow(payload?.five_hour),
        sevenDay: normalizeWindow(payload?.seven_day),
        sevenDayOauthApps: normalizeWindow(payload?.seven_day_oauth_apps),
        sevenDayOpus: normalizeWindow(payload?.seven_day_opus),
        sevenDaySonnet: normalizeWindow(payload?.seven_day_sonnet),
        extraUsage: normalizeExtraUsage(payload?.extra_usage)
    };
}

function parseTimestamp(value) {
    if (!value) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function isUsageStale(entry) {
    const fetchedAt = parseTimestamp(entry?.oauthUsage?.fetchedAt);
    if (!fetchedAt) return true;
    return (Date.now() - fetchedAt) > USAGE_STALE_MS;
}

function isUnsupportedStillFresh(entry) {
    if (!entry?.oauthUsage?.unsupported) return false;
    const fetchedAt = parseTimestamp(entry?.oauthUsage?.fetchedAt);
    if (!fetchedAt) return false;
    return (Date.now() - fetchedAt) < UNSUPPORTED_RETRY_MS;
}

export async function fetchClaudeOAuthUsage(accessToken) {
    const response = await fetch(USAGE_API_URL, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 && /OAuth authentication is currently not supported/i.test(errorText)) {
            const error = new Error('Claude usage API does not support this OAuth token');
            error.code = 'oauth_usage_unsupported';
            throw error;
        }
        throw new Error(`Claude usage fetch failed: ${response.status} - ${errorText.slice(0, 300)}`);
    }

    const payload = await response.json();
    return normalizeOAuthUsage(payload);
}

export async function refreshClaudeUsage(email, { force = false } = {}) {
    const account = getAccount(email);
    if (!account) {
        throw new Error(`Claude account not found: ${email}`);
    }

    const canFetch = hasProfileScope(account) && !!account.accessToken;
    if (!canFetch) {
        return buildClaudeUsageSummary(account, getUsageCacheEntry(email));
    }

    const existing = getUsageCacheEntry(email);
    if (!force && existing?.oauthUsage && (!isUsageStale(existing) || isUnsupportedStillFresh(existing))) {
        return buildClaudeUsageSummary(account, existing);
    }

    try {
        const usage = await fetchClaudeOAuthUsage(account.accessToken);
        const entry = updateUsageCacheEntry(email, current => ({
            ...current,
            oauthUsage: {
                usage,
                fetchedAt: new Date().toISOString(),
                error: null,
                unsupported: false
            }
        }));
        return buildClaudeUsageSummary(account, entry);
    } catch (error) {
        logger.warn(`[ClaudeUsage] OAuth usage fetch failed for ${email}: ${error.message}`);
        const entry = updateUsageCacheEntry(email, current => ({
            ...current,
            oauthUsage: {
                ...(current.oauthUsage || {}),
                error: error.message,
                fetchedAt: new Date().toISOString(),
                unsupported: error.code === 'oauth_usage_unsupported'
            }
        }));
        return buildClaudeUsageSummary(account, entry);
    }
}

export function recordClaudeRuntimeObservation(email, headers, context = {}) {
    if (!email || !headers || typeof headers !== 'object') return null;

    const entry = updateUsageCacheEntry(email, current => ({
        ...current,
        runtime: {
            ...(current.runtime || {}),
            ...headers,
            lastObservedAt: new Date().toISOString(),
            lastObservedModel: context.model || current.runtime?.lastObservedModel || null
        }
    }));

    return entry.runtime;
}

function buildRuntime(runtime) {
    if (!runtime) {
        return {
            status: 'unknown',
            representativeClaim: null,
            resetAt: null,
            overageStatus: 'unknown',
            overageResetAt: null,
            overageDisabledReason: null,
            fiveHourUtilization: null,
            fiveHourResetAt: null,
            sevenDayUtilization: null,
            sevenDayResetAt: null,
            lastObservedAt: null,
            lastObservedModel: null
        };
    }

    const toNumber = (value) => {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    };

    return {
        status: runtime.status || 'unknown',
        representativeClaim: runtime.representativeClaim || null,
        resetAt: normalizeRuntimeReset(runtime.resetAt),
        overageStatus: runtime.overageStatus || 'unknown',
        overageResetAt: normalizeRuntimeReset(runtime.overageResetAt),
        overageDisabledReason: runtime.overageDisabledReason || null,
        fiveHourUtilization: normalizeRuntimePercent(runtime.fiveHourUtilization),
        fiveHourResetAt: normalizeRuntimeReset(runtime.fiveHourResetAt),
        sevenDayUtilization: normalizeRuntimePercent(runtime.sevenDayUtilization),
        sevenDayResetAt: normalizeRuntimeReset(runtime.sevenDayResetAt),
        lastObservedAt: runtime.lastObservedAt || null,
        lastObservedModel: runtime.lastObservedModel || null
    };
}

function buildUsageFromRuntime(runtime) {
    if (!runtime?.lastObservedAt) {
        return {
            fiveHour: null,
            sevenDay: null,
            sevenDayOauthApps: null,
            sevenDayOpus: null,
            sevenDaySonnet: null,
            extraUsage: null
        };
    }

    return {
        fiveHour: runtime.fiveHourUtilization === null ? null : {
            utilization: runtime.fiveHourUtilization,
            resetsAt: runtime.fiveHourResetAt
        },
        sevenDay: runtime.sevenDayUtilization === null ? null : {
            utilization: runtime.sevenDayUtilization,
            resetsAt: runtime.sevenDayResetAt
        },
        sevenDayOauthApps: null,
        sevenDayOpus: null,
        sevenDaySonnet: null,
        extraUsage: null
    };
}

function buildSource(entry) {
    if (entry?.oauthUsage?.usage) return 'oauth_usage';
    if (entry?.runtime?.lastObservedAt) return 'response_headers';
    return 'none';
}

function buildAvailability(account, entry) {
    return {
        hasProfileScope: hasProfileScope(account),
        tokenExpired: account?.expiresAt ? account.expiresAt < Date.now() : false,
        fetchError: entry?.oauthUsage?.error || null
    };
}

export function buildClaudeUsageSummary(account, entry = null) {
    const runtime = buildRuntime(entry?.runtime);
    const usage = entry?.oauthUsage?.usage || buildUsageFromRuntime(runtime);

    return {
        email: account.email,
        displayName: account.displayName || null,
        subscriptionType: account.subscriptionType || 'free',
        rateLimitTier: account.rateLimitTier || null,
        source: buildSource(entry),
        fetchedAt: entry?.oauthUsage?.fetchedAt || entry?.runtime?.lastObservedAt || null,
        usage,
        runtime,
        availability: buildAvailability(account, entry)
    };
}

export async function listClaudeUsageSummaries({ refresh = false } = {}) {
    const data = loadAccounts();
    const summaries = [];

    for (const account of data.accounts || []) {
        if (refresh) {
            summaries.push(await refreshClaudeUsage(account.email, { force: true }));
            continue;
        }

        summaries.push(await refreshClaudeUsage(account.email, { force: false }));
    }

    return {
        accounts: summaries,
        activeAccount: data.activeAccount,
        total: summaries.length
    };
}

export {
    CLAUDE_USAGE_CACHE_FILE,
    hasProfileScope,
    loadUsageCache,
    getUsageCacheEntry
};
