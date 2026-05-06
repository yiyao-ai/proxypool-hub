import {
    listAccounts,
    getStatus,
    addOAuthAccount,
    addManualAccount,
    importAccount,
    setActiveAccount,
    refreshAccountToken,
    listQuotaSummaries,
    refreshQuotaSummary,
    refreshAllAccounts,
    toggleAccount,
    removeAccount
} from '../antigravity-account-manager.js';
import {
    GOOGLE_OAUTH_CONFIG,
    hasAntigravityClientSecret,
    generateState,
    getAuthorizationUrl,
    startCallbackServer,
    exchangeCodeForTokens,
    extractCodeFromInput
} from '../antigravity-oauth.js';
import { logger } from '../utils/logger.js';

const activeCallbackServers = new Map();

export function handleListAntigravityAccounts(req, res) {
    res.json(listAccounts());
}

export function handleAntigravityAccountStatus(req, res) {
    res.json(getStatus());
}

export async function handleGetAntigravityQuotas(req, res) {
    const refresh = req.query?.refresh === 'true';
    const result = await listQuotaSummaries({ refresh });
    res.json(result);
}

export async function handleRefreshAntigravityQuota(req, res) {
    const email = decodeURIComponent(req.params.email);
    try {
        const summary = await refreshQuotaSummary(email);
        res.json({ success: true, account: summary });
    } catch (error) {
        res.status(404).json({ success: false, error: error.message });
    }
}

export function handleAntigravityOAuthCleanup(req, res) {
    for (const [, server] of activeCallbackServers) {
        try { server.abort ? server.abort() : server.close(); } catch { /* ignore */ }
    }
    activeCallbackServers.clear();
    res.json({ success: true, message: 'Antigravity OAuth servers cleaned up' });
}

export async function handleAddAntigravityAccount(req, res) {
    if (!hasAntigravityClientSecret()) {
        return res.status(400).json({
            success: false,
            error: 'ANTIGRAVITY_GOOGLE_CLIENT_SECRET is required before starting Antigravity OAuth.',
            hint: 'Set ANTIGRAVITY_GOOGLE_CLIENT_SECRET in the environment or use manual account import instead.',
            status: 'misconfigured'
        });
    }

    const { port } = req.body || {};
    const callbackPort = port || GOOGLE_OAUTH_CONFIG.callbackPort;
    const state = generateState();

    if (activeCallbackServers.has(callbackPort)) {
        const existing = activeCallbackServers.get(callbackPort);
        if (existing.abort) existing.abort();
        activeCallbackServers.delete(callbackPort);
    }

    let serverResult;
    try {
        serverResult = startCallbackServer(state, 120000);
    } catch (err) {
        return res.status(500).json({
            error: 'Failed to start Antigravity OAuth callback server',
            message: err.message,
            status: 'error'
        });
    }

    activeCallbackServers.set(callbackPort, serverResult);
    const oauthUrl = getAuthorizationUrl(state, callbackPort);

    serverResult.promise
        .then(async (code) => {
            activeCallbackServers.delete(callbackPort);
            if (!code) return;
            const actualPort = serverResult.getPort ? serverResult.getPort() : callbackPort;
            const tokens = await exchangeCodeForTokens(code, actualPort);
            const result = await addOAuthAccount(tokens);
            logger.info(`Added antigravity account via OAuth: ${result.account?.email || 'unknown'}`);
        })
        .catch((err) => {
            activeCallbackServers.delete(callbackPort);
            logger.error(`Antigravity OAuth token exchange failed: ${err.message}`);
        });

    res.json({
        status: 'oauth_url',
        oauth_url: oauthUrl,
        state,
        callback_port: callbackPort
    });
}

export async function handleAddAntigravityAccountManual(req, res) {
    try {
        const { code, port } = req.body || {};
        if (code) {
            if (!hasAntigravityClientSecret()) {
                return res.status(400).json({
                    success: false,
                    error: 'ANTIGRAVITY_GOOGLE_CLIENT_SECRET is required before exchanging an Antigravity OAuth code.',
                    hint: 'Set ANTIGRAVITY_GOOGLE_CLIENT_SECRET in the environment or import a refresh token manually.'
                });
            }
            const extracted = extractCodeFromInput(code);
            const tokens = await exchangeCodeForTokens(extracted.code, port || GOOGLE_OAUTH_CONFIG.callbackPort);
            const result = await addOAuthAccount(tokens);
            logger.info(`Added antigravity account via manual OAuth: ${result.account?.email || 'unknown'}`);
            return res.json(result);
        }

        const result = await addManualAccount(req.body || {});
        if (result.success) {
            logger.info(`Added antigravity account: ${result.account?.email || 'unknown'}`);
        }
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
}

export async function handleImportAntigravityAccount(req, res) {
    try {
        const result = await importAccount(req.body || {});
        if (result.success) {
            logger.info(`Imported antigravity account: ${result.account?.email || 'unknown'}`);
        }
        res.json(result);
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
}

export function handleSwitchAntigravityAccount(req, res) {
    const { email } = req.body || {};
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
    }
    const result = setActiveAccount(email);
    res.json(result);
}

export async function handleRefreshAntigravityAccount(req, res) {
    const email = decodeURIComponent(req.params.email);
    const result = await refreshAccountToken(email);
    res.json(result);
}

export async function handleRefreshAllAntigravityAccounts(req, res) {
    const result = await refreshAllAccounts();
    res.json(result);
}

export function handleToggleAntigravityAccount(req, res) {
    const email = decodeURIComponent(req.params.email);
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }
    const result = toggleAccount(email, enabled);
    res.json(result);
}

export function handleRemoveAntigravityAccount(req, res) {
    const email = decodeURIComponent(req.params.email);
    const result = removeAccount(email);
    res.json(result);
}

export default {
    handleListAntigravityAccounts,
    handleAntigravityAccountStatus,
    handleGetAntigravityQuotas,
    handleRefreshAntigravityQuota,
    handleAntigravityOAuthCleanup,
    handleAddAntigravityAccount,
    handleAddAntigravityAccountManual,
    handleImportAntigravityAccount,
    handleSwitchAntigravityAccount,
    handleRefreshAntigravityAccount,
    handleRefreshAllAntigravityAccounts,
    handleToggleAntigravityAccount,
    handleRemoveAntigravityAccount
};
