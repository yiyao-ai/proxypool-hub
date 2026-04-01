import test from 'node:test';
import assert from 'node:assert/strict';

import { OpenAIProvider } from '../../src/providers/openai.js';

test('OpenAIProvider.sendResponsesRequest uses native responses endpoint', async () => {
  const provider = new OpenAIProvider({
    id: 'openai_1',
    name: 'openai-test',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(JSON.stringify({
      object: 'response',
      model: 'gpt-5.4',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendResponsesRequest({
      model: 'gpt-5.4',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      stream: false
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer sk-test');

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.model, 'gpt-5.4');
    assert.equal(payload.stream, false);
  } finally {
    global.fetch = originalFetch;
  }
});
