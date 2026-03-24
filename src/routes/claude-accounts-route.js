/**
 * Claude Accounts Route
 * Handles all /claude-accounts/* endpoints:
 *   GET    /claude-accounts
 *   GET    /claude-accounts/status
 *   POST   /claude-accounts/add
 *   POST   /claude-accounts/add/manual
 *   POST   /claude-accounts/switch
 *   POST   /claude-accounts/import
 *   POST   /claude-accounts/refresh
 *   POST   /claude-accounts/refresh/all
 *   POST   /claude-accounts/:email/refresh
 *   POST   /claude-accounts/oauth/cleanup
 *   DELETE /claude-accounts/:email
 */

import {
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
    loadAccounts,
    saveAccounts
} from '../claude-account-manager.js';

import {
    getAuthorizationUrl,
    generatePKCE,
    generateState,
    startCallbackServer,
    exchangeCodeForTokens,
    CLAUDE_OAUTH_CONFIG,
    extractCodeFromInput,
    fetchProfile
} from '../claude-oauth.js';

import { logger } from '../utils/logger.js';

// Tracks active OAuth callback servers keyed by port
const activeCallbackServers = new Map();

// ─── Route Handlers ──────────────────────────────────────────────────────────

export function handleListClaudeAccounts(req, res) {
    res.json(listAccounts());
}

export function handleClaudeAccountStatus(req, res) {
    res.json(getStatus());
}

export function handleClaudeOAuthCleanup(req, res) {
    for (const [, server] of activeCallbackServers) {
        try { server.abort ? server.abort() : server.close(); } catch { /* ignore */ }
    }
    activeCallbackServers.clear();
    res.json({ success: true, message: 'Claude OAuth servers cleaned up' });
}

export async function handleAddClaudeAccount(req, res) {
    const { port } = req.body || {};
    const callbackPort = port || CLAUDE_OAUTH_CONFIG.callbackPort;

    const { verifier } = generatePKCE();
    const state = generateState();
    const oauthUrl = getAuthorizationUrl(verifier, state, callbackPort);

    // Close any existing server on this port
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
            error: 'Failed to start Claude OAuth callback server',
            message: err.message,
            status: 'error'
        });
    }

    activeCallbackServers.set(callbackPort, serverResult);

    serverResult.promise
        .then(async code => {
            activeCallbackServers.delete(callbackPort);
            if (!code) return;

            const tokens = await exchangeCodeForTokens(code, verifier, callbackPort, state);
            const profile = await fetchProfile(tokens.accessToken);

            const expiresAt = tokens.expiresIn
                ? Date.now() + tokens.expiresIn * 1000
                : null;

            const accountInfo = {
                email: profile?.email || 'unknown@claude.ai',
                accountId: profile?.accountId || null,
                displayName: profile?.displayName || null,
                subscriptionType: profile?.subscriptionType || tokens.subscriptionType || 'free',
                hasClaudePro: profile?.hasClaudePro || false,
                hasClaudeMax: profile?.hasClaudeMax || false,
                organizationName: profile?.organizationName || null,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt,
                scopes: tokens.scopes,
                addedAt: new Date().toISOString(),
                lastUsed: new Date().toISOString()
            };

            await _upsertClaudeAccount(accountInfo);
            logger.info(`Added Claude account: ${accountInfo.email} (${accountInfo.subscriptionType})`);
        })
        .catch(err => {
            activeCallbackServers.delete(callbackPort);
            logger.error(`Claude OAuth token exchange failed: ${err.message}`);
        });

    res.json({
        status: 'oauth_url',
        oauth_url: oauthUrl,
        verifier,
        state,
        callback_port: callbackPort
    });
}

