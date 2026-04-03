import test from 'node:test';
import assert from 'node:assert/strict';

import { GeminiProvider } from '../../src/providers/gemini.js';
import { clearThinkingSignatureCache } from '../../src/signature-cache.js';
import { logger } from '../../src/utils/logger.js';
import { translateAnthropicToGeminiRequest } from '../../src/translators/request/anthropic-to-gemini.js';

test('GeminiProvider.sendAnthropicRequest downgrades tool_result image content to user multimodal parts', async () => {
  const provider = new GeminiProvider({
    id: 'gemini_vision_1',
    name: 'gemini-test',
    apiKey: 'test-key'
  });

  const originalFetch = global.fetch;
  const originalLoggerInfo = logger.info;
  let capturedUrl = null;
  let capturedBody = null;
  const logged = [];

  logger.info = (...args) => {
    logged.push(args.join(' '));
  };

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'The image contains UI text.' }] }
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
      model: 'claude-opus-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_read_img_1',
              name: 'Read',
              input: { file_path: 'D:\\tmp\\demo.png' }
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
    assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=test-key');
    assert.equal(capturedBody.contents[0].role, 'model');
    assert.equal(capturedBody.contents[0].parts[0].functionCall.name, 'Read');
    assert.equal(capturedBody.contents[1].role, 'user');
    assert.deepEqual(capturedBody.contents[1].parts[0], {
      inlineData: {
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
      }
    });
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Downgrading multimodal tool_result to user parts/);
  } finally {
    global.fetch = originalFetch;
    logger.info = originalLoggerInfo;
  }
});

