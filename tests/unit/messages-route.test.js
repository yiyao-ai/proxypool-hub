import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/routes/messages-route.js';
import { analyzeAnthropicRequestFeatures } from '../../src/translators/request-features.js';
import { rankAnthropicProvidersForRequest, resolveAnthropicProviderCapabilities } from '../../src/translators/provider-capabilities.js';

const {
  _applyAnthropicBridgeTokenCap,
  _buildTranslatorDowngradeError,
  _clampClaudeRateLimitCooldown,
  _extractClaudeRateLimitCooldownMs,
  _prepareClaudeMessagesBody,
  _readTranslatorDowngradeHeaders,
  _resolveClaudeCodeMaxOutputTokens,
  RESPONSE_COMMITTED,
  _summarizeCompatibleProviderRanking,
  _shouldRejectTranslatorDowngrade,
  _streamDirectWithRotation
} = _testExports;

function createMockResponse() {
  return {
    headers: new Map(),
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name, value) {
      this.headers.set(name, value);
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write() {},
    end() {
      this.writableEnded = true;
    }
  };
}

test('_streamDirectWithRotation does not commit SSE headers before upstream accepts the stream', async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => new Response('rate limited', {
    status: 429,
    headers: {
      'retry-after': '1',
      'Content-Type': 'text/plain'
    }
  });

  const res = createMockResponse();

  try {
    await assert.rejects(
      () => _streamDirectWithRotation(
        res,
        {
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'hi' }]
        },
        {
          accessToken: 'token',
          accountId: 'account-id',
          email: 'user@example.com'
        },
        'claude-opus-4-6',
        Date.now(),
        null
      ),
      /RATE_LIMITED:1000:rate limited/
    );

    assert.equal(res.headersSent, false);
    assert.equal(res.headers.size, 0);
    assert.equal(res.writableEnded, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('_readTranslatorDowngradeHeaders extracts translator metadata headers from provider response', () => {
  const response = new Response('{}', {
    status: 200,
    headers: {
      'x-proxypool-unsupported-tools': 'web_search,code_execution',
      'x-proxypool-tool-choice-downgrade': 'target_does_not_support_hosted_tool_choice'
    }
  });

  const result = _readTranslatorDowngradeHeaders(response);
  assert.equal(result.unsupportedTools, 'web_search,code_execution');
  assert.equal(result.toolChoiceReason, 'target_does_not_support_hosted_tool_choice');
});

test('_shouldRejectTranslatorDowngrade only rejects when strict translator compatibility is enabled', () => {
  assert.equal(
    _shouldRejectTranslatorDowngrade(
      { strictTranslatorCompatibility: false },
      { unsupportedTools: 'web_search', toolChoiceReason: '' }
    ),
    false
  );

  assert.equal(
    _shouldRejectTranslatorDowngrade(
      { strictTranslatorCompatibility: true },
      { unsupportedTools: '', toolChoiceReason: '' }
    ),
    false
  );

  assert.equal(
    _shouldRejectTranslatorDowngrade(
      { strictTranslatorCompatibility: true },
      { unsupportedTools: 'web_search', toolChoiceReason: '' }
    ),
    true
  );
});

test('_buildTranslatorDowngradeError formats a strict mode rejection message', () => {
  const result = _buildTranslatorDowngradeError(
    { type: 'openai', name: 'openai-test' },
    'claude-sonnet-4-6',
    'gpt-5.4',
    {
      unsupportedTools: 'web_search',
      toolChoiceReason: 'target_does_not_support_hosted_tool_choice'
    }
  );

  assert.equal(result.error.type, 'invalid_request_error');
  assert.match(result.error.message, /strict translator compatibility mode/);
  assert.match(result.error.message, /openai\/openai-test/);
  assert.match(result.error.message, /unsupported_tools=web_search/);
  assert.match(result.error.message, /tool_choice_reason=target_does_not_support_hosted_tool_choice/);
});

test('analyzeAnthropicRequestFeatures detects hosted tools and multimodal inputs', () => {
  const result = analyzeAnthropicRequestFeatures({
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'url', url: 'https://example.com/cat.png' } },
        { type: 'document', source: { type: 'url', url: 'https://example.com/spec.pdf' } },
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }]
        }
      ]
    }]
  });

  assert.equal(result.hasHostedTools, true);
  assert.equal(result.hasImageInput, true);
  assert.equal(result.hasFileInput, true);
  assert.equal(result.hasStructuredToolResult, true);
  assert.deepEqual(result.hostedToolNames, ['web_search']);
});

