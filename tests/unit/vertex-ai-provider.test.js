import test from 'node:test';
import assert from 'node:assert/strict';

import { VertexAIProvider } from '../../src/providers/vertex-ai.js';
import { clearThinkingSignatureCache } from '../../src/signature-cache.js';
import { logger } from '../../src/utils/logger.js';

test('VertexAIProvider.sendAnthropicRequest bridges gemini models to Vertex generateContent and returns Anthropic tool_use blocks', async () => {
  clearThinkingSignatureCache();

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
    const body = JSON.parse(options.body);
    const structuredCall = body.contents?.[1]?.parts?.find(part => part.functionCall);
    if (structuredCall) {
      structuredCall.functionCall.thoughtSignature = 'sig_' + 'y'.repeat(60);
      capturedOptions = { ...options, body: JSON.stringify(body) };
    }
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
              },
              thoughtSignature: 'sig_' + 'y'.repeat(60)
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
    assert.equal(payload.contents[1].parts[0].text, 'I will inspect files first.');
    assert.equal(payload.contents[1].parts[1].text, '[Called function: shell_command({"command":"Get-ChildItem"})]');
    assert.equal(payload.contents[2].parts[0].text, '[Function shell_command returned: file list]');

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
    clearThinkingSignatureCache();
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

test('VertexAIProvider.sendAnthropicRequest preserves anthropic image blocks for Gemini generateContent', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_2b',
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
        content: { parts: [{ text: 'A cat on a sofa.' }] }
      }],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 3
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'gemini-2.5-pro',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown here?' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
            }
          }
        ]
      }]
    });

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.contents[0].role, 'user');
    assert.equal(payload.contents[0].parts[0].text, 'What is shown here?');
    assert.deepEqual(payload.contents[0].parts[1], {
      inlineData: {
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
      }
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('VertexAIProvider.sendAnthropicRequest preserves anthropic document blocks for Gemini generateContent', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_doc_1',
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
        content: { parts: [{ text: 'document received' }] }
      }],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 2
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'gemini-2.5-pro',
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          title: 'notes.txt',
          source: {
            type: 'base64',
            media_type: 'text/plain',
            data: 'aGVsbG8='
          }
        }]
      }]
    });

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.contents[0].role, 'user');
    assert.deepEqual(payload.contents[0].parts[0], {
      inlineData: {
        mimeType: 'text/plain',
        data: 'aGVsbG8='
      }
    });
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

test('VertexAIProvider restores cached thoughtSignature for subsequent Gemini tool calls', async () => {
  clearThinkingSignatureCache();

  const provider = new VertexAIProvider({
    id: 'vertex_5',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'global'
  });

  const originalFetch = global.fetch;
  const capturedBodies = [];
  const thoughtSignature = 'sig_' + 'x'.repeat(60);

  global.fetch = async (_url, options) => {
    capturedBodies.push(JSON.parse(options.body));

    if (capturedBodies.length === 1) {
      return new Response(JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: {
            parts: [{
              functionCall: {
                id: 'toolu_read_1',
                name: 'default_api:Read',
                args: { file_path: 'README.md' }
              },
              thoughtSignature
            }]
          }
        }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'done' }] }
      }],
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 6
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const firstResponse = await provider.sendAnthropicRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'read file' }]
    });

    const firstAnthropic = await firstResponse.json();
    assert.equal(firstAnthropic.content[0].type, 'tool_use');
    assert.equal(firstAnthropic.content[0].id, 'toolu_read_1');
    assert.equal(firstAnthropic.content[0].thoughtSignature, thoughtSignature);

    await provider.sendAnthropicRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read_1',
              name: 'default_api:Read',
              input: { file_path: 'README.md' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read_1',
              content: 'file contents'
            }
          ]
        }
      ]
    });

    assert.equal(capturedBodies.length, 2);
    const secondBody = capturedBodies[1];
    assert.equal(secondBody.contents[0].parts[0].functionCall.name, 'default_api:Read');
    assert.equal(secondBody.contents[0].parts[0].thoughtSignature, thoughtSignature);
    assert.equal(secondBody.contents[0].parts[0].functionCall.thoughtSignature, undefined);
  } finally {
    global.fetch = originalFetch;
    clearThinkingSignatureCache();
  }
});

