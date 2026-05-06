/**
 * Unit tests for route handlers (no server required).
 * Uses lightweight mock req/res objects to test handler logic in isolation.
 *
 * Covers:
 *  - settings-route.js  (GET/POST /settings/haiku-model)
 *  - claude-config-route.js (POST /claude/config/direct validation)
 *  - accounts-route.js  (POST /accounts/switch validation)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

function mockRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
  return res;
}

function mockReq(body = {}, params = {}, query = {}) {
  return { body, params, query };
}

// ─── settings-route ───────────────────────────────────────────────────────────

import { handleGetHaikuModel, handleSetHaikuModel, handleGetAppRouting, handleSetAppRouting, handleGetStrictCodexCompatibility, handleSetStrictCodexCompatibility, handleGetStrictTranslatorCompatibility, handleSetStrictTranslatorCompatibility, handleGetAssistantAgentConfig, handleSetAssistantAgentConfig } from '../../src/routes/settings-route.js';
import { handleGetPricing, handleUpdatePricing, handleResetPricing } from '../../src/routes/pricing-route.js';
import { handleGetApiKey } from '../../src/routes/api-keys-route.js';
import {
  handleGetAssistantAgentStatus,
  handleTestAssistantBinding,
  handleGetAssistantBindingCatalog,
  handleSetAssistantBinding,
  handleResetAssistantBreaker
} from '../../src/routes/assistant-agent-route.js';

test('handleGetHaikuModel: returns current haikuKiloModel', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetHaikuModel(req, res);
  assert.ok(res._body !== null);
  assert.ok('haikuKiloModel' in res._body);
  // Default is now the full model ID
  assert.ok(typeof res._body.haikuKiloModel === 'string');
});

test('handleGetAppRouting: exposes antigravity binding targets', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetAppRouting(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(Array.isArray(res._body.targets?.bindingTypes));
  assert.ok(res._body.targets.bindingTypes.includes('antigravity-account'));
  assert.ok(Array.isArray(res._body.targets?.antigravityAccounts));
});

test('handleSetAppRouting: rejects enabled binding without selected targets', () => {
  const req = mockReq({
    appRouting: {
      codex: {
        enabled: true,
        bindings: [{ type: 'api-key', targetIds: [] }]
      }
    }
  });
  const res = mockRes();
  handleSetAppRouting(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
  assert.match(res._body.error, /at least one targetId is required/);
});

test('handleGetStrictCodexCompatibility: returns current strict compatibility flag', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetStrictCodexCompatibility(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.strictCodexCompatibility, 'boolean');
});

test('handleSetStrictCodexCompatibility: rejects non-boolean payload', () => {
  const req = mockReq({ strictCodexCompatibility: 'yes' });
  const res = mockRes();
  handleSetStrictCodexCompatibility(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleGetStrictTranslatorCompatibility: returns current strict translator flag', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetStrictTranslatorCompatibility(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.strictTranslatorCompatibility, 'boolean');
});

test('handleSetStrictTranslatorCompatibility: rejects non-boolean payload', () => {
  const req = mockReq({ strictTranslatorCompatibility: 'yes' });
  const res = mockRes();
  handleSetStrictTranslatorCompatibility(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleGetAssistantAgentConfig: returns current assistant agent settings', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetAssistantAgentConfig(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.assistantAgent?.enabled, 'boolean');
  assert.equal(typeof res._body.assistantAgent?.sources?.anthropicApiKey, 'boolean');
  assert.equal(res._body.assistantAgent.enabled, true);
});

test('handleSetAssistantAgentConfig: rejects malformed payload', () => {
  const req = mockReq({
    assistantAgent: {
      enabled: 'yes',
      sources: {}
    }
  });
  const res = mockRes();
  handleSetAssistantAgentConfig(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleSetAssistantAgentConfig: accepts complete boolean source map', () => {
  const req = mockReq({
    assistantAgent: {
      enabled: true,
      sources: {
        chatgptAccount: false,
        claudeAccount: false,
        anthropicApiKey: true,
        openaiApiKeyBridge: true,
        azureOpenaiApiKeyBridge: false
      }
    }
  });
  const res = mockRes();
  handleSetAssistantAgentConfig(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.assistantAgent.enabled, true);
  assert.equal(res._body.assistantAgent.sources.azureOpenaiApiKeyBridge, false);
});

test('handleGetAssistantAgentStatus: returns status payload shape', async () => {
  const req = mockReq();
  const res = mockRes();
  await handleGetAssistantAgentStatus(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(typeof res._body.status?.enabled, 'boolean');
  assert.ok(Array.isArray(res._body.status?.statuses));
  assert.ok(Array.isArray(res._body.status?.tiers));
  assert.ok(res._body.status?.catalog && typeof res._body.status.catalog === 'object');
});

test('handleTestAssistantBinding: reports failure when descriptor is invalid', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleTestAssistantBinding(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, false);
  assert.match(String(res._body.reason || ''), /not found|disabled|no descriptor/i);
});

test('handleTestAssistantBinding: reports failure for non-existent api key', async () => {
  const req = mockReq({ type: 'api-key', id: 'no-such-key-anywhere' });
  const res = mockRes();
  await handleTestAssistantBinding(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, false);
});

test('handleGetAssistantBindingCatalog: returns inventory groups', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetAssistantBindingCatalog(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(res._body.catalog?.apiKeys);
  assert.ok(Array.isArray(res._body.catalog?.claudeAccounts));
  assert.ok(Array.isArray(res._body.catalog?.chatgptAccounts));
});

test('handleSetAssistantBinding: rejects non-object body', () => {
  const req = { body: null };
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleSetAssistantBinding: rejects malformed boundCredential', () => {
  const req = mockReq({ boundCredential: { type: 'api-key' } });
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 400);
  assert.match(String(res._body.error || ''), /boundCredential/);
});

test('handleSetAssistantBinding: rejects malformed fallbacks', () => {
  const req = mockReq({ fallbacks: 'nope' });
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 400);
  assert.match(String(res._body.error || ''), /fallbacks/);
});

test('handleSetAssistantBinding: accepts boundCredential = null (clear binding)', () => {
  const req = mockReq({ boundCredential: null });
  const res = mockRes();
  handleSetAssistantBinding(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.assistantAgent.boundCredential, null);
});

test('handleResetAssistantBreaker: resets all when no descriptor given', () => {
  const req = mockReq({});
  const res = mockRes();
  handleResetAssistantBreaker(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(res._body.breaker && typeof res._body.breaker === 'object');
});

test('handleResetAssistantBreaker: rejects malformed descriptor', () => {
  const req = mockReq({ descriptor: { id: 42 } });
  const res = mockRes();
  handleResetAssistantBreaker(req, res);
  assert.equal(res._status, 400);
});

test('handleSetHaikuModel: rejects empty body with 400', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleSetHaikuModel(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleSetHaikuModel: rejects null body gracefully', async () => {
  const req = { body: null };
  const res = mockRes();
  await handleSetHaikuModel(req, res);
  assert.equal(res._status, 400);
});

test('handleSetHaikuModel: rejects non-string model with 400', async () => {
  const req = mockReq({ haikuKiloModel: 123 });
  const res = mockRes();
  await handleSetHaikuModel(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
});

test('handleGetPricing: returns pricing summary and entries', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetPricing(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(Array.isArray(res._body.entries));
  assert.ok(res._body.entries.length > 0);
  assert.ok(typeof res._body.summary?.models === 'number');
});

test('handleUpdatePricing + handleResetPricing: manage override lifecycle', () => {
  const updateReq = mockReq({
    provider: 'openai',
    model: 'gpt-5.4',
    input: 9.99,
    output: 19.99,
    cacheRead: 0.1,
    cacheWrite: 0.2
  });
  const updateRes = mockRes();
  handleUpdatePricing(updateReq, updateRes);
  assert.equal(updateRes._status, 200);
  assert.equal(updateRes._body.success, true);
  assert.equal(updateRes._body.entry.hasOverride, true);
  assert.equal(updateRes._body.entry.effective.input, 9.99);

  const resetReq = mockReq({ provider: 'openai', model: 'gpt-5.4' });
  const resetRes = mockRes();
  handleResetPricing(resetReq, resetRes);
  assert.equal(resetRes._status, 200);
  assert.equal(resetRes._body.success, true);
  assert.equal(resetRes._body.entry.hasOverride, false);
});

// ─── claude-config-route ──────────────────────────────────────────────────────

import { handleSetDirectMode } from '../../src/routes/claude-config-route.js';

test('handleSetDirectMode: rejects missing apiKey with 400', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleSetDirectMode(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
  assert.equal(res._body.error, 'API key required');
});

test('handleSetDirectMode: rejects null body with 400', async () => {
  const req = { body: null };
  const res = mockRes();
  await handleSetDirectMode(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.error, 'API key required');
});

// ─── accounts-route ───────────────────────────────────────────────────────────

import { handleSwitchAccount } from '../../src/routes/accounts-route.js';
import { handleAddAntigravityAccount } from '../../src/routes/antigravity-accounts-route.js';

test('handleSwitchAccount: rejects missing email with 400', () => {
  const req = mockReq({});
  const res = mockRes();
  handleSwitchAccount(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
  assert.equal(res._body.message, 'Email is required');
});

test('handleSwitchAccount: rejects null body with 400', () => {
  const req = { body: null };
  const res = mockRes();
  handleSwitchAccount(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.message, 'Email is required');
});

test('handleSwitchAccount: returns result for non-existent email (graceful)', () => {
  // The account doesn't exist, but the handler should still return a JSON response
  const req = mockReq({ email: 'nonexistent@example.com' });
  const res = mockRes();
  handleSwitchAccount(req, res);
  // Should return a response (success or failure) but not throw
  assert.ok(res._body !== null);
  assert.ok('success' in res._body);
});

test('handleAddAntigravityAccount: rejects OAuth setup when client secret is missing', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleAddAntigravityAccount(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
  assert.match(String(res._body.error || ''), /ANTIGRAVITY_GOOGLE_CLIENT_SECRET/);
});

import { handleAddAccountManual } from '../../src/routes/accounts-route.js';
import { handleGetConfigFile } from '../../src/routes/config-files-route.js';
import { handleListResources, handleGetResourceSummary, handleGetResourceById } from '../../src/routes/resources-route.js';

test('handleAddAccountManual: rejects missing code with 400', async () => {
  const req = mockReq({});
  const res = mockRes();
  await handleAddAccountManual(req, res);
  assert.equal(res._status, 400);
  assert.equal(res._body.success, false);
  assert.equal(res._body.error, 'Code is required');
});

test('handleGetConfigFile: rejects unsupported tool with 404', () => {
  const req = mockReq({}, { tool: 'unknown-tool' });
  const res = mockRes();
  handleGetConfigFile(req, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.success, false);
});

test('handleGetConfigFile: returns file payload for codex', () => {
  const req = mockReq({}, { tool: 'codex' });
  const res = mockRes();
  handleGetConfigFile(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.tool, 'codex');
  assert.ok(typeof res._body.file?.path === 'string' && res._body.file.path.length > 0);
  assert.ok(typeof res._body.file?.exists === 'boolean');
  assert.ok(typeof res._body.file?.content === 'string');
});

test('handleGetApiKey: returns 404 for unknown API key id', () => {
  const req = mockReq({}, { id: 'nonexistent-key-id' });
  const res = mockRes();
  handleGetApiKey(req, res);
  assert.equal(res._status, 404);
  assert.equal(res._body.success, false);
});

test('handleListResources: returns catalog list and summary', () => {
  const req = mockReq({}, {}, { category: 'free', status: 'all', q: '' });
  const res = mockRes();
  handleListResources(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(Array.isArray(res._body.items));
  assert.ok(res._body.items.length > 0);
  assert.ok(typeof res._body.summary?.total === 'number');
});

test('handleGetResourceSummary: returns counts', () => {
  const req = mockReq();
  const res = mockRes();
  handleGetResourceSummary(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.ok(typeof res._body.summary?.free === 'number');
});

test('handleGetResourceById: returns item for openrouter', () => {
  const req = mockReq({}, { id: 'openrouter' });
  const res = mockRes();
  handleGetResourceById(req, res);
  assert.equal(res._status, 200);
  assert.equal(res._body.success, true);
  assert.equal(res._body.item?.id, 'openrouter');
});
