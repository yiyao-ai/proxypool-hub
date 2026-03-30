import test from 'node:test';
import assert from 'node:assert/strict';

import { sendResponsesSSE } from '../../src/utils/responses-sse.js';

function createMockResponse() {
  const headers = new Map();
  let body = '';
  let ended = false;

  return {
    setHeader(name, value) {
      headers.set(name, value);
    },
    flushHeaders() {},
    write(chunk) {
      body += chunk;
    },
    end() {
      ended = true;
    },
    getState() {
      return { headers, body, ended };
    }
  };
}

function parseSseBody(body) {
  return body
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map(block => {
      const lines = block.split('\n');
      const event = lines.find(line => line.startsWith('event: '))?.slice(7) || '';
      const dataLine = lines.find(line => line.startsWith('data: '))?.slice(6) || '{}';
      return { event, data: JSON.parse(dataLine) };
    });
}

test('sendResponsesSSE emits custom tool input delta/done events', () => {
  const res = createMockResponse();

  sendResponsesSSE(res, {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    model: 'gpt-5.4',
    status: 'completed',
    output: [
      {
        type: 'custom_tool_call',
        id: 'ctc_1',
        call_id: 'call_1',
        name: 'shell_command',
        input: '{"command":"Get-ChildItem"}',
        status: 'completed'
      }
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  });

  const { headers, body, ended } = res.getState();
  const events = parseSseBody(body);

  assert.equal(headers.get('Content-Type'), 'text/event-stream');
  assert.equal(ended, true);
  assert.equal(events[0].event, 'response.created');
  assert.equal(events[1].event, 'response.in_progress');
  assert.equal(events[2].event, 'response.output_item.added');
  assert.equal(events[2].data.item.type, 'custom_tool_call');
  assert.equal(events[2].data.item.input, '');
  assert.equal(events[3].event, 'response.custom_tool_call_input.delta');
  assert.equal(events[3].data.item_id, 'ctc_1');
  assert.equal(events[3].data.call_id, 'call_1');
  assert.equal(events[3].data.delta, '{"command":"Get-ChildItem"}');
  assert.equal(events[4].event, 'response.custom_tool_call_input.done');
  assert.equal(events[4].data.name, 'shell_command');
  assert.equal(events[5].event, 'response.output_item.done');
  assert.equal(events[6].event, 'response.completed');
});

test('sendResponsesSSE emits lifecycle events for apply_patch_call items', () => {
  const res = createMockResponse();

  sendResponsesSSE(res, {
    id: 'resp_2',
    object: 'response',
    created_at: 1,
    model: 'gpt-5.4',
    status: 'completed',
    output: [
      {
        type: 'apply_patch_call',
        id: 'apc_1',
        call_id: 'call_patch_1',
        status: 'completed',
        input: '*** Begin Patch\n*** End Patch'
      }
    ],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  });

  const events = parseSseBody(res.getState().body);
  const added = events.find(event => event.event === 'response.output_item.added');
  const done = events.find(event => event.event === 'response.output_item.done');

  assert.ok(added);
  assert.equal(added.data.item.type, 'apply_patch_call');
  assert.equal(added.data.item.status, 'in_progress');
  assert.ok(done);
  assert.equal(done.data.item.type, 'apply_patch_call');
  assert.equal(events.at(-1).event, 'response.completed');
});