test('resolveAnthropicProviderCapabilities distinguishes vertex claude from vertex gemini', () => {
  const provider = { type: 'vertex-ai', sendAnthropicRequest() {} };

  const claudeCaps = resolveAnthropicProviderCapabilities(provider, {
    requestedModel: 'claude-sonnet-4-6',
    appId: 'claude-code',
    hasTools: true
  });
  const geminiCaps = resolveAnthropicProviderCapabilities(provider, {
    requestedModel: 'gemini-2.5-pro',
    appId: 'claude-code',
    hasTools: true
  });

  assert.equal(claudeCaps.supportsHostedTools, true);
  assert.equal(geminiCaps.supportsHostedTools, false);
  assert.equal(claudeCaps.providerKind, 'vertex-claude');
  assert.equal(geminiCaps.providerKind, 'vertex-gemini');
});

test('rankAnthropicProvidersForRequest prefers hosted-tool-capable provider for hosted tool requests', () => {
  const body = {
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: 'search the web' }]
  };
  const features = analyzeAnthropicRequestFeatures(body);
  const providers = [
    { type: 'openai', name: 'openai-test', totalRequests: 0, sendAnthropicRequest() {} },
    { type: 'vertex-ai', name: 'vertex-test', totalRequests: 0, sendAnthropicRequest() {} }
  ];

  const ranked = rankAnthropicProvidersForRequest(providers, body, {
    requestedModel: 'claude-sonnet-4-6',
    appId: 'claude-code',
    tools: body.tools,
    features
  });

  assert.equal(ranked[0].provider.type, 'vertex-ai');
  assert.equal(ranked[0].capabilities.supportsHostedTools, true);
});

test('_summarizeCompatibleProviderRanking prints capability summary for logs', () => {
  const summary = _summarizeCompatibleProviderRanking([
    {
      provider: { type: 'vertex-ai', name: 'vertex-test' },
      score: 145,
      capabilities: {
        supportsHostedTools: true,
        supportsInputImage: true,
        supportsInputFile: true,
        supportsStructuredToolResult: true
      }
    }
  ]);

  assert.match(summary, /vertex-ai\/vertex-test:145/);
  assert.match(summary, /hosted=y/);
  assert.match(summary, /tool_result=y/);
});

test('RESPONSE_COMMITTED sentinel is exported for committed stream handling', () => {
  assert.equal(typeof RESPONSE_COMMITTED, 'symbol');
});

test('_clampClaudeRateLimitCooldown enforces sane cooldown bounds', () => {
  assert.equal(_clampClaudeRateLimitCooldown(0), 30000);
  assert.equal(_clampClaudeRateLimitCooldown(5000), 30000);
  assert.equal(_clampClaudeRateLimitCooldown(120000), 120000);
  assert.equal(_clampClaudeRateLimitCooldown(60 * 60 * 1000), 10 * 60 * 1000);
});

test('_extractClaudeRateLimitCooldownMs reads retry delay from Claude RATE_LIMITED error shape', () => {
  const error = new Error('RATE_LIMITED:5717000:{"type":"error"}');
  assert.equal(_extractClaudeRateLimitCooldownMs(error), 10 * 60 * 1000);
});

test('_prepareClaudeMessagesBody strips invalid assistant thinking blocks before Claude passthrough', () => {
  const prepared = _prepareClaudeMessagesBody({
    model: 'claude-opus-4-6',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'step 1' },
          { type: 'thinking', thinking: '' },
          { type: 'text', text: '' }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'continue', cache_control: { type: 'ephemeral' } }
        ]
      }
    ]
  });

  assert.equal(prepared.max_tokens, 8192);
  assert.deepEqual(prepared.messages[0].content, [{ type: 'text', text: 'step 1' }]);
  assert.deepEqual(prepared.messages[1].content, [{ type: 'text', text: 'continue' }]);
});

test('_resolveClaudeCodeMaxOutputTokens falls back to 64000 by default', () => {
  const original = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;

  try {
    assert.equal(_resolveClaudeCodeMaxOutputTokens(), 64000);
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    } else {
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = original;
    }
  }
});

test('_applyAnthropicBridgeTokenCap caps Claude Code bridge requests for Azure/OpenAI-style providers only', () => {
  const original = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;

  try {
    const capped = _applyAnthropicBridgeTokenCap(
      { model: 'gpt-5.4-pro-2026-03-05', max_tokens: 120000 },
      { appId: 'claude-code', providerType: 'azure-openai' }
    );
    const untouchedClaude = _applyAnthropicBridgeTokenCap(
      { model: 'claude-opus-4-6', max_tokens: 120000 },
      { appId: 'claude-code', providerType: 'claude-account' }
    );
    const untouchedOtherApp = _applyAnthropicBridgeTokenCap(
      { model: 'gpt-5.4-pro-2026-03-05', max_tokens: 120000 },
      { appId: 'codex', providerType: 'azure-openai' }
    );

    assert.equal(capped.max_tokens, 64000);
    assert.equal(untouchedClaude.max_tokens, 120000);
    assert.equal(untouchedOtherApp.max_tokens, 120000);
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
    } else {
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = original;
    }
  }
});