test('VertexAIProvider degrades uncached prior tool history to text for Gemini to avoid missing thoughtSignature errors', async () => {
  clearThinkingSignatureCache();

  const provider = new VertexAIProvider({
    id: 'vertex_6',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'global'
  });

  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
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
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_skill_1',
              name: 'default_api:Skill',
              input: { command: 'imagegen' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_skill_1',
              content: 'skill output'
            }
          ]
        }
      ]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedBody.contents[0].role, 'model');
    assert.equal(capturedBody.contents[0].parts[0].text, '[Called function: default_api:Skill({"command":"imagegen"})]');
    assert.equal(capturedBody.contents[1].role, 'user');
    assert.equal(capturedBody.contents[1].parts[0].text, '[Function default_api:Skill returned: skill output]');
  } finally {
    global.fetch = originalFetch;
    clearThinkingSignatureCache();
  }
});

test('VertexAIProvider.sendAnthropicRequest preserves tool_result image content for Gemini functionResponse', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_7',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'global'
  });

  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'The image contains text.' }] }
      }],
      usageMetadata: {
        promptTokenCount: 6,
        candidatesTokenCount: 4
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'gemini-3.1-pro-preview',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read_img_1',
              name: 'Read',
              input: { file_path: 'D:\\tmp\\demo.png', pages: '1' }
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_read_img_1',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
                  }
                }
              ]
            }
          ]
        }
      ]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedBody.contents[0].role, 'model');
    assert.equal(capturedBody.contents[1].role, 'user');
    assert.deepEqual(capturedBody.contents[1].parts[0], {
      inlineData: {
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
      }
    });
    assert.equal(capturedBody.contents[1].parts.some(part => part.functionResponse), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('VertexAIProvider.sendAnthropicRequest logs Gemini upstream error body before returning error response', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_8',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'global'
  });

  const originalFetch = global.fetch;
  const originalLoggerError = logger.error;
  const logged = [];

  logger.error = (...args) => {
    logged.push(args.join(' '));
  };

  global.fetch = async (_url, _options) => new Response(JSON.stringify({
    error: {
      code: 403,
      message: 'Permission denied for publisher model.'
    }
  }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' }
  });

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }]
    });

    assert.equal(response.status, 403);
    const body = await response.text();
    assert.match(body, /Permission denied/);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Gemini generateContent upstream error/);
    assert.match(logged[0], /model=gemini-2\.5-pro/);
    assert.match(logged[0], /status=403/);
    assert.match(logged[0], /Permission denied for publisher model/);
  } finally {
    global.fetch = originalFetch;
    logger.error = originalLoggerError;
  }
});

test('VertexAIProvider.sendRequest surfaces Claude network cause details and logs them', async () => {
  const provider = new VertexAIProvider({
    id: 'vertex_9',
    name: 'vertex-test',
    apiKey: 'raw-oauth-token',
    projectId: 'demo-project',
    location: 'europe-west1'
  });

  const originalFetch = global.fetch;
  const originalLoggerError = logger.error;
  const logged = [];

  logger.error = (...args) => {
    logged.push(args.join(' '));
  };

  global.fetch = async () => {
    const cause = new Error('connect ETIMEDOUT europe-west1-aiplatform.googleapis.com');
    throw new TypeError('fetch failed', { cause });
  };

  try {
    await assert.rejects(
      () => provider.sendRequest({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }]
      }),
      /Vertex AI Claude rawPredict request failed: connect ETIMEDOUT/
    );

    assert.equal(logged.length, 1);
    assert.match(logged[0], /Claude rawPredict network error/);
    assert.match(logged[0], /model=claude-sonnet-4-6/);
    assert.match(logged[0], /cause=connect ETIMEDOUT europe-west1-aiplatform\.googleapis\.com/);
  } finally {
    global.fetch = originalFetch;
    logger.error = originalLoggerError;
  }
});
