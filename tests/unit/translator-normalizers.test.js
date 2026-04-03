import test from 'node:test';
import assert from 'node:assert/strict';

import { convertAnthropicUserContent } from '../../src/translators/normalizers/multimodal.js';
import {
  attachRequestEcho,
  buildRequestEcho,
  mergeRequestEchoIntoContext,
  readRequestEcho,
  resolveResponseModel
} from '../../src/translators/normalizers/request-echo.js';
import {
  normalizeAnthropicReasoningConfig,
  normalizeAnthropicResponsesRequestOptions
} from '../../src/translators/normalizers/responses-request.js';
import { sanitizeToolSchema } from '../../src/translators/normalizers/schemas.js';
import {
  canonicalizeAnthropicTools,
  convertAnthropicToolChoiceToOpenAIResponses,
  convertAnthropicToolsToOpenAIResponses
} from '../../src/translators/normalizers/tools.js';
import { toOpenAIToolId, toAnthropicToolId } from '../../src/translators/normalizers/tool-ids.js';
import { normalizeOpenAIResponsesUsage } from '../../src/translators/normalizers/usage.js';
import { inferAnthropicStopReasonFromResponsesOutput } from '../../src/translators/normalizers/stop-reasons.js';

test('tool id normalizer maps between anthropic and openai ids deterministically', () => {
  assert.equal(toOpenAIToolId('toolu_abc'), 'fc_abc');
  assert.equal(toOpenAIToolId('call_abc'), 'fc_abc');
  assert.equal(toAnthropicToolId('fc_abc'), 'toolu_abc');
});

test('multimodal normalizer preserves rich tool_result image content', () => {
  const result = convertAnthropicUserContent([
    {
      type: 'tool_result',
      tool_use_id: 'toolu_img',
      content: [
        { type: 'text', text: 'image attached' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc123'
          }
        }
      ]
    }
  ]);

  assert.equal(result.toolResults.length, 1);
  assert.ok(Array.isArray(result.toolResults[0].output));
  assert.equal(result.toolResults[0].output[0].type, 'input_text');
  assert.equal(result.toolResults[0].output[1].type, 'input_image');
});

test('multimodal normalizer maps anthropic document blocks to input_file parts', () => {
  const result = convertAnthropicUserContent([
    {
      type: 'document',
      title: 'spec.pdf',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'JVBERi0xLjQK'
      }
    }
  ]);

  assert.equal(result.fileParts.length, 1);
  assert.equal(result.fileParts[0].type, 'input_file');
  assert.equal(result.fileParts[0].media_type, 'application/pdf');
  assert.equal(result.fileParts[0].filename, 'spec.pdf');
  assert.equal(result.fileParts[0].file_data, 'data:application/pdf;base64,JVBERi0xLjQK');
});

test('multimodal normalizer preserves document content inside rich tool_result output', () => {
  const result = convertAnthropicUserContent([
    {
      type: 'tool_result',
      tool_use_id: 'toolu_doc',
      content: [
        { type: 'text', text: 'see attached' },
        {
          type: 'document',
          title: 'report.txt',
          source: {
            type: 'base64',
            media_type: 'text/plain',
            data: 'aGVsbG8='
          }
        }
      ]
    }
  ]);

  assert.equal(result.toolResults.length, 1);
  assert.ok(Array.isArray(result.toolResults[0].output));
  assert.equal(result.toolResults[0].output[0].type, 'input_text');
  assert.equal(result.toolResults[0].output[1].type, 'input_file');
  assert.equal(result.toolResults[0].output[1].filename, 'report.txt');
});

test('schema normalizer flattens top-level unions into provider-safe object schema', () => {
  const schema = sanitizeToolSchema({
    oneOf: [
      {
        type: 'object',
        properties: {
          selector: { type: 'string', minLength: 1 }
        },
        required: ['selector']
      },
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' }
        },
        required: ['x', 'y']
      }
    ]
  });

  assert.equal(schema.type, 'object');
  assert.equal(schema.oneOf, undefined);
  assert.ok(schema.properties.selector || schema.properties.x);
});

test('usage and stop-reason normalizers preserve openai responses semantics', () => {
  const usage = normalizeOpenAIResponsesUsage({
    input_tokens: 5,
    output_tokens: 7,
    cache_read_input_tokens: 2
  });

  assert.deepEqual(usage, {
    input_tokens: 5,
    output_tokens: 7,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0
  });

  assert.equal(inferAnthropicStopReasonFromResponsesOutput([
    { type: 'message', content: [] },
    { type: 'function_call', call_id: 'fc_1', name: 'tool', arguments: '{}' }
  ]), 'tool_use');
});