test('GeminiProvider.sendAnthropicRequest enables Claude Code tool compatibility for Anthropic bridge', async () => {
  const provider = new GeminiProvider({
    id: 'gemini_tools_1',
    name: 'gemini-test',
    apiKey: 'test-key'
  });

  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: {
          parts: [{
            functionCall: {
              id: 'call_read_1',
              name: 'Read',
              args: { file_path: 'D:\\tmp\\demo.png' }
            }
          }]
        }
      }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'claude-opus-4-6',
      _proxypoolAppId: 'claude-code',
      messages: [{ role: 'user', content: '请查看 D:\\tmp\\demo.png' }],
      tools: [{
        name: 'Read',
        description: 'Read a local file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' }
          },
          required: ['file_path'],
          additionalProperties: false
        }
      }]
    });

    const decl = capturedBody.tools[0].functionDeclarations[0];
    assert.equal(decl.name, 'Read');
    assert.equal(decl.description, 'Read a local file');
    assert.equal(decl.parameters.type, 'object');
    assert.deepEqual(decl.parameters.required, ['file_path']);
    assert.equal(decl.parameters.properties.file_path.type, 'string');
    assert.deepEqual(capturedBody.generationConfig.thinkingConfig, { thinkingBudget: 0 });

    const anthropic = await response.json();
    assert.equal(anthropic.stop_reason, 'tool_use');
    assert.equal(anthropic.content[0].type, 'tool_use');
    assert.equal(anthropic.content[0].name, 'Read');
    assert.deepEqual(anthropic.content[0].input, { file_path: 'D:\\tmp\\demo.png' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GeminiProvider.sendAnthropicRequest preserves already-mapped Gemini model ids and strips unsupported schema keys', async () => {
  const provider = new GeminiProvider({
    id: 'gemini_tools_2',
    name: 'gemini-test',
    apiKey: 'test-key'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedBody = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{
        finishReason: 'STOP',
        content: { parts: [{ text: 'ok' }] }
      }],
      usageMetadata: {
        promptTokenCount: 2,
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
      _proxypoolAppId: 'claude-code',
      messages: [{ role: 'user', content: 'inspect image' }],
      tools: [{
        name: 'Read',
        description: 'Read a local file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string', minLength: 1 },
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
          required: ['file_path'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
          examples: [{ file_path: 'D:\\tmp\\demo.png' }]
        }
      }]
    });

    assert.equal(capturedUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=test-key');
    const params = capturedBody.tools[0].functionDeclarations[0].parameters;
    assert.equal('$schema' in params, false);
    assert.equal('examples' in params, false);
    assert.equal('additionalProperties' in params, false);
    assert.equal('minLength' in params.properties.file_path, false);
    assert.equal('propertyNames' in params.properties.options, false);
    assert.deepEqual(params.properties.mode.enum, ['safe']);
    assert.equal(params.properties.options.properties.cwd.type, 'string');
    assert.deepEqual(params.required, ['file_path']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GeminiProvider.sendAnthropicRequest strips nested unsupported schema keys that Gemini rejects', async () => {
  const provider = new GeminiProvider({
    id: 'gemini_tools_3',
    name: 'gemini-test',
    apiKey: 'test-key'
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
        promptTokenCount: 2,
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
      _proxypoolAppId: 'claude-code',
      messages: [{ role: 'user', content: 'inspect image' }],
      tools: [{
        name: 'ComplexTool',
        description: 'Tool with nested schema',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1 },
            options: {
              type: 'object',
              title: 'Options',
              properties: {
                cwd: { type: ['string', 'null'] },
                mode: { const: 'safe' },
                nested: {
                  type: 'object',
                  properties: {
                    pattern: { type: 'string', pattern: '^[a-z]+$' }
                  },
                  additionalProperties: false
                }
              },
              propertyNames: { pattern: '^[a-z]+$' },
              additionalProperties: false
            }
          },
          required: ['query'],
          $schema: 'http://json-schema.org/draft-07/schema#'
        }
      }]
    });

    const params = capturedBody.tools[0].functionDeclarations[0].parameters;
    assert.equal(params.type, 'object');
    assert.equal(params.properties.query.type, 'string');
    assert.equal('minLength' in params.properties.query, false);
    assert.equal(params.properties.options.type, 'object');
    assert.equal(params.properties.options.title, 'Options');
    assert.equal('propertyNames' in params.properties.options, false);
    assert.equal('additionalProperties' in params.properties.options, false);
    assert.equal(params.properties.options.properties.cwd.type, 'string');
    assert.deepEqual(params.properties.options.properties.mode.enum, ['safe']);
    assert.equal(params.properties.options.properties.nested.type, 'object');
    assert.equal(params.properties.options.properties.nested.properties.pattern.type, 'string');
    assert.equal('pattern' in params.properties.options.properties.nested.properties.pattern, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GeminiProvider.sendAnthropicRequest forwards anthropic document blocks as Gemini file parts', async () => {
  const provider = new GeminiProvider({
    id: 'gemini_doc_1',
    name: 'gemini-test',
    apiKey: 'test-key'
  });

  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
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
      model: 'claude-opus-4-6',
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

    assert.equal(capturedBody.contents[0].role, 'user');
    assert.deepEqual(capturedBody.contents[0].parts[0], {
      inlineData: {
        mimeType: 'text/plain',
        data: 'aGVsbG8='
      }
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('translateAnthropicToGeminiRequest forces structured tool calls for Gemini capability profile', () => {
  clearThinkingSignatureCache();

  const result = translateAnthropicToGeminiRequest({
    _proxypoolAppId: 'claude-code',
    tools: [{
      name: 'Read',
      input_schema: { type: 'object', properties: {} }
    }],
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_read_1',
        name: 'Read',
        input: { file_path: 'README.md' }
      }]
    }]
  }, {
    capabilityProfile: 'gemini'
  });

  assert.equal(result.contents[0].parts[0].functionCall.name, 'Read');
  assert.deepEqual(result.contents[0].parts[0].functionCall.args, { file_path: 'README.md' });
  assert.deepEqual(result.generationConfig.thinkingConfig, { thinkingBudget: 0 });
});

test('translateAnthropicToGeminiRequest keeps default profile signature-based without cached thoughtSignature', () => {
  clearThinkingSignatureCache();

  const result = translateAnthropicToGeminiRequest({
    tools: [{
      name: 'Read',
      input_schema: { type: 'object', properties: {} }
    }],
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_read_2',
        name: 'Read',
        input: { file_path: 'README.md' }
      }]
    }]
  });

  assert.equal(result.contents[0].parts[0].text, '[Called function: Read({"file_path":"README.md"})]');
  assert.equal('thinkingConfig' in result.generationConfig, false);
});
