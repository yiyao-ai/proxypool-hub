/**
 * Unit tests for the Phase 1 translator kernel.
 * Tests Anthropic ↔ OpenAI Responses conversion logic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  translateAnthropicToOpenAIResponsesRequest as convertAnthropicToResponsesAPI
} from '../../src/translators/request/anthropic-to-openai-responses.js';
import {
  convertOutputToAnthropic,
  generateMessageId,
  translateOpenAIResponsesToAnthropicMessage
} from '../../src/translators/response/openai-responses-to-anthropic.js';
import { getCachedSignature, getCachedSignatureFamily, clearThinkingSignatureCache } from '../../src/signature-cache.js';

// ─── convertAnthropicToResponsesAPI ──────────────────────────────────────────

test('convertAnthropicToResponsesAPI: basic structure with string system', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hello' }],
    system: 'You are helpful.'
  };
  const result = convertAnthropicToResponsesAPI(req);

  assert.equal(result.model, 'gpt-5.2');
  assert.equal(result.instructions, 'You are helpful.');
  assert.ok(Array.isArray(result.input));
  assert.equal(result.stream, true);
  assert.equal(result.store, false);
});

test('convertAnthropicToResponsesAPI: system as array of text blocks', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    system: [
      { type: 'text', text: 'Part one.' },
      { type: 'text', text: 'Part two.' }
    ]
  };
  const result = convertAnthropicToResponsesAPI(req);
  assert.equal(result.instructions, 'Part one.\n\nPart two.');
});

test('convertAnthropicToResponsesAPI: no system prompt sets empty instructions', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hi' }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  assert.equal(result.instructions, '');
});

test('convertAnthropicToResponsesAPI: user text message becomes input_text', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hello world' }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  const userMsg = result.input.find(i => i.role === 'user');
  assert.ok(userMsg, 'Expected a user message in input');
  assert.equal(userMsg.type, 'message');
  // Single text → string content
  assert.equal(userMsg.content, 'hello world');
});

test('convertAnthropicToResponsesAPI: user content as array of text blocks', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' }
      ]
    }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  const userMsg = result.input.find(i => i.role === 'user');
  assert.ok(userMsg);
  // Multiple texts → array of {type: 'input_text', text}
  assert.ok(Array.isArray(userMsg.content));
  assert.equal(userMsg.content[0].type, 'input_text');
  assert.equal(userMsg.content[0].text, 'First');
});

test('convertAnthropicToResponsesAPI: anthropic image blocks become input_image parts', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
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
  };

  const result = convertAnthropicToResponsesAPI(req);
  const userMsg = result.input.find(i => i.role === 'user');
  assert.ok(Array.isArray(userMsg.content));
  assert.equal(userMsg.content[0].type, 'input_text');
  assert.equal(userMsg.content[1].type, 'input_image');
  assert.equal(userMsg.content[1].data, 'iVBORw0KGgoAAAANSUhEUgAAAAUA');
  assert.equal(userMsg.content[1].media_type, 'image/png');
});

test('convertAnthropicToResponsesAPI: anthropic image url blocks become input_image url parts', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{
      role: 'user',
      content: [{
        type: 'image',
        source: {
          type: 'url',
          media_type: 'image/jpeg',
          url: 'https://example.com/cat.jpg'
        }
      }]
    }]
  };

  const result = convertAnthropicToResponsesAPI(req);
  const userMsg = result.input.find(i => i.role === 'user');
  assert.ok(Array.isArray(userMsg.content));
  assert.equal(userMsg.content[0].type, 'input_image');
  assert.equal(userMsg.content[0].image_url, 'https://example.com/cat.jpg');
  assert.equal(userMsg.content[0].media_type, 'image/jpeg');
});

test('convertAnthropicToResponsesAPI: tool_result becomes function_call_output', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_abc123',
        content: 'result text'
      }]
    }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  const toolOutput = result.input.find(i => i.type === 'function_call_output');
  assert.ok(toolOutput, 'Expected function_call_output in input');
  assert.equal(toolOutput.output, 'result text');
  assert.ok(toolOutput.call_id.startsWith('fc_'));
});

test('convertAnthropicToResponsesAPI: tool_result with is_error=true prefixes Error:', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_err1',
        content: 'something broke',
        is_error: true
      }]
    }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  const toolOutput = result.input.find(i => i.type === 'function_call_output');
  assert.ok(toolOutput.output.startsWith('Error:'));
});

test('convertAnthropicToResponsesAPI: tool_result image content becomes function_call_output multimodal output', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_img1',
        content: [
          { type: 'text', text: 'Inspect this result image' },
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
    }]
  };

  const result = convertAnthropicToResponsesAPI(req);
  const toolOutput = result.input.find(i => i.type === 'function_call_output');
  assert.ok(Array.isArray(toolOutput.output));
  assert.equal(toolOutput.output[0].type, 'input_text');
  assert.equal(toolOutput.output[1].type, 'input_image');
  assert.equal(toolOutput.output[1].data, 'iVBORw0KGgoAAAANSUhEUgAAAAUA');
  assert.equal(toolOutput.output[1].media_type, 'image/png');
});

test('convertAnthropicToResponsesAPI: assistant tool_use becomes function_call', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_xyz',
        name: 'my_tool',
        input: { key: 'value' }
      }]
    }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  const fnCall = result.input.find(i => i.type === 'function_call');
  assert.ok(fnCall, 'Expected function_call in input');
  assert.equal(fnCall.name, 'my_tool');
  assert.equal(fnCall.arguments, JSON.stringify({ key: 'value' }));
  assert.ok(fnCall.call_id.startsWith('fc_'));
});

test('convertAnthropicToResponsesAPI: tools are converted to OpenAI function format', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'search',
      description: 'Search the web',
      input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  assert.ok(Array.isArray(result.tools));
  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].type, 'function');
  assert.equal(result.tools[0].name, 'search');
  assert.equal(result.tools[0].description, 'Search the web');
});

test('convertAnthropicToResponsesAPI: no tools → empty array', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hi' }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  assert.deepEqual(result.tools, []);
});

test('convertAnthropicToResponsesAPI: sanitizeSchema strips unsupported keys', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'tool',
      description: 'desc',
      input_schema: {
        type: 'object',
        properties: { x: { type: 'string', minLength: 1, pattern: '^[a-z]+$' } },
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#'
      }
    }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  const schema = result.tools[0].parameters;
  // These keys should be stripped
  assert.ok(!('additionalProperties' in schema));
  assert.ok(!('$schema' in schema));
  // These should remain
  assert.equal(schema.type, 'object');
  assert.ok(schema.properties?.x);
  assert.ok(!('minLength' in schema.properties.x));
  assert.ok(!('pattern' in schema.properties.x));
});

test('convertAnthropicToResponsesAPI: sanitizeSchema converts const to enum', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'tool',
      description: 'desc',
      input_schema: {
        type: 'object',
        properties: { mode: { const: 'fast' } }
      }
    }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  const modeProp = result.tools[0].parameters.properties.mode;
  assert.deepEqual(modeProp.enum, ['fast']);
  assert.ok(!('const' in modeProp));
});

test('convertAnthropicToResponsesAPI: sanitizeSchema handles array type → picks first non-null', () => {
  const req = {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      name: 'tool',
      description: 'desc',
      input_schema: {
        type: 'object',
        properties: { val: { type: ['string', 'null'] } }
      }
    }]
  };
  const result = convertAnthropicToResponsesAPI(req);
  const valProp = result.tools[0].parameters.properties.val;
  assert.equal(valProp.type, 'string');
});

// ─── convertOutputToAnthropic ─────────────────────────────────────────────────

test('convertOutputToAnthropic: converts message output_text to text block', () => {
  const output = [{
    type: 'message',
    content: [{ type: 'output_text', text: 'Hello!' }]
  }];
  const result = convertOutputToAnthropic(output);
  assert.ok(Array.isArray(result));
  assert.equal(result[0].type, 'text');
  assert.equal(result[0].text, 'Hello!');
});

test('convertOutputToAnthropic: converts function_call to tool_use block', () => {
  const output = [{
    type: 'function_call',
    call_id: 'fc_abc',
    id: 'fc_abc',
    name: 'my_tool',
    arguments: '{"key":"val"}'
  }];
  const result = convertOutputToAnthropic(output);
  assert.equal(result[0].type, 'tool_use');
  assert.equal(result[0].name, 'my_tool');
  assert.deepEqual(result[0].input, { key: 'val' });
  assert.ok(result[0].id.startsWith('toolu_'));
});

test('convertOutputToAnthropic: handles invalid JSON arguments gracefully', () => {
  const output = [{
    type: 'function_call',
    call_id: 'fc_bad',
    name: 'tool',
    arguments: 'NOT_JSON'
  }];
  const result = convertOutputToAnthropic(output);
  assert.equal(result[0].type, 'tool_use');
  assert.deepEqual(result[0].input, {});
});

test('convertOutputToAnthropic: converts reasoning to thinking block', () => {
  const output = [{ type: 'reasoning' }];
  const result = convertOutputToAnthropic(output);
  assert.equal(result[0].type, 'thinking');
  assert.equal(result[0].thinking, '');
  assert.equal(result[0].signature, '');
});

test('convertAnthropicToResponsesAPI: assistant thinking is omitted from input but caches reasoning signature', () => {
  clearThinkingSignatureCache();
  const signature = 's'.repeat(60);
  const req = {
    model: 'gpt-5.2',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'internal reasoning', signature },
        { type: 'text', text: 'Answer draft' }
      ]
    }]
  };

  const result = convertAnthropicToResponsesAPI(req);
  assert.equal(result.input.length, 1);
  assert.equal(result.input[0].type, 'message');
  assert.equal(result.input[0].role, 'assistant');
  assert.equal(result.input[0].content, 'Answer draft');
  assert.equal(getCachedSignatureFamily(signature), 'openai');
});

test('convertAnthropicToResponsesAPI: assistant tool_use restores cached thought signature implicitly', () => {
  clearThinkingSignatureCache();
  const toolSignature = 't'.repeat(60);

  convertAnthropicToResponsesAPI({
    model: 'gpt-5.2',
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_restore',
        name: 'shell_command',
        input: { command: 'Get-ChildItem' },
        thoughtSignature: toolSignature
      }]
    }]
  });

  const result = convertAnthropicToResponsesAPI({
    model: 'gpt-5.2',
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_restore',
        name: 'shell_command',
        input: { command: 'Get-ChildItem' }
      }]
    }]
  });

  const toolCall = result.input.find(item => item.type === 'function_call');
  assert.ok(toolCall);
  assert.equal(toolCall.call_id, 'fc_restore');
  assert.equal(getCachedSignature('toolu_restore'), toolSignature);
});

test('translateOpenAIResponsesToAnthropicMessage: preserves reasoning and tool signatures', () => {
  clearThinkingSignatureCache();
  const reasoningSignature = 'r'.repeat(60);
  const toolSignature = 'u'.repeat(60);

  const result = translateOpenAIResponsesToAnthropicMessage({
    output: [
      {
        type: 'reasoning',
        text: 'step by step',
        signature: reasoningSignature
      },
      {
        type: 'function_call',
        call_id: 'fc_sig',
        id: 'fc_sig',
        name: 'search',
        arguments: '{"q":"repo"}',
        signature: toolSignature
      }
    ],
    usage: { input_tokens: 2, output_tokens: 3 }
  }, { model: 'claude-sonnet-4-6' });

  assert.equal(result.content[0].type, 'thinking');
  assert.equal(result.content[0].thinking, 'step by step');
  assert.equal(result.content[0].signature, reasoningSignature);
  assert.equal(result.content[1].type, 'tool_use');
  assert.equal(result.content[1].thoughtSignature, toolSignature);
  assert.equal(getCachedSignatureFamily(reasoningSignature), 'openai');
  assert.equal(getCachedSignature('toolu_sig'), toolSignature);
});

test('convertOutputToAnthropic: empty output returns default text block', () => {
  const result = convertOutputToAnthropic([]);
  assert.deepEqual(result, [{ type: 'text', text: '' }]);
});

test('convertOutputToAnthropic: null/non-array returns default text block', () => {
  assert.deepEqual(convertOutputToAnthropic(null), [{ type: 'text', text: '' }]);
  assert.deepEqual(convertOutputToAnthropic(undefined), [{ type: 'text', text: '' }]);
  assert.deepEqual(convertOutputToAnthropic('string'), [{ type: 'text', text: '' }]);
});

test('convertOutputToAnthropic: mixed output (text + tool_use)', () => {
  const output = [
    { type: 'message', content: [{ type: 'output_text', text: 'Calling tool...' }] },
    { type: 'function_call', call_id: 'fc_1', name: 'search', arguments: '{"q":"test"}' }
  ];
  const result = convertOutputToAnthropic(output);
  assert.equal(result.length, 2);
  assert.equal(result[0].type, 'text');
  assert.equal(result[1].type, 'tool_use');
});

// ─── generateMessageId ────────────────────────────────────────────────────────

test('generateMessageId: returns string starting with msg_', () => {
  const id = generateMessageId();
  assert.ok(typeof id === 'string');
  assert.ok(id.startsWith('msg_'));
});

test('generateMessageId: generates unique IDs', () => {
  const ids = new Set(Array.from({ length: 20 }, () => generateMessageId()));
  assert.equal(ids.size, 20, 'Expected all generated IDs to be unique');
});

test('generateMessageId: ID has expected length (msg_ + 32 hex chars)', () => {
  const id = generateMessageId();
  // 'msg_' (4) + 32 hex chars = 36
  assert.equal(id.length, 36);
});
