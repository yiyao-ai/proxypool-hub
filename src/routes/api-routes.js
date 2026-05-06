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
import { handleGetHaikuModel, handleSetHaikuModel, handleGetKiloModels, handleGetAccountStrategy, handleSetAccountStrategy, handleGetRoutingPriority, handleSetRoutingPriority, handleGetRoutingMode, handleSetRoutingMode, handleGetStrictCodexCompatibility, handleSetStrictCodexCompatibility, handleGetStrictTranslatorCompatibility, handleSetStrictTranslatorCompatibility, handleGetAppRouting, handleSetAppRouting, handleGetEnableFreeModels, handleSetEnableFreeModels, handleGetAssistantAgentConfig, handleSetAssistantAgentConfig, handleGetLocalModelRoutingEnabled, handleSetLocalModelRoutingEnabled, handleGetDiscoveredModels, handleRefreshDiscoveredModels } from './settings-route.js';
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
import {
  handleListChatSources,
  handleChatWithSource,
  handleStreamChatWithSource,
  handleConfirmAssistantToolAction,
  handleGetChatAgentSession,
  handleRouteChatAgentMessage
} from './chat-ui-route.js';
import { handleGetRuntimeCredentials, handleGetRoutingDecisions, handleGetRoutingPreview, handleGetLocalRoutingStatus } from './runtime-route.js';
import { handleGetLocalRuntimeStatus, handleSetLocalRuntimeEnabled, handleUpdateLocalRuntime, handleCheckLocalRuntime, handleRefreshLocalRuntimeModels } from './local-runtimes-route.js';
import {
  handleListAgentRuntimeProviders,
  handleListAgentRuntimeSessions,
  handleGetAgentRuntimeSession,
  handleGetAgentRuntimeTurn,
  handleCreateAgentRuntimeSession,
  handleSendAgentRuntimeInput,
  handleResolveAgentRuntimeApproval,
  handleAnswerAgentRuntimeQuestion,
  handleCancelAgentRuntimeSession,
  handleStreamAgentRuntimeSession
} from './agent-runtimes-route.js';
import {
  handleGetAssistantWorkspaceContext,
  handleListAssistantRuntimeSessions,
  handleGetAssistantRuntimeSession,
  handleGetAssistantRuntimeTurn,
  handleListAssistantConversations,
  handleGetAssistantConversationContext,
  handleCancelAssistantClarification,
  handleAddAssistantWorkspaceAlias
} from './assistant-observation-route.js';
import {
  handleListAssistantRuns,
  handleGetAssistantRun,
  handleResumeAssistantRun
} from './assistant-runs-route.js';
import {
  handleGetAssistantMemory,
  handleGetAssistantPolicies
} from './assistant-memory-route.js';
import {
  handleListAssistantTasks,
  handleGetAssistantTask
} from './assistant-tasks-route.js';
import {
  handleGetAssistantAgentStatus,
  handleTestAssistantBinding,
  handleGetAssistantBindingCatalog,
  handleSetAssistantBinding,
  handleResetAssistantBreaker
} from './assistant-agent-route.js';
import {
  handleListAgentChannelProviders,
  handleGetAgentChannelCatalog,
  handleGetAgentChannelSettings,
  handleCreateAgentChannelInstance,
  handleUpdateAgentChannelSettings,
  handleDeleteAgentChannelInstance,
  handleRefreshAgentChannels,
  handleFeishuChannelWebhook,
  handleDingTalkChannelWebhook,
  handleListAgentChannelConversations,
  handleGetAgentChannelConversation,
  handleListAgentChannelSessionRecords,
  handleGetAgentChannelSessionRecord,
  handleResetAgentChannelConversation,
  handleApproveAgentChannelPairing,
  handleDenyAgentChannelPairing
} from './agent-channels-route.js';
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
  handleGetClaudeQuotas,
  handleRefreshClaudeQuota,
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
  app.get('/settings/assistant-agent', handleGetAssistantAgentConfig);
  app.post('/settings/assistant-agent', handleSetAssistantAgentConfig);
  app.get('/settings/local-model-routing-enabled', handleGetLocalModelRoutingEnabled);
  app.post('/settings/local-model-routing-enabled', handleSetLocalModelRoutingEnabled);
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
  app.get('/claude-accounts/quota/all', handleGetClaudeQuotas);

  app.post('/claude-accounts/add', handleAddClaudeAccount);
  app.post('/claude-accounts/add/manual', handleAddClaudeAccountManual);
  app.post('/claude-accounts/switch', handleSwitchClaudeAccount);
  app.post('/claude-accounts/import', handleImportClaudeAccount);
  app.post('/claude-accounts/refresh', handleRefreshActiveClaudeAccount);
  app.post('/claude-accounts/refresh/all', handleRefreshAllClaudeAccounts);
  app.post('/claude-accounts/oauth/cleanup', handleClaudeOAuthCleanup);
  app.post('/claude-accounts/:email/refresh', handleRefreshClaudeAccount);
  app.post('/claude-accounts/:email/quota/refresh', handleRefreshClaudeQuota);

  app.put('/claude-accounts/:email/toggle', handleToggleClaudeAccount);
  app.delete('/claude-accounts/:email', handleRemoveClaudeAccount);

  // ─── Antigravity Account Management ──────────────────────────────────────
  app.get('/antigravity-accounts', handleListAntigravityAccounts);
  app.get('/antigravity-accounts/status', handleAntigravityAccountStatus);
  app.get('/antigravity-accounts/quota/all', handleGetAntigravityQuotas);
  app.post('/antigravity-accounts/add', handleAddAntigravityAccount);
  app.post('/antigravity-accounts/add/manual', handleAddAntigravityAccountManual);
  app.post('/antigravity-accounts/import', handleImportAntigravityAccount);
  app.post('/antigravity-accounts/oauth/cleanup', handleAntigravityOAuthCleanup);
  app.post('/antigravity-accounts/switch', handleSwitchAntigravityAccount);
  app.post('/antigravity-accounts/refresh/all', handleRefreshAllAntigravityAccounts);
  app.post('/antigravity-accounts/:email/refresh', handleRefreshAntigravityAccount);
  app.post('/antigravity-accounts/:email/quota/refresh', handleRefreshAntigravityQuota);
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
  app.get('/api/runtime/local-routing', handleGetLocalRoutingStatus);

  // ─── Local Runtime Management ────────────────────────────────────────────
  app.get('/api/local-runtimes', handleGetLocalRuntimeStatus);
  app.put('/api/local-runtimes/ollama-local', handleUpdateLocalRuntime);
  app.post('/api/local-runtimes/enabled', handleSetLocalRuntimeEnabled);
  app.post('/api/local-runtimes/check', handleCheckLocalRuntime);
  app.post('/api/local-runtimes/refresh-models', handleRefreshLocalRuntimeModels);

  // ─── Agent Runtime Orchestrator ──────────────────────────────────────────
  app.get('/api/agent-runtimes/providers', handleListAgentRuntimeProviders);
  app.get('/api/agent-runtimes/sessions', handleListAgentRuntimeSessions);
  app.post('/api/agent-runtimes/sessions', handleCreateAgentRuntimeSession);
  app.get('/api/agent-runtimes/sessions/:id', handleGetAgentRuntimeSession);
  app.get('/api/agent-runtimes/sessions/:id/turns/:turnId', handleGetAgentRuntimeTurn);
  app.get('/api/agent-runtimes/sessions/:id/stream', handleStreamAgentRuntimeSession);
  app.post('/api/agent-runtimes/sessions/:id/input', handleSendAgentRuntimeInput);
  app.post('/api/agent-runtimes/sessions/:id/approval', handleResolveAgentRuntimeApproval);
  app.post('/api/agent-runtimes/sessions/:id/question', handleAnswerAgentRuntimeQuestion);
  app.post('/api/agent-runtimes/sessions/:id/cancel', handleCancelAgentRuntimeSession);

  // ─── Assistant Observation ───────────────────────────────────────────────
  app.get('/api/assistant/workspace-context', handleGetAssistantWorkspaceContext);
  app.get('/api/assistant/runtime-sessions', handleListAssistantRuntimeSessions);
  app.get('/api/assistant/runtime-sessions/:id', handleGetAssistantRuntimeSession);
  app.get('/api/assistant/runtime-sessions/:id/turns/:turnId', handleGetAssistantRuntimeTurn);
  app.get('/api/assistant/conversations', handleListAssistantConversations);
  app.get('/api/assistant/conversations/:id', handleGetAssistantConversationContext);
  app.post('/api/assistant/clarifications/:id/cancel', handleCancelAssistantClarification);
  app.post('/api/assistant/workspaces/aliases', handleAddAssistantWorkspaceAlias);
  app.get('/api/assistant/runs', handleListAssistantRuns);
  app.get('/api/assistant/runs/:id', handleGetAssistantRun);
  app.post('/api/assistant/runs/:id/resume', handleResumeAssistantRun);
  app.get('/api/assistant/tasks', handleListAssistantTasks);
  app.get('/api/assistant/tasks/:id', handleGetAssistantTask);
  app.get('/api/assistant/memory', handleGetAssistantMemory);
  app.get('/api/assistant/policies', handleGetAssistantPolicies);
  app.get('/api/assistant/agent-status', handleGetAssistantAgentStatus);
  app.get('/api/assistant/agent-binding/catalog', handleGetAssistantBindingCatalog);
  app.post('/api/assistant/agent-binding', handleSetAssistantBinding);
  app.post('/api/assistant/agent-binding/test', handleTestAssistantBinding);
  app.post('/api/assistant/agent-binding/breaker/reset', handleResetAssistantBreaker);

  // ─── Agent Channel Gateway ──────────────────────────────────────────────
  app.get('/api/agent-channels/providers', handleListAgentChannelProviders);
  app.get('/api/agent-channels/catalog', handleGetAgentChannelCatalog);
  app.get('/api/agent-channels/settings', handleGetAgentChannelSettings);
  app.post('/api/agent-channels/settings/:channel', handleCreateAgentChannelInstance);
  app.put('/api/agent-channels/settings/:channel/:instanceId', handleUpdateAgentChannelSettings);
  app.delete('/api/agent-channels/settings/:channel/:instanceId', handleDeleteAgentChannelInstance);
  app.post('/api/agent-channels/refresh', handleRefreshAgentChannels);
  app.post('/api/agent-channels/feishu/webhook', handleFeishuChannelWebhook);
  app.post('/api/agent-channels/dingtalk/webhook', handleDingTalkChannelWebhook);
  app.get('/api/agent-channels/session-records', handleListAgentChannelSessionRecords);
  app.get('/api/agent-channels/session-records/:id', handleGetAgentChannelSessionRecord);
  app.get('/api/agent-channels/conversations', handleListAgentChannelConversations);
  app.get('/api/agent-channels/conversations/:id', handleGetAgentChannelConversation);
  app.post('/api/agent-channels/conversations/:id/reset', handleResetAgentChannelConversation);
  app.post('/api/agent-channels/pairing/:channel/:conversationId/approve', handleApproveAgentChannelPairing);
  app.post('/api/agent-channels/pairing/:channel/:conversationId/deny', handleDenyAgentChannelPairing);

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
  app.get('/api/chat/sessions/:sessionId', handleGetChatAgentSession);
  app.post('/api/chat/agent-message', handleRouteChatAgentMessage);
  app.post('/api/chat/tool-confirm', handleConfirmAssistantToolAction);
}

export default { registerApiRoutes };