export async function handleAddClaudeAccountManual(req, res) {
    const { code, verifier, state } = req.body || {};

    if (!code) {
        return res.status(400).json({ success: false, error: 'Code is required' });
    }

    try {
        const { code: extractedCode, state: extractedState } = extractCodeFromInput(code);

        // For manual flow, use the manual redirect URI port
        const port = CLAUDE_OAUTH_CONFIG.callbackPort;
        const tokens = await exchangeCodeForTokens(extractedCode, verifier || '', port, state || extractedState);
        const profile = await fetchProfile(tokens.accessToken);

        const expiresAt = tokens.expiresIn
            ? Date.now() + tokens.expiresIn * 1000
            : null;

        const accountInfo = {
            email: profile?.email || 'unknown@claude.ai',
            accountId: profile?.accountId || null,
            displayName: profile?.displayName || null,
            subscriptionType: profile?.subscriptionType || tokens.subscriptionType || 'free',
            hasClaudePro: profile?.hasClaudePro || false,
            hasClaudeMax: profile?.hasClaudeMax || false,
            organizationName: profile?.organizationName || null,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt,
            scopes: tokens.scopes,
            addedAt: new Date().toISOString(),
            lastUsed: new Date().toISOString()
        };

        await _upsertClaudeAccount(accountInfo);
        logger.info(`Added Claude account via manual OAuth: ${accountInfo.email}`);
        res.json({ success: true, message: `Claude account ${accountInfo.email} added successfully` });
    } catch (err) {
        logger.error(`Claude manual OAuth failed: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
    }
}

export function handleSwitchClaudeAccount(req, res) {
    const { email } = req.body || {};
    if (!email) {
        return res.status(400).json({ success: false, message: 'Email is required' });
    }
    const result = setActiveAccount(email);
    if (result.success) {
        logger.info(`Switched to Claude account: ${email}`);
    }
    res.json(result);
}

export async function handleRefreshClaudeAccount(req, res) {
    const email = decodeURIComponent(req.params.email);
    const result = await refreshAccountToken(email);
    if (result.success) {
        logger.info(`Refreshed Claude token for: ${email}`);
    }
    res.json(result);
}

export async function handleRefreshAllClaudeAccounts(req, res) {
    const result = await refreshAllAccounts();
    res.json(result);
}

export async function handleRefreshActiveClaudeAccount(req, res) {
    const active = getActiveAccount();
    if (!active) {
        return res.json({ success: false, message: 'No active Claude account' });
    }
    const result = await refreshAccountToken(active.email);
    res.json(result);
}

export function handleToggleClaudeAccount(req, res) {
    const email = decodeURIComponent(req.params.email);
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
    }
    const result = toggleAccount(email, enabled);
    if (result.success) {
        logger.info(`Claude account ${email} ${enabled ? 'enabled' : 'disabled'}`);
    }
    res.json(result);
}

export function handleRemoveClaudeAccount(req, res) {
    const email = decodeURIComponent(req.params.email);
    const result = removeAccount(email);
    if (result.success) {
        logger.info(`Removed Claude account: ${email}`);
    }
    res.json(result);
}

export async function handleImportClaudeAccount(req, res) {
    const result = importFromClaudeCode();

    // If import succeeded, try to enrich with profile data
    if (result.success) {
        try {
            const data = loadAccounts();
            const imported = data.accounts.find(a => a.source === 'claude-code-import');
            if (imported) {
                await enrichWithProfile(imported.email);
            }
        } catch (e) {
            logger.warn(`Profile enrichment after import failed: ${e.message}`);
        }
    }

    res.json(result);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function _upsertClaudeAccount(accountInfo) {
    const data = loadAccounts();
    const existingIndex = data.accounts.findIndex(a => a.email === accountInfo.email);

    if (existingIndex >= 0) {
        data.accounts[existingIndex] = { ...data.accounts[existingIndex], ...accountInfo };
    } else {
        data.accounts.push(accountInfo);
    }

    data.activeAccount = accountInfo.email;
    saveAccounts(data);
}

export default {
    handleListClaudeAccounts,
    handleClaudeAccountStatus,
    handleClaudeOAuthCleanup,
    handleAddClaudeAccount,
    handleAddClaudeAccountManual,
    handleSwitchClaudeAccount,
    handleRefreshClaudeAccount,
    handleRefreshAllClaudeAccounts,
    handleRefreshActiveClaudeAccount,
    handleToggleClaudeAccount,
    handleRemoveClaudeAccount,
    handleImportClaudeAccount
};
