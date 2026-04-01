import test from 'node:test';
import assert from 'node:assert/strict';

import { VertexAIProvider } from '../../src/providers/vertex-ai.js';

test('VertexAIProvider.sendAnthropicRequest bridges gemini models to Vertex generateContent and returns Anthropic tool_use blocks', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_1',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'us-central1'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [
            { text: 'I will inspect files first.' },
            {
              functionCall: {
                id: 'vertex-call-1',
                name: 'shell_command',
                args: { command: 'Get-ChildItem' }
              }
            }
          ]
        }
      }],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 8,
        totalTokenCount: 20
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'gemini-2.5-pro',
      max_tokens: 1024,
      system: [{ type: 'text', text: 'You are helpful.' }],
      messages: [
        { role: 'user', content: 'inspect repo' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect files first.' },
            { type: 'tool_use', id: 'toolu_call_1', name: 'shell_command', input: { command: 'Get-ChildItem' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_call_1', content: 'file list' }
          ]
        }
      ],
      tools: [{
        name: 'shell_command',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string' }
          },
          required: ['command'],
          additionalProperties: false
        }
      }]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent');
    assert.equal(capturedOptions.headers.Authorization, 'Bearer raw-oauth-token');

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.systemInstruction.parts[0].text, 'You are helpful.');
    assert.equal(payload.tools[0].functionDeclarations[0].name, 'shell_command');
    assert.equal('thinkingConfig' in payload.generationConfig, false);
    assert.equal(payload.contents[0].role, 'user');
    assert.equal(payload.contents[1].role, 'model');
    assert.equal(payload.contents[2].role, 'user');
    assert.equal(payload.contents[2].parts[0].functionResponse.name, 'shell_command');
    assert.equal(payload.contents[2].parts[0].functionResponse.response.tool_use_id, 'toolu_call_1');

    const anthropic = await response.json();
    assert.equal(anthropic.role, 'assistant');
    assert.equal(anthropic.model, 'gemini-2.5-pro');
    assert.equal(anthropic.stop_reason, 'tool_use');
    assert.equal(anthropic.content[0].type, 'text');
    assert.equal(anthropic.content[1].type, 'tool_use');
    assert.equal(anthropic.content[1].id, 'vertex-call-1');
    assert.equal(anthropic.content[1].name, 'shell_command');
    assert.deepEqual(anthropic.content[1].input, { command: 'Get-ChildItem' });
    assert.deepEqual(anthropic.usage, { input_tokens: 12, output_tokens: 8 });
  } finally {
    global.fetch = originalFetch;
  }
});

test('VertexAIProvider.sendAnthropicRequest strips unsupported schema keys from Gemini tool declarations', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_1b',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'us-central1'
  });

  const originalFetch = global.fetch;
  let capturedOptions = null;

  global.fetch = async (_url, options) => {
    capturedOptions = options;
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{ text: 'done' }]
        }
      }],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'run a command' }],
      tools: [{
        name: 'shell_command',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', minLength: 1 },
            mode: { const: 'safe' },
            options: {
              type: 'object',
              propertyNames: { pattern: '^[a-z]+$' },
              properties: {
                cwd: { type: ['string', 'null'] }
              },
              additionalProperties: false
            }
          },
          required: ['command'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
          examples: [{ command: 'Get-ChildItem' }]
        }
      }]
    });

    const payload = JSON.parse(capturedOptions.body);
    const params = payload.tools[0].functionDeclarations[0].parameters;
    assert.equal('$schema' in params, false);
    assert.equal('examples' in params, false);
    assert.equal('additionalProperties' in params, false);
    assert.deepEqual(params.properties.mode.enum, ['safe']);
    assert.equal('minLength' in params.properties.command, false);
    assert.equal('propertyNames' in params.properties.options, false);
    assert.equal(params.properties.options.properties.cwd.type, 'string');
    assert.deepEqual(params.required, ['command']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('VertexAIProvider.sendAnthropicRequest preserves Claude rawPredict path for claude models', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_2',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'europe-west1'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      usage: { input_tokens: 2, output_tokens: 1 }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'claude-sonnet-4-6',
      stream: false,
      messages: [{ role: 'user', content: 'hi' }]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://europe-west1-aiplatform.googleapis.com/v1/projects/demo-project/locations/europe-west1/publishers/anthropic/models/claude-sonnet-4-6:rawPredict');

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.anthropic_version, 'vertex-2023-10-16');
    assert.equal(payload.model, undefined);
    assert.equal(Array.isArray(payload.messages), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('VertexAIProvider.sendAnthropicRequest falls back from unavailable preview Gemini model to stable model', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_3',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'us-central1'
  });

  const originalFetch = global.fetch;
  const seenUrls = [];

  global.fetch = async (url, options) => {
    seenUrls.push(url);
    if (seenUrls.length === 1) {
      return new Response(JSON.stringify({
        error: {
          code: 404,
          message: 'Publisher Model `projects/demo-project/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview` was not found or your project does not have access to it.'
        }
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{ text: 'fallback ok' }]
        }
      }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.equal(response.status, 200);
    assert.equal(seenUrls.length, 2);
    assert.equal(seenUrls[0], 'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview:generateContent');
    assert.equal(seenUrls[1], 'https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent');
    assert.equal(response.headers.get('x-proxypool-upstream-model'), 'gemini-2.5-pro');

    const anthropic = await response.json();
    assert.equal(anthropic.model, 'gemini-3.1-pro-preview');
    assert.equal(anthropic.content[0].text, 'fallback ok');
  } finally {
    global.fetch = originalFetch;
  }
});

test('VertexAIProvider uses global Gemini publisher endpoint when provider location is global', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_4',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'global'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;

  global.fetch = async (url, _options) => {
    capturedUrl = url;
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'ok' }] }
      }],
      usageMetadata: {
        promptTokenCount: 1,
        candidatesTokenCount: 1
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://aiplatform.googleapis.com/v1beta1/projects/demo-project/locations/global/publishers/google/models/gemini-3.1-pro-preview:generateContent');
    assert.equal(response.headers.get('x-proxypool-upstream-model'), 'gemini-3.1-pro-preview');
  } finally {
    global.fetch = originalFetch;
  }
});
