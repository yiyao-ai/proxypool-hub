import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveAssignedCredential, resolveAssignedCredentials, normalizeAppRoutingConfig, orderAssignedCredentials } from '../../src/app-routing.js';

test('normalizeAppRoutingConfig preserves enabled and fallback flags for configured apps', () => {
  const normalized = normalizeAppRoutingConfig({
    codex: {
      enabled: true,
      fallbackToDefault: false,
      bindings: [{ type: 'api-key', targetId: 'missing-key' }]
    }
  });

  assert.equal(normalized.codex.enabled, true);
  assert.equal(normalized.codex.fallbackToDefault, false);
  assert.equal(normalized.codex.bindings.length, 1);
  assert.deepEqual(normalized.codex.bindings[0].targetIds, ['missing-key']);
});

test('normalizeAppRoutingConfig supports multi-target bindings', () => {
  const normalized = normalizeAppRoutingConfig({
    codex: {
      enabled: true,
      bindings: [{ type: 'api-key', targetIds: ['key-a', 'key-b'] }]
    }
  });

  assert.deepEqual(normalized.codex.bindings[0].targetIds, ['key-a', 'key-b']);
  assert.equal(normalized.codex.bindings[0].targetId, 'key-a');
});

test('resolveAssignedCredentials returns ordered assignments and failed attempts', () => {
  const result = resolveAssignedCredentials({
    appRouting: {
      codex: {
        enabled: true,
        fallbackToDefault: true,
        bindings: [
          { id: 'b1', type: 'api-key', targetId: 'missing-key' },
          { id: 'b2', type: 'chatgpt-account', targetId: 'missing-account@example.com' }
        ]
      }
    }
  }, 'codex');

  assert.equal(result.matched, true);
  assert.equal(Array.isArray(result.assignments), true);
  assert.equal(result.assignments.length, 0);
  assert.equal(Array.isArray(result.attempts), true);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].reason, 'api_key_not_found');
  assert.equal(result.attempts[1].reason, 'account_not_found');
  assert.equal(result.fallbackToDefault, true);
});

test('resolveAssignedCredentials expands multi-target bindings into ordered attempts', () => {
  const result = resolveAssignedCredentials({
    appRouting: {
      codex: {
        enabled: true,
        fallbackToDefault: true,
        bindings: [
          { id: 'b1', type: 'api-key', targetIds: ['missing-key-1', 'missing-key-2'] }
        ]
      }
    }
  }, 'codex');

  assert.equal(result.matched, true);
  assert.equal(result.assignments.length, 0);
  assert.equal(result.attempts.length, 2);
  assert.equal(result.attempts[0].binding.targetId, 'missing-key-1');
  assert.equal(result.attempts[1].binding.targetId, 'missing-key-2');
});

test('resolveAssignedCredential remains backward compatible and reports unavailable reason', () => {
  const result = resolveAssignedCredential({
    appRouting: {
      'claude-code': {
        enabled: true,
        fallbackToDefault: false,
        bindings: [
          { type: 'claude-account', targetId: 'missing-claude@example.com' }
        ]
      }
    }
  }, 'claude-code');

  assert.equal(result.matched, true);
  assert.equal(result.credential, undefined);
  assert.equal(result.unavailableReason, 'account_not_found');
  assert.equal(result.fallbackToDefault, false);
});

test('resolveAssignedCredentials supports local-model bindings', () => {
  const result = resolveAssignedCredentials({
    appRouting: {
      codex: {
        enabled: true,
        fallbackToDefault: false,
        bindings: [
          { type: 'local-model', targetId: 'qwen2.5-coder:7b' }
        ]
      }
    }
  }, 'codex');

  assert.equal(result.matched, true);
  assert.equal(result.assignments.length, 1);
  assert.equal(result.assignments[0].credentialType, 'local-model');
  assert.equal(result.assignments[0].credential.id, 'qwen2.5-coder:7b');
  assert.equal(result.assignments[0].credential.model, 'qwen2.5-coder:7b');
});

test('orderAssignedCredentials preserves original order for sequential strategy', () => {
  const assignments = [
    { credential: { email: 'a@example.com' } },
    { credential: { email: 'b@example.com' } },
    { credential: { email: 'c@example.com' } }
  ];

  const ordered = orderAssignedCredentials(assignments, 'sequential', () => 0.9);

  assert.deepEqual(
    ordered.map((item) => item.credential.email),
    ['a@example.com', 'b@example.com', 'c@example.com']
  );
  assert.notEqual(ordered, assignments);
});

test('orderAssignedCredentials shuffles order for random strategy', () => {
  const assignments = [
    { credential: { email: 'a@example.com' } },
    { credential: { email: 'b@example.com' } },
    { credential: { email: 'c@example.com' } }
  ];

  const randomValues = [0.8, 0.1];
  const ordered = orderAssignedCredentials(assignments, 'random', () => randomValues.shift() ?? 0);

  assert.deepEqual(
    ordered.map((item) => item.credential.email),
    ['b@example.com', 'a@example.com', 'c@example.com']
  );
  assert.deepEqual(
    assignments.map((item) => item.credential.email),
    ['a@example.com', 'b@example.com', 'c@example.com']
  );
});
