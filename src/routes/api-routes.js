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
import { handleGetHaikuModel, handleSetHaikuModel, handleGetKiloModels, handleGetAccountStrategy, handleSetAccountStrategy, handleGetRoutingPriority, handleSetRoutingPriority, handleGetRoutingMode, handleSetRoutingMode, handleGetStrictCodexCompatibility, handleSetStrictCodexCompatibility, handleGetStrictTranslatorCompatibility, handleSetStrictTranslatorCompatibility, handleGetAppRouting, handleSetAppRouting, handleGetEnableFreeModels, handleSetEnableFreeModels, handleGetDiscoveredModels, handleRefreshDiscoveredModels } from './settings-route.js';
import { handleGetLogs, handleStreamLogs } from './logs-route.js';
import { handleGetClaudeConfig, handleSetProxyMode, handleSetDirectMode, handleSetClaudeApiEndpoint } from './claude-config-route.js';
import { handleListApiKeys, handleGetApiKey, handleAddApiKey, handleRemoveApiKey, handleUpdateApiKey, handleValidateApiKey, handleGetApiKeyStats } from './api-keys-route.js';
import { handleGetUsageOverview, handleGetUsageHistory, handleGetDailyStats, handleGetMonthlyStats, handleGetProviderStats, handleGetModelStats, handleGetAccountStats } from './usage-route.js';
import { handleGetPricing, handleUpdatePricing, handleResetPricing } from './pricing-route.js';
import { handleGatewayChat, handleGatewayMessages, handleListProviders } from './gateway-route.js';
import { handleGetModelMappings, handleSetProviderMapping, handleResetModelMappings, handleResolveModel } from './model-mapping-route.js';
import { handleCodexResponses, handleCodexModels, handleCodexCatchAll } from './codex-route.js';
import { handleSetCodexProxy, handleGetCodexConfig, handleSetCodexDirect } from './codex-config-route.js';
import { handleGeminiApiProxy } from './gemini-api-route.js';
import { handleGetGeminiCliConfig, handleSetGeminiCliProxy, handleSetGeminiCliDirect } from './gemini-config-route.js';
import { handleGetOpenClawConfig, handleSetOpenClawProxy, handleSetOpenClawDirect } from './openclaw-config-route.js';
import { handleGetConfigFile } from './config-files-route.js';
import { handleListResources, handleGetResourceSummary, handleGetResourceById } from './resources-route.js';
import { handleGetRequestLogs, handleGetLogDates, handleGetLogSettings, handleUpdateLogSettings } from './request-logs-route.js';
import { handleGetToolsStatus, handleGetNodeInfo, handleInstallTool, handleInstallNode, handleLaunchTool, handleCheckUpdates, handleUpdateTool } from './tools-route.js';
import { handleListChatSources, handleChatWithSource, handleStreamChatWithSource } from './chat-ui-route.js';
import { handleGetRuntimeCredentials, handleGetRoutingDecisions, handleGetRoutingPreview } from './runtime-route.js';
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
  handleGetAllQuotas,
  handleToggleAccount
} from './accounts-route.js';

