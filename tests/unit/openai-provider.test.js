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

test('OpenAIProvider.sendAnthropicRequest uses responses translator path and returns anthropic message', async () => {
  const provider = new OpenAIProvider({
    id: 'openai_2',
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
      id: 'resp_1',
      object: 'response',
      model: 'gpt-5.4',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'I will inspect files first.' }]
        },
        {
          type: 'function_call',
          call_id: 'fc_abc',
          id: 'fc_abc',
          name: 'shell_command',
          arguments: '{"command":"Get-ChildItem"}'
        }
      ],
      usage: {
        input_tokens: 9,
        output_tokens: 4,
        cache_read_input_tokens: 1
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'claude-sonnet-4',
      system: 'Be concise.',
      messages: [
        { role: 'user', content: 'inspect repo' }
      ]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://api.openai.com/v1/responses');

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.stream, false);
    assert.equal(payload.instructions, 'Be concise.');
    assert.equal(payload.input[0].role, 'user');

    const anthropic = await response.json();
    assert.equal(anthropic.model, 'claude-sonnet-4');
    assert.equal(anthropic.content[0].type, 'text');
    assert.equal(anthropic.content[1].type, 'tool_use');
    assert.equal(anthropic.stop_reason, 'tool_use');
    assert.equal(anthropic.usage.input_tokens, 9);
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenAIProvider.sendAnthropicRequest forwards anthropic document blocks as responses input_file content', async () => {
  const provider = new OpenAIProvider({
    id: 'openai_3',
    name: 'openai-test',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1'
  });

  const originalFetch = global.fetch;
  let capturedOptions = null;

  global.fetch = async (_url, options) => {
    capturedOptions = options;
    return new Response(JSON.stringify({
      id: 'resp_doc_1',
      object: 'response',
      model: 'gpt-5.4',
      status: 'completed',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'received document' }]
      }],
      usage: {
        input_tokens: 7,
        output_tokens: 3
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'claude-sonnet-4',
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          title: 'spec.pdf',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'JVBERi0xLjQK'
          }
        }]
      }]
    });

    const payload = JSON.parse(capturedOptions.body);
    const userMessage = payload.input.find(item => item.type === 'message' && item.role === 'user');
    assert.ok(Array.isArray(userMessage.content));
    assert.equal(userMessage.content[0].type, 'input_file');
    assert.equal(userMessage.content[0].filename, 'spec.pdf');
    assert.equal(userMessage.content[0].file_data, 'data:application/pdf;base64,JVBERi0xLjQK');
  } finally {
    global.fetch = originalFetch;
  }
});
