/**
 * Accounts Route
 * Handles all /accounts/* endpoints:
 *   GET    /accounts
 *   GET    /accounts/status
 *   GET    /accounts/quota
 *   GET    /accounts/quota/all
 *   POST   /accounts/add
 *   POST   /accounts/add/manual
 *   POST   /accounts/switch
 *   POST   /accounts/import
 *   POST   /accounts/refresh
 *   POST   /accounts/refresh/all
 *   POST   /accounts/:email/refresh
 *   POST   /accounts/oauth/cleanup
 *   DELETE /accounts/:email
 */

import {
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
  loadAccounts,
  saveAccounts,
  updateAccountAuth,
  updateAccountQuota,
  getAccountQuota
} from '../account-manager.js';

import {
  getAuthorizationUrl,
  generatePKCE,
  generateState,
  startCallbackServer,
  exchangeCodeForTokens,
  OAUTH_CONFIG,
  extractCodeFromInput,
  extractAccountInfo
} from '../oauth.js';

import {
  getAccountQuota as fetchAccountQuota
} from '../model-api.js';

import { logger } from '../utils/logger.js';

// Tracks active OAuth callback servers keyed by port
const activeCallbackServers = new Map();

// ─── Route Handlers ──────────────────────────────────────────────────────────

export function handleListAccounts(req, res) {
  res.json(listAccounts());
}

export function handleAccountStatus(req, res) {
  res.json(getStatus());
}

export function handleOAuthCleanup(req, res) {
  for (const [, server] of activeCallbackServers) {
    try { server.close(); } catch { /* ignore */ }
  }
  activeCallbackServers.clear();
  res.json({ success: true, message: 'OAuth servers cleaned up' });
}

export async function handleAddAccount(req, res) {
  const { port } = req.body || {};
  const callbackPort = port || OAUTH_CONFIG.callbackPort;

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
      error: 'Failed to start OAuth callback server',
      message: err.message,
      status: 'error'
    });
  }

  activeCallbackServers.set(callbackPort, serverResult);

  serverResult.promise
    .then(async code => {
      activeCallbackServers.delete(callbackPort);
      if (!code) return;

      const tokens = await exchangeCodeForTokens(code, verifier, callbackPort);
      const info = extractAccountInfo(tokens.accessToken);

      const accountInfo = {
        email: info?.email || 'unknown',
        accountId: info?.accountId,
        planType: info?.planType || 'free',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        expiresAt: info?.expiresAt || (Date.now() + tokens.expiresIn * 1000),
        addedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString()
      };

      await _upsertAccount(accountInfo);
      logger.info(`Added account: ${accountInfo.email} (${accountInfo.planType})`);
    })
    .catch(err => {
      activeCallbackServers.delete(callbackPort);
      logger.error(`OAuth token exchange failed: ${err.message}`);
    });

  res.json({
    status: 'oauth_url',
    oauth_url: oauthUrl,
    verifier,
    state,
    callback_port: callbackPort
  });
}

export async function handleAddAccountManual(req, res) {
  const { code, verifier } = req.body || {};

  if (!code) {
    return res.status(400).json({ success: false, error: 'Code is required' });
  }

  try {
    const { code: extractedCode } = extractCodeFromInput(code);
    const tokens = await exchangeCodeForTokens(extractedCode, verifier);
    const info = extractAccountInfo(tokens.accessToken);

    const accountInfo = {
      email: info?.email || 'unknown',
      accountId: info?.accountId,
      planType: info?.planType || 'free',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: info?.expiresAt || (Date.now() + tokens.expiresIn * 1000),
      addedAt: new Date().toISOString(),
      lastUsed: new Date().toISOString()
    };

    await _upsertAccount(accountInfo);
    logger.info(`Added account via manual OAuth: ${accountInfo.email}`);
    res.json({ success: true, message: `Account ${accountInfo.email} added successfully` });
  } catch (err) {
    logger.error(`Manual OAuth failed: ${err.message}`);
    res.status(400).json({ success: false, error: err.message });
  }
}

export function handleSwitchAccount(req, res) {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ success: false, message: 'Email is required' });
  }
  const result = setActiveAccount(email);
  if (result.success) {
    logger.info(`Switched to account: ${email}`);
  }
  res.json(result);
}

