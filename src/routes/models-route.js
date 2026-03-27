/**
 * Models Route
 * Handles:
 *   GET /v1/models            — OpenAI-compatible model list
 *   GET /accounts/models      — Raw model list for the active/specified account
 *   GET /accounts/usage       — Usage stats for the active/specified account
 */

import { fetchModels, fetchUsage } from '../model-api.js';
import { getActiveAccount, loadAccounts } from '../account-manager.js';
import { logger } from '../utils/logger.js';
import { getCredentialsOrError } from '../middleware/credentials.js';
import { getDiscoveredModels } from '../model-discovery.js';

// Static fallback — used when no accounts, no API keys, and no discovery data
const STATIC_FALLBACK_MODELS = [
  { id: 'gpt-5.3-codex', object: 'model', owned_by: 'openai' },
  { id: 'gpt-5.2-codex', object: 'model', owned_by: 'openai' },
  { id: 'gpt-5.1-codex', object: 'model', owned_by: 'openai' },
  { id: 'gpt-5.2', object: 'model', owned_by: 'openai' },
  { id: 'claude-opus-4-6', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-haiku-4-5', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-4-6-1m', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-6-1m', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-opus-4-5', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-5', object: 'model', owned_by: 'anthropic' }
];

/**
 * Build a dynamic fallback model list from discovery data + static defaults.
 */
function getFallbackModels() {
  const discovery = getDiscoveredModels();
  if (!discovery.lastRun) return STATIC_FALLBACK_MODELS;

  // Collect all discovered model IDs
  const seen = new Set();
  const models = [];

  for (const [providerType, data] of Object.entries(discovery.providers)) {
    const owner = providerType === 'openai' || providerType === 'azure-openai' ? 'openai' :
                  providerType === 'anthropic' ? 'anthropic' :
                  providerType === 'gemini' || providerType === 'vertex-ai' ? 'google' : providerType;
    for (const m of data.models || []) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        models.push({ id: m.id, object: 'model', owned_by: owner });
      }
    }
  }

  // Add static models not yet in the discovered list
  for (const m of STATIC_FALLBACK_MODELS) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      models.push(m);
    }
  }

  return models;
}

/**
 * GET /v1/models
 * Returns an OpenAI-compatible model list. Falls back to a static list on error.
 */
export async function handleListModels(req, res) {
  const creds = await getCredentialsOrError();

  if (!creds) {
    return res.json({ object: 'list', data: getFallbackModels() });
  }

  try {
    const models = await fetchModels(creds.accessToken, creds.accountId);
    const modelList = models.map(m => ({
      id: m.id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'openai',
      description: m.description
    }));
    res.json({ object: 'list', data: modelList });
  } catch (error) {
    logger.error(`Failed to fetch models: ${error.message}`);
    res.json({ object: 'list', data: getFallbackModels() });
  }
}

/**
 * GET /accounts/models
 * Returns the raw model list for the active or specified account.
 */
export async function handleAccountModels(req, res) {
  const account = _resolveAccount(req.query.email);

  if (!account) {
    return res.status(404).json({
      success: false,
      error: req.query.email ? `Account not found: ${req.query.email}` : 'No active account'
    });
  }

  try {
    const models = await fetchModels(account.accessToken, account.accountId);
    res.json({ success: true, email: account.email, models });
  } catch (error) {
    logger.error(`Failed to fetch models: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /accounts/usage
 * Returns usage stats for the active or specified account.
 */
export async function handleAccountUsage(req, res) {
  const account = _resolveAccount(req.query.email);

  if (!account) {
    return res.status(404).json({
      success: false,
      error: req.query.email ? `Account not found: ${req.query.email}` : 'No active account'
    });
  }

  try {
    const usage = await fetchUsage(account.accessToken, account.accountId);
    res.json({ success: true, email: account.email, usage });
  } catch (error) {
    logger.error(`Failed to fetch usage: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _resolveAccount(email) {
  if (email) {
    const data = loadAccounts();
    return data.accounts.find(a => a.email === email) || null;
  }
  return getActiveAccount();
}

export default { handleListModels, handleAccountModels, handleAccountUsage };
