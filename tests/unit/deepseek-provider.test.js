import test from 'node:test';
import assert from 'node:assert/strict';

import { DeepSeekProvider } from '../../src/providers/deepseek.js';

test('DeepSeekProvider.sendRequest uses DeepSeek OpenAI-compatible chat endpoint', async () => {
  const provider = new DeepSeekProvider({
    id: 'deepseek_1',
    name: 'deepseek-test',
    apiKey: 'sk-test'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(JSON.stringify({
      id: 'chatcmpl_1',
      object: 'chat.completion',
      model: 'deepseek-v4-flash',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://api.deepseek.com/chat/completions');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer sk-test');

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.model, 'deepseek-v4-flash');
    assert.equal(payload.messages[0].content, 'hello');
  } finally {
    global.fetch = originalFetch;
  }
});

test('DeepSeekProvider.sendAnthropicRequest uses DeepSeek Anthropic-compatible messages endpoint', async () => {
  const provider = new DeepSeekProvider({
    id: 'deepseek_2',
    name: 'deepseek-test',
    apiKey: 'sk-test'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-pro',
      content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'inspect repo' }],
      max_tokens: 128
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.equal(capturedOptions.headers['x-api-key'], 'sk-test');
    assert.equal(capturedOptions.headers['anthropic-version'], '2023-06-01');

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.model, 'deepseek-v4-pro');
    assert.equal(payload.max_tokens, 128);
  } finally {
    global.fetch = originalFetch;
  }
});

test('DeepSeekProvider.validateKey checks the models endpoint', async () => {
  const provider = new DeepSeekProvider({
    id: 'deepseek_3',
    name: 'deepseek-test',
    apiKey: 'sk-test'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;

  global.fetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({
      object: 'list',
      data: [{ id: 'deepseek-v4-flash' }]
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const valid = await provider.validateKey();
    assert.equal(valid, true);
    assert.equal(capturedUrl, 'https://api.deepseek.com/models');
  } finally {
    global.fetch = originalFetch;
  }
});

test('DeepSeekProvider uses deepseek pricing registry entries', () => {
  const provider = new DeepSeekProvider({
    id: 'deepseek_4',
    name: 'deepseek-test',
    apiKey: 'sk-test'
  });

  const cost = provider.estimateCost('deepseek-v4-flash', 1_000_000, 1_000_000, 1_000_000, 0);
  assert.equal(Number(cost.toFixed(2)), 1.44);
});

test('DeepSeekProvider does not expose native Responses handling', () => {
  const provider = new DeepSeekProvider({
    id: 'deepseek_5',
    name: 'deepseek-test',
    apiKey: 'sk-test'
  });

  assert.equal(typeof provider.sendResponsesRequest, 'undefined');
});
