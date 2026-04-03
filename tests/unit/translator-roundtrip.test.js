import test from 'node:test';
import assert from 'node:assert/strict';

import { translateAnthropicToOpenAIResponsesRequest } from '../../src/translators/request/anthropic-to-openai-responses.js';
import { translateOpenAIResponsesToAnthropicMessage } from '../../src/translators/response/openai-responses-to-anthropic.js';

test('round-trip preserves tool_use semantics across anthropic -> responses -> anthropic', () => {
  const anthropicRequest = {
    model: 'gpt-5.4',
    messages: [{
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'toolu_search1',
        name: 'search',
        input: { query: 'translator architecture' }
      }]
    }]
  };

  const responsesRequest = translateAnthropicToOpenAIResponsesRequest(anthropicRequest, { stream: false });
  const functionCall = responsesRequest.input.find(item => item.type === 'function_call');

  assert.ok(functionCall);
  assert.equal(functionCall.call_id, 'fc_search1');
  assert.equal(functionCall.name, 'search');

  const roundTripped = translateOpenAIResponsesToAnthropicMessage({
    model: responsesRequest.model,
    output: [functionCall],
    usage: { input_tokens: 2, output_tokens: 1 }
  }, {
    requestEcho: responsesRequest.__translatorMeta?.requestEcho
  });

  assert.equal(roundTripped.content[0].type, 'tool_use');
  assert.equal(roundTripped.content[0].id, 'toolu_search1');
  assert.equal(roundTripped.content[0].name, 'search');
  assert.deepEqual(roundTripped.content[0].input, { query: 'translator architecture' });
  assert.equal(roundTripped.stop_reason, 'tool_use');
});

test('round-trip preserves anthropic document input as responses input_file and back to document output', () => {
  const anthropicRequest = {
    model: 'gpt-5.4',
    messages: [{
      role: 'user',
      content: [{
        type: 'document',
        title: 'design.pdf',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: 'JVBERi0xLjQK'
        }
      }]
    }]
  };

  const responsesRequest = translateAnthropicToOpenAIResponsesRequest(anthropicRequest, { stream: false });
  const userMessage = responsesRequest.input.find(item => item.type === 'message' && item.role === 'user');

  assert.ok(Array.isArray(userMessage.content));
  assert.equal(userMessage.content[0].type, 'input_file');
  assert.equal(userMessage.content[0].filename, 'design.pdf');

  const roundTripped = translateOpenAIResponsesToAnthropicMessage({
    model: responsesRequest.model,
    output: [{
      type: 'message',
      content: userMessage.content
    }],
    usage: { input_tokens: 4, output_tokens: 2 }
  }, {
    requestEcho: responsesRequest.__translatorMeta?.requestEcho
  });

  assert.equal(roundTripped.content[0].type, 'document');
  assert.equal(roundTripped.content[0].title, 'design.pdf');
  assert.equal(roundTripped.content[0].source.type, 'base64');
  assert.equal(roundTripped.content[0].source.media_type, 'application/pdf');
});

test('round-trip preserves requestEcho reasoning config and incomplete -> max_tokens behavior', () => {
  const anthropicRequest = {
    model: 'gpt-5.4',
    max_tokens: 2048,
    thinking: {
      type: 'enabled',
      budget_tokens: 12000
    },
    messages: [{ role: 'user', content: 'Summarize the design.' }]
  };

  const responsesRequest = translateAnthropicToOpenAIResponsesRequest(anthropicRequest, { stream: false });

  assert.deepEqual(responsesRequest.reasoning, { effort: 'high' });
  assert.equal(responsesRequest.max_output_tokens, 2048);
  assert.deepEqual(responsesRequest.__translatorMeta?.requestEcho.reasoning, { effort: 'high' });

  const roundTripped = translateOpenAIResponsesToAnthropicMessage({
    status: 'incomplete',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: 'Partial summary' }]
    }],
    usage: { input_tokens: 8, output_tokens: 32 }
  }, {
    requestEcho: responsesRequest.__translatorMeta?.requestEcho
  });

  assert.equal(roundTripped.model, 'gpt-5.4');
  assert.equal(roundTripped.stop_reason, 'max_tokens');
  assert.equal(roundTripped.content[0].type, 'text');
  assert.equal(roundTripped.content[0].text, 'Partial summary');
});
