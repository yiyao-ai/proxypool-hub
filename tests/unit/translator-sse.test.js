import test from 'node:test';
import assert from 'node:assert/strict';
import { clearThinkingSignatureCache, getCachedSignature, getCachedSignatureFamily } from '../../src/signature-cache.js';

import {
  streamOpenAIResponsesAsAnthropicEvents,
  parseOpenAIResponsesSSE
} from '../../src/translators/response/openai-responses-sse-to-anthropic-sse.js';

function createSseResponse(events) {
  const payload = events.map(event => `data: ${JSON.stringify(event)}\n`).join('') + '\n';
  return new Response(payload, {
    headers: {
      'Content-Type': 'text/event-stream'
    }
  });
}

test('openai responses sse translator emits anthropic tool-use stream', async () => {
  const response = createSseResponse([
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'fc_tool1', name: 'shell_command' }
    },
    {
      type: 'response.function_call_arguments.delta',
      delta: '{"command":"Get-ChildItem"}'
    },
    {
      type: 'response.completed',
      response: {
        usage: { input_tokens: 1, output_tokens: 2 }
      }
    }
  ]);

  const events = [];
  for await (const event of streamOpenAIResponsesAsAnthropicEvents(response, 'gpt-5.4')) {
    events.push(event);
  }

  assert.equal(events[0].event, 'message_start');
  assert.equal(events[1].event, 'content_block_start');
  assert.equal(events[1].data.content_block.type, 'tool_use');
  assert.equal(events[2].event, 'content_block_delta');
  assert.equal(events[2].data.delta.type, 'input_json_delta');
  assert.equal(events.at(-2).event, 'message_delta');
  assert.equal(events.at(-2).data.delta.stop_reason, 'tool_use');
});

test('openai responses sse parser extracts completed response payload', async () => {
  const response = createSseResponse([
    {
      type: 'response.output_item.added',
      item: { type: 'message', id: 'msg_1' }
    },
    {
      type: 'response.completed',
      response: {
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'done' }] }
        ],
        usage: { input_tokens: 2, output_tokens: 4 }
      }
    }
  ]);

  const parsed = await parseOpenAIResponsesSSE(response);
  assert.equal(parsed.output[0].type, 'message');
  assert.equal(parsed.usage.output_tokens, 4);
});

test('openai responses sse translator uses completed response status to emit max_tokens stop reason', async () => {
  const response = createSseResponse([
    {
      type: 'response.output_item.added',
      item: { type: 'message', id: 'msg_1' }
    },
    {
      type: 'response.output_text.delta',
      delta: 'partial answer'
    },
    {
      type: 'response.completed',
      response: {
        status: 'incomplete',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'partial answer' }] }
        ],
        usage: { input_tokens: 2, output_tokens: 8 }
      }
    }
  ]);

  const events = [];
  for await (const event of streamOpenAIResponsesAsAnthropicEvents(response, 'gpt-5.4')) {
    events.push(event);
  }

  assert.equal(events.at(-2).event, 'message_delta');
  assert.equal(events.at(-2).data.delta.stop_reason, 'max_tokens');
  assert.equal(events.at(-2).data.usage.output_tokens, 8);
});

test('openai responses sse translator emits thinking signature delta and caches signatures', async () => {
  clearThinkingSignatureCache();
  const reasoningSignature = 'r'.repeat(60);
  const toolSignature = 't'.repeat(60);
  const response = createSseResponse([
    {
      type: 'response.output_item.added',
      item: { type: 'reasoning', id: 'rs_1' }
    },
    {
      type: 'response.reasoning.delta',
      delta: 'considering options',
      signature: reasoningSignature
    },
    {
      type: 'response.output_item.done',
      item: { type: 'reasoning', id: 'rs_1', signature: reasoningSignature }
    },
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', call_id: 'fc_sig1', id: 'fc_sig1', name: 'shell_command' }
    },
    {
      type: 'response.function_call_arguments.delta',
      delta: '{"command":"dir"}'
    },
    {
      type: 'response.function_call_arguments.done',
      signature: toolSignature
    },
    {
      type: 'response.completed',
      response: {
        usage: { input_tokens: 2, output_tokens: 4 }
      }
    }
  ]);

  const events = [];
  for await (const event of streamOpenAIResponsesAsAnthropicEvents(response, 'gpt-5.4')) {
    events.push(event);
  }

  const signatureDelta = events.find(event => event.event === 'content_block_delta' && event.data?.delta?.type === 'signature_delta');
  assert.ok(signatureDelta);
  assert.equal(signatureDelta.data.delta.signature, reasoningSignature);
  assert.equal(getCachedSignatureFamily(reasoningSignature), 'openai');
  assert.equal(getCachedSignature('toolu_sig1'), toolSignature);
});
