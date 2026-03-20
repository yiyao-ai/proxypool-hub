/**
 * API Routes
 * Thin registration layer — wires all route modules to the Express app.
 * Business logic lives in the individual route files under src/routes/.
 */

import express from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getStatus, ACCOUNTS_FILE } from '../account-manager.js';

// Route handlers
import { handleMessages } from './messages-route.js';
import { handleChatCompletion, handleCountTokens } from './chat-route.js';
import { handleListModels, handleAccountModels, handleAccountUsage } from './models-route.js';
import { handleGetHaikuModel, handleSetHaikuModel, handleGetKiloModels, handleGetAccountStrategy, handleSetAccountStrategy } from './settings-route.js';
import { handleGetLogs, handleStreamLogs } from './logs-route.js';
import { handleGetClaudeConfig, handleSetProxyMode, handleSetDirectMode, handleSetClaudeApiEndpoint } from './claude-config-route.js';
import {
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
  handleImportAccount,
  handleGetQuota,
  handleGetAllQuotas
} from './accounts-route.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerApiRoutes(app, { port }) {
  // ─── Static Web UI ─────────────────────────────────────────────────────────
  app.use(express.static(join(__dirname, '..', '..', 'public')));

  // ─── Health ────────────────────────────────────────────────────────────────
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', ...getStatus(), configPath: ACCOUNTS_FILE });
  });

  // ─── Anthropic Messages API ────────────────────────────────────────────────
  app.post('/v1/messages', handleMessages);
  app.post('/v1/messages/count_tokens', handleCountTokens);

  // ─── OpenAI Chat Completions API ───────────────────────────────────────────
  app.post('/v1/chat/completions', handleChatCompletion);

  // ─── Models ────────────────────────────────────────────────────────────────
  app.get('/v1/models', handleListModels);
  app.get('/accounts/models', handleAccountModels);
  app.get('/accounts/usage', handleAccountUsage);

  // ─── Settings ──────────────────────────────────────────────────────────────
  app.get('/settings/haiku-model', handleGetHaikuModel);
  app.post('/settings/haiku-model', handleSetHaikuModel);
  app.get('/settings/kilo-models', handleGetKiloModels);
  app.get('/settings/account-strategy', handleGetAccountStrategy);
  app.post('/settings/account-strategy', handleSetAccountStrategy);

  // ─── Account Management ───────────────────────────────────────────────────
  app.get('/accounts', handleListAccounts);
  app.get('/accounts/status', handleAccountStatus);
  app.get('/accounts/quota', handleGetQuota);
  app.get('/accounts/quota/all', handleGetAllQuotas);

  app.post('/accounts/add', handleAddAccount);
  app.post('/accounts/add/manual', handleAddAccountManual);
  app.post('/accounts/switch', handleSwitchAccount);
  app.post('/accounts/import', handleImportAccount);
  app.post('/accounts/refresh', handleRefreshActiveAccount);
  app.post('/accounts/refresh/all', handleRefreshAllAccounts);
  app.post('/accounts/oauth/cleanup', handleOAuthCleanup);
  app.post('/accounts/:email/refresh', handleRefreshAccount);

  app.delete('/accounts/:email', handleRemoveAccount);

  // ─── Claude CLI Configuration ──────────────────────────────────────────────
  app.get('/claude/config', handleGetClaudeConfig);
  app.post('/claude/config/proxy', (req, res) => handleSetProxyMode(req, res, { port }));
  app.post('/claude/config/direct', handleSetDirectMode);
  app.post('/claude/config/set', handleSetClaudeApiEndpoint);

  // ─── Logs ──────────────────────────────────────────────────────────────────
  app.get('/api/logs', handleGetLogs);
  app.get('/api/logs/stream', handleStreamLogs);
}

export default { registerApiRoutes };
