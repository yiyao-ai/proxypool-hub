import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/routes/messages-route.js';
import { analyzeAnthropicRequestFeatures } from '../../src/translators/request-features.js';
import { rankAnthropicProvidersForRequest, resolveAnthropicProviderCapabilities } from '../../src/translators/provider-capabilities.js';

const {
  _buildTranslatorDowngradeError,
  _readTranslatorDowngradeHeaders,
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