import {
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
} from './claude-accounts-route.js';
import {
  handleListAntigravityAccounts,
  handleAntigravityAccountStatus,
  handleAntigravityOAuthCleanup,
  handleAddAntigravityAccount,
  handleAddAntigravityAccountManual,
  handleImportAntigravityAccount,
  handleSwitchAntigravityAccount,
  handleRefreshAntigravityAccount,
  handleRefreshAllAntigravityAccounts,
  handleToggleAntigravityAccount,
  handleRemoveAntigravityAccount
} from './antigravity-accounts-route.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerApiRoutes(app, { port }) {
  // ─── Static Web UI ─────────────────────────────────────────────────────────
  // In Electron asar builds, static files must be served from the unpacked path
  const publicDir = join(__dirname, '..', '..', 'public');
  const staticDir = publicDir.includes('app.asar')
    ? publicDir.replace('app.asar', 'app.asar.unpacked')
    : publicDir;
  app.use(express.static(staticDir));

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
  app.get('/models', handleListModels);
  app.get('/v1/models', handleListModels);
  app.get('/accounts/models', handleAccountModels);
  app.get('/accounts/usage', handleAccountUsage);

  // ─── Settings ──────────────────────────────────────────────────────────────
  app.get('/settings/haiku-model', handleGetHaikuModel);
  app.post('/settings/haiku-model', handleSetHaikuModel);
  app.get('/settings/kilo-models', handleGetKiloModels);
  app.get('/settings/account-strategy', handleGetAccountStrategy);
  app.post('/settings/account-strategy', handleSetAccountStrategy);
  app.get('/settings/routing-priority', handleGetRoutingPriority);
  app.post('/settings/routing-priority', handleSetRoutingPriority);
  app.get('/settings/routing-mode', handleGetRoutingMode);
  app.post('/settings/routing-mode', handleSetRoutingMode);
  app.get('/settings/strict-codex-compatibility', handleGetStrictCodexCompatibility);
  app.post('/settings/strict-codex-compatibility', handleSetStrictCodexCompatibility);
  app.get('/settings/strict-translator-compatibility', handleGetStrictTranslatorCompatibility);
  app.post('/settings/strict-translator-compatibility', handleSetStrictTranslatorCompatibility);
  app.get('/settings/app-routing', handleGetAppRouting);
  app.post('/settings/app-routing', handleSetAppRouting);
  app.get('/settings/enable-free-models', handleGetEnableFreeModels);
  app.post('/settings/enable-free-models', handleSetEnableFreeModels);
  app.get('/settings/discovered-models', handleGetDiscoveredModels);
  app.post('/settings/refresh-models', handleRefreshDiscoveredModels);

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

  app.put('/accounts/:email/toggle', handleToggleAccount);
  app.delete('/accounts/:email', handleRemoveAccount);

  // ─── Claude Account Management ────────────────────────────────────────────
  app.get('/claude-accounts', handleListClaudeAccounts);
  app.get('/claude-accounts/status', handleClaudeAccountStatus);

  app.post('/claude-accounts/add', handleAddClaudeAccount);
  app.post('/claude-accounts/add/manual', handleAddClaudeAccountManual);
  app.post('/claude-accounts/switch', handleSwitchClaudeAccount);
  app.post('/claude-accounts/import', handleImportClaudeAccount);
  app.post('/claude-accounts/refresh', handleRefreshActiveClaudeAccount);
  app.post('/claude-accounts/refresh/all', handleRefreshAllClaudeAccounts);
  app.post('/claude-accounts/oauth/cleanup', handleClaudeOAuthCleanup);
  app.post('/claude-accounts/:email/refresh', handleRefreshClaudeAccount);

  app.put('/claude-accounts/:email/toggle', handleToggleClaudeAccount);
  app.delete('/claude-accounts/:email', handleRemoveClaudeAccount);

  // ─── Antigravity Account Management ──────────────────────────────────────
  app.get('/antigravity-accounts', handleListAntigravityAccounts);
  app.get('/antigravity-accounts/status', handleAntigravityAccountStatus);
  app.post('/antigravity-accounts/add', handleAddAntigravityAccount);
  app.post('/antigravity-accounts/add/manual', handleAddAntigravityAccountManual);
  app.post('/antigravity-accounts/import', handleImportAntigravityAccount);
  app.post('/antigravity-accounts/oauth/cleanup', handleAntigravityOAuthCleanup);
  app.post('/antigravity-accounts/switch', handleSwitchAntigravityAccount);
  app.post('/antigravity-accounts/refresh/all', handleRefreshAllAntigravityAccounts);
  app.post('/antigravity-accounts/:email/refresh', handleRefreshAntigravityAccount);
  app.put('/antigravity-accounts/:email/toggle', handleToggleAntigravityAccount);
  app.delete('/antigravity-accounts/:email', handleRemoveAntigravityAccount);

  // ─── Claude CLI Configuration ──────────────────────────────────────────────
  app.get('/claude/config', handleGetClaudeConfig);
  app.post('/claude/config/proxy', (req, res) => handleSetProxyMode(req, res, { port }));
  app.post('/claude/config/direct', handleSetDirectMode);
  app.post('/claude/config/set', handleSetClaudeApiEndpoint);

  // ─── Codex WebSocket probe — 426 tells it to use HTTPS silently ──────────
  app.get('/responses', (req, res) => res.status(426).end());
  app.get('/v1/responses', (req, res) => res.status(426).end());

  // ─── Codex CLI Configuration ─────────────────────────────────────────────
  app.get('/codex/config', handleGetCodexConfig);
  app.post('/codex/config/proxy', (req, res) => handleSetCodexProxy(req, res, { port }));
  app.post('/codex/config/direct', handleSetCodexDirect);

  // ─── Gemini CLI Configuration ──────────────────────────────────────────
  app.get('/gemini-cli/config', handleGetGeminiCliConfig);
  app.post('/gemini-cli/config/proxy', (req, res) => handleSetGeminiCliProxy(req, res, { port }));
  app.post('/gemini-cli/config/direct', handleSetGeminiCliDirect);

  // ─── OpenClaw Configuration ────────────────────────────────────────────
  app.get('/openclaw/config', handleGetOpenClawConfig);
  app.post('/openclaw/config/proxy', (req, res) => handleSetOpenClawProxy(req, res, { port }));
  app.post('/openclaw/config/direct', handleSetOpenClawDirect);

  // ─── Raw Config File Viewer ─────────────────────────────────────────────
  app.get('/config-files/:tool', handleGetConfigFile);

  // ─── Resource Catalog ───────────────────────────────────────────────────
  app.get('/api/resources', handleListResources);
  app.get('/api/resources/summary', handleGetResourceSummary);
  app.get('/api/resources/:id', handleGetResourceById);

  // ─── Gemini Native API Proxy (for Gemini CLI) ───────────────────────────
  app.post('/v1beta/models/*', handleGeminiApiProxy);
  app.get('/v1beta/models', handleGeminiApiProxy);
  app.get('/v1beta/models/*', handleGeminiApiProxy);

  // ─── Codex CLI Passthrough (OpenAI Responses API) ────────────────────────
  app.post('/backend-api/codex/responses', handleCodexResponses);
  app.get('/backend-api/codex/models', handleCodexModels);
  // Catch-all for other backend-api requests Codex may send
  app.all('/backend-api/*', handleCodexCatchAll);

  // ─── Logs ──────────────────────────────────────────────────────────────────
  app.get('/api/logs', handleGetLogs);
  app.get('/api/logs/stream', handleStreamLogs);

  // ─── API Key Management ──────────────────────────────────────────────────
  app.get('/api/keys', handleListApiKeys);
  app.post('/api/keys', handleAddApiKey);
  app.put('/api/keys/:id', handleUpdateApiKey);
  app.delete('/api/keys/:id', handleRemoveApiKey);
  app.post('/api/keys/:id/validate', handleValidateApiKey);
  app.get('/api/keys/stats', handleGetApiKeyStats);
  app.get('/api/keys/:id', handleGetApiKey);

  // ─── Usage & Analytics ───────────────────────────────────────────────────
  app.get('/api/usage/overview', handleGetUsageOverview);
  app.get('/api/usage/history', handleGetUsageHistory);
  app.get('/api/usage/daily', handleGetDailyStats);
  app.get('/api/usage/monthly', handleGetMonthlyStats);
  app.get('/api/usage/providers', handleGetProviderStats);
  app.get('/api/usage/models', handleGetModelStats);
  app.get('/api/usage/accounts', handleGetAccountStats);

  // ─── Pricing ─────────────────────────────────────────────────────────────
  app.get('/api/pricing', handleGetPricing);
  app.put('/api/pricing', handleUpdatePricing);
  app.post('/api/pricing/reset', handleResetPricing);

  // ─── Model Mapping ──────────────────────────────────────────────────────
  app.get('/api/model-mappings', handleGetModelMappings);
  app.put('/api/model-mappings/provider/:provider', handleSetProviderMapping);
  app.post('/api/model-mappings/reset', handleResetModelMappings);
  app.get('/api/model-mappings/resolve', handleResolveModel);

  // ─── Request Logs ─────────────────────────────────────────────────────────
  app.get('/api/request-logs', handleGetRequestLogs);
  app.get('/api/request-logs/dates', handleGetLogDates);
  app.get('/api/request-logs/settings', handleGetLogSettings);
  app.put('/api/request-logs/settings', handleUpdateLogSettings);

  // ─── Runtime Diagnostics ────────────────────────────────────────────────
  app.get('/api/runtime/credentials', handleGetRuntimeCredentials);
  app.get('/api/runtime/routing-decisions', handleGetRoutingDecisions);
  app.get('/api/runtime/routing-preview', handleGetRoutingPreview);

  // ─── Tool Installer ────────────────────────────────────────────────────
  app.get('/api/tools/status', handleGetToolsStatus);
  app.get('/api/tools/node-info', handleGetNodeInfo);
  app.post('/api/tools/install/:toolId', handleInstallTool);
  app.post('/api/tools/install-node', handleInstallNode);
  app.post('/api/tools/launch/:toolId', handleLaunchTool);
  app.post('/api/tools/check-updates', handleCheckUpdates);
  app.post('/api/tools/update/:toolId', handleUpdateTool);

  // ─── API Gateway (proxy via API keys) ────────────────────────────────────
  app.post('/api/gateway/chat', handleGatewayChat);
  app.post('/api/gateway/messages', handleGatewayMessages);
  app.get('/api/gateway/providers', handleListProviders);

  // Chat UI
  app.get('/api/chat/sources', handleListChatSources);
  app.post('/api/chat/complete', handleChatWithSource);
  app.post('/api/chat/stream', handleStreamChatWithSource);
}

export default { registerApiRoutes };