export async function handleRefreshAccount(req, res) {
  const email = decodeURIComponent(req.params.email);
  const result = await refreshAccountToken(email);
  if (result.success) {
    logger.info(`Refreshed token for: ${email}`);
  }
  res.json(result);
}

export async function handleRefreshAllAccounts(req, res) {
  const result = await refreshAllAccounts();
  res.json(result);
}

export async function handleRefreshActiveAccount(req, res) {
  const result = await refreshActiveAccount();
  res.json(result);
}

export function handleRemoveAccount(req, res) {
  const email = decodeURIComponent(req.params.email);
  const result = removeAccount(email);
  if (result.success) {
    logger.info(`Removed account: ${email}`);
  }
  res.json(result);
}

export function handleToggleAccount(req, res) {
  const email = decodeURIComponent(req.params.email);
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
  }
  const result = toggleAccount(email, enabled);
  if (result.success) {
    logger.info(`Account ${email} ${enabled ? 'enabled' : 'disabled'}`);
  }
  res.json(result);
}

export function handleImportAccount(req, res) {
  const result = importFromCodex();
  res.json(result);
}

export async function handleGetQuota(req, res) {
  const { email, refresh } = req.query;
  const account = email
    ? loadAccounts().accounts.find(a => a.email === email)
    : getActiveAccount();

  if (!account) {
    return res.status(404).json({
      success: false,
      error: email ? `Account not found: ${email}` : 'No active account'
    });
  }

  const cachedQuota = getAccountQuota(account.email);
  const isStale = !cachedQuota ||
    (Date.now() - new Date(cachedQuota.lastChecked).getTime() > 5 * 60 * 1000);

  if (refresh === 'true' || isStale) {
    try {
      const quotaData = await fetchAccountQuota(account.accessToken, account.accountId);
      updateAccountQuota(account.email, quotaData);
      res.json({ success: true, email: account.email, quota: quotaData, cached: false });
    } catch (error) {
      logger.error(`Failed to fetch quota: ${error.message}`);
      if (cachedQuota) {
        res.json({
          success: true,
          email: account.email,
          quota: cachedQuota,
          cached: true,
          warning: 'Using cached data due to fetch error'
        });
      } else {
        res.status(500).json({ success: false, error: error.message });
      }
    }
  } else {
    res.json({ success: true, email: account.email, quota: cachedQuota, cached: true });
  }
}

export async function handleGetAllQuotas(req, res) {
  const { accounts: accountList } = listAccounts();
  const results = [];

  for (const account of accountList) {
    try {
      const quota = await getAccountQuota(account.email);
      results.push({ email: account.email, quota: quota || null });
    } catch {
      results.push({ email: account.email, quota: null });
    }
  }

  res.json({ accounts: results });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Inserts or updates an account in the persisted accounts store,
 * and sets it as the active account.
 * @param {object} accountInfo
 */
async function _upsertAccount(accountInfo) {
  const data = loadAccounts();
  const existingIndex = data.accounts.findIndex(a => a.email === accountInfo.email);

  if (existingIndex >= 0) {
    data.accounts[existingIndex] = { ...data.accounts[existingIndex], ...accountInfo };
  } else {
    data.accounts.push(accountInfo);
  }

  data.activeAccount = accountInfo.email;
  saveAccounts(data);
  updateAccountAuth(accountInfo);
  
  // Fetch initial quota immediately
  try {
    const quotaData = await fetchAccountQuota(accountInfo.accessToken, accountInfo.accountId);
    updateAccountQuota(accountInfo.email, quotaData);
    logger.info(`Initial quota fetched for: ${accountInfo.email}`);
  } catch (err) {
    logger.warn(`Failed to fetch initial quota for ${accountInfo.email}: ${err.message}`);
  }
}

export default {
  handleListAccounts,
  handleAccountStatus,
  handleOAuthCleanup,
  handleAddAccount,
  handleAddAccountManual,
  handleSwitchAccount,
  handleRefreshAccount,
  handleRefreshAllAccounts,
  handleRefreshActiveAccount,
  handleRemoveAccount,
  handleToggleAccount,
  handleImportAccount,
  handleGetQuota,
  handleGetAllQuotas
};
