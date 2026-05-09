import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeAssistantAgentConfig,
    normalizeBoundCredential,
    normalizeFallbacks,
    normalizeCircuitBreaker,
    ASSISTANT_FALLBACKS_MAX
} from '../../src/server-settings.js';

test('normalizeBoundCredential rejects unknown types and missing ids', () => {
    assert.equal(normalizeBoundCredential(null), null);
    assert.equal(normalizeBoundCredential({}), null);
    assert.equal(normalizeBoundCredential({ type: 'invalid', id: 'x' }), null);
    assert.equal(normalizeBoundCredential({ type: 'api-key' }), null);
    assert.equal(normalizeBoundCredential({ type: 'api-key', id: '' }), null);
    assert.deepEqual(normalizeBoundCredential({ type: 'api-key', id: 'key_x' }), { type: 'api-key', id: 'key_x' });
    assert.deepEqual(normalizeBoundCredential({ type: 'claude-account', id: 'me@example' }), { type: 'claude-account', id: 'me@example' });
    assert.deepEqual(normalizeBoundCredential({ type: 'chatgpt-account', id: 'me@example' }), { type: 'chatgpt-account', id: 'me@example' });
});

test('normalizeBoundCredential trims whitespace and ignores extra fields', () => {
    assert.deepEqual(
        normalizeBoundCredential({ type: '  api-key  ', id: '  key_x  ', model: ' gpt-5.4 ', extra: 'ignored' }),
        { type: 'api-key', id: 'key_x', model: 'gpt-5.4' }
    );
});

test('normalizeFallbacks dedupes, drops invalid, caps at the configured max', () => {
    const input = [
        { type: 'api-key', id: 'a' },
        { type: 'api-key', id: 'a' },                  // duplicate
        { type: 'invalid', id: 'b' },                  // invalid type
        null,                                           // null
        { type: 'claude-account', id: 'me@example' },
        { type: 'chatgpt-account', id: 'me@example' },
        { type: 'api-key', id: 'b' }                   // would exceed cap
    ];

    const result = normalizeFallbacks(input);
    assert.equal(result.length, ASSISTANT_FALLBACKS_MAX);
    assert.deepEqual(result, [
        { type: 'api-key', id: 'a' },
        { type: 'claude-account', id: 'me@example' },
        { type: 'chatgpt-account', id: 'me@example' }
    ]);
});

test('normalizeFallbacks returns empty array when input is not an array', () => {
    assert.deepEqual(normalizeFallbacks(null), []);
    assert.deepEqual(normalizeFallbacks('string'), []);
    assert.deepEqual(normalizeFallbacks({}), []);
});

test('normalizeCircuitBreaker clamps to default-bounded ranges', () => {
    const cleaned = normalizeCircuitBreaker({ failureThreshold: 100, probeIntervalMs: 99 });
    assert.equal(cleaned.failureThreshold, 10);            // upper bound
    assert.equal(cleaned.probeIntervalMs, 60_000);         // lower bound

    const tooLow = normalizeCircuitBreaker({ failureThreshold: 0, probeIntervalMs: 10_000_000 });
    assert.equal(tooLow.failureThreshold, 1);              // lower bound
    assert.equal(tooLow.probeIntervalMs, 3_600_000);       // upper bound

    const fallback = normalizeCircuitBreaker(null);
    assert.equal(fallback.failureThreshold, 3);
    assert.equal(fallback.probeIntervalMs, 300_000);
});

test('normalizeAssistantAgentConfig fills defaults for fresh empty input', () => {
    const result = normalizeAssistantAgentConfig({});
    assert.equal(result.enabled, false);                   // default false unless explicit true
    assert.equal(result.bindingConfigured, false);
    assert.equal(result.boundModelSource, null);
    assert.equal(result.boundCredential, null);
    assert.deepEqual(result.fallbacks, []);
    assert.deepEqual(result.circuitBreaker, { failureThreshold: 3, probeIntervalMs: 300_000 });
    // Legacy `sources` block also returned with safe defaults so existing callers don't break.
    assert.equal(typeof result.sources?.anthropicApiKey, 'boolean');
});

test('normalizeAssistantAgentConfig preserves a valid new-shape config', () => {
    const result = normalizeAssistantAgentConfig({
        enabled: true,
        boundModelSource: { type: 'api-key', id: 'key_a', model: 'gpt-5.4' },
        fallbacks: [
            { type: 'claude-account', id: 'me@example' },
            { type: 'chatgpt-account', id: 'me@example' }
        ],
        circuitBreaker: { failureThreshold: 5, probeIntervalMs: 600_000 }
    });
    assert.equal(result.enabled, true);
    assert.equal(result.bindingConfigured, true);
    assert.deepEqual(result.boundModelSource, { type: 'api-key', id: 'key_a', model: 'gpt-5.4' });
    assert.deepEqual(result.boundCredential, { type: 'api-key', id: 'key_a', model: 'gpt-5.4' });
    assert.equal(result.fallbacks.length, 2);
    assert.equal(result.circuitBreaker.failureThreshold, 5);
    assert.equal(result.circuitBreaker.probeIntervalMs, 600_000);
});

test('normalizeAssistantAgentConfig keeps legacy sources usable when new fields absent (migration trigger)', () => {
    const result = normalizeAssistantAgentConfig({
        enabled: true,
        sources: {
            anthropicApiKey: true,
            openaiApiKeyBridge: false,
            azureOpenaiApiKeyBridge: true,
            chatgptAccount: true,
            claudeAccount: false
        }
    });
    assert.equal(result.boundCredential, null);
    assert.deepEqual(result.fallbacks, []);
    assert.equal(result.bindingConfigured, false);
    assert.equal(result.sources.anthropicApiKey, true);
    assert.equal(result.sources.openaiApiKeyBridge, false);
    assert.equal(result.sources.chatgptAccount, true);
});

test('normalizeAssistantAgentConfig preserves explicit cleared binding state', () => {
    const result = normalizeAssistantAgentConfig({
        enabled: true,
        bindingConfigured: true,
        boundModelSource: null,
        fallbacks: []
    });
    assert.equal(result.bindingConfigured, true);
    assert.equal(result.boundModelSource, null);
    assert.equal(result.boundCredential, null);
    assert.deepEqual(result.fallbacks, []);
});

test('normalizeAssistantAgentConfig upgrades legacy boundCredential into boundModelSource view', () => {
    const result = normalizeAssistantAgentConfig({
        enabled: true,
        boundCredential: { type: 'api-key', id: 'legacy-key', model: 'gpt-5.4' }
    });
    assert.deepEqual(result.boundModelSource, { type: 'api-key', id: 'legacy-key', model: 'gpt-5.4' });
    assert.deepEqual(result.boundCredential, { type: 'api-key', id: 'legacy-key', model: 'gpt-5.4' });
});
