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

import { handleGetHaikuModel, handleSetHaikuModel, handleGetAppRouting } from '../../src/routes/settings-route.js';
import { handleGetPricing, handleUpdatePricing, handleResetPricing } from '../../src/routes/pricing-route.js';

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