test('responses request normalizer maps anthropic request options and builds requestEcho', () => {
  const { normalized, requestEcho } = normalizeAnthropicResponsesRequestOptions({
    max_tokens: 4096,
    temperature: 0.3,
    top_p: 0.9,
    stop_sequences: ['STOP', 'END'],
    metadata: { traceId: 'abc' },
    user: 'user-1',
    thinking: { type: 'enabled', budget_tokens: 6000 }
  });

  assert.equal(normalized.max_output_tokens, 4096);
  assert.equal(normalized.temperature, 0.3);
  assert.equal(normalized.top_p, 0.9);
  assert.deepEqual(normalized.stop, ['STOP', 'END']);
  assert.deepEqual(normalized.metadata, { traceId: 'abc' });
  assert.equal(normalized.user, 'user-1');
  assert.deepEqual(normalized.reasoning, { effort: 'medium' });
  assert.equal(requestEcho.parallel_tool_calls, true);
  assert.equal(requestEcho.store, false);
});

test('responses request normalizer maps disabled and adaptive anthropic thinking to reasoning effort', () => {
  assert.deepEqual(
    normalizeAnthropicReasoningConfig({
      thinking: { type: 'disabled' }
    }),
    { effort: 'none' }
  );

  assert.deepEqual(
    normalizeAnthropicReasoningConfig({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }
    }),
    { effort: 'high' }
  );
});

test('request-echo normalizer builds, attaches, reads, and merges requestEcho consistently', () => {
  const request = { model: 'gpt-5.4' };
  const requestEcho = buildRequestEcho(
    { model: 'claude-sonnet-4-6', instructions: 'Be concise.' },
    { reasoning: { effort: 'high' } }
  );

  attachRequestEcho(request, requestEcho);

  assert.deepEqual(readRequestEcho(request), {
    model: 'claude-sonnet-4-6',
    instructions: 'Be concise.',
    reasoning: { effort: 'high' }
  });

  const mergedContext = mergeRequestEchoIntoContext({ mode: 'stream' }, request);
  assert.equal(mergedContext.mode, 'stream');
  assert.equal(mergedContext.requestEcho.model, 'claude-sonnet-4-6');

  assert.equal(
    resolveResponseModel({ model: 'gpt-5.4' }, mergedContext),
    'claude-sonnet-4-6'
  );
});

test('tools normalizer canonicalizes function and hosted anthropic tools explicitly', () => {
  const canonical = canonicalizeAnthropicTools([
    {
      name: 'search_repo',
      description: 'Search the repo',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', minLength: 1 }
        }
      }
    },
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 3
    }
  ]);

  assert.equal(canonical[0].kind, 'function');
  assert.equal(canonical[0].name, 'search_repo');
  assert.equal(canonical[0].parameters.properties.query.type, 'string');
  assert.equal('minLength' in canonical[0].parameters.properties.query, false);
  assert.equal(canonical[1].kind, 'hosted');
  assert.equal(canonical[1].name, 'web_search');
  assert.equal(canonical[1].hostedType, 'web_search_20250305');
});

test('tools normalizer omits hosted tools for openai responses and reports them explicitly', () => {
  const result = convertAnthropicToolsToOpenAIResponses([
    {
      name: 'search_repo',
      input_schema: { type: 'object', properties: { query: { type: 'string' } } }
    },
    {
      type: 'web_search_20250305',
      name: 'web_search'
    }
  ]);

  assert.equal(result.tools.length, 1);
  assert.equal(result.tools[0].type, 'function');
  assert.equal(result.tools[0].name, 'search_repo');
  assert.equal(result.unsupportedTools.length, 1);
  assert.equal(result.unsupportedTools[0].name, 'web_search');
  assert.equal(result.unsupportedTools[0].hostedType, 'web_search_20250305');
  assert.equal(result.unsupportedTools[0].action, 'omit');
});

test('tools normalizer downgrades hosted tool_choice for unsupported targets explicitly', () => {
  const canonical = canonicalizeAnthropicTools([
    {
      type: 'web_search_20250305',
      name: 'web_search'
    }
  ]);

  const result = convertAnthropicToolChoiceToOpenAIResponses(
    { type: 'tool', name: 'web_search' },
    canonical
  );

  assert.equal(result.value, 'auto');
  assert.equal(result.meta.reason, 'target_does_not_support_hosted_tool_choice');
  assert.equal(result.meta.requestedTool, 'web_search');
});
