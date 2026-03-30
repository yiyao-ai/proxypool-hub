import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/routes/responses-route.js';

const { _responsesToChatBody, findToolCallSequenceError } = _testExports;

test('_responsesToChatBody merges assistant text before function_call into one tool-calling assistant message', () => {
  const parsed = {
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'check repo' },
      { type: 'message', role: 'assistant', content: 'I will inspect files first.' },
      { type: 'function_call', call_id: 'call_1', name: 'shell_command', arguments: '{"command":"Get-ChildItem"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file list' }
    ]
  };

  const body = _responsesToChatBody(parsed);

  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].content, 'I will inspect files first.');
  assert.equal(body.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[2].tool_call_id, 'call_1');
  assert.equal(findToolCallSequenceError(body.messages), null);
});

test('_responsesToChatBody merges assistant text after function_call into the same tool-calling assistant message', () => {
  const parsed = {
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'check repo' },
      { type: 'function_call', call_id: 'call_2', name: 'shell_command', arguments: '{"command":"git status"}' },
      { type: 'message', role: 'assistant', content: 'I am checking the working tree.' },
      { type: 'function_call_output', call_id: 'call_2', output: 'clean' }
    ]
  };

  const body = _responsesToChatBody(parsed);

  assert.equal(body.messages.length, 3);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].content, 'I am checking the working tree.');
  assert.equal(body.messages[1].tool_calls[0].id, 'call_2');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[2].tool_call_id, 'call_2');
  assert.equal(findToolCallSequenceError(body.messages), null);
});

test('_responsesToChatBody defers system messages inserted between tool_calls and tool outputs', () => {
  const parsed = {
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'verify config migration' },
      {
        type: 'message',
        role: 'assistant',
        content: 'I need to write back the old value once to verify migration.'
      },
      {
        type: 'function_call',
        call_id: 'call_3',
        name: 'shell_command',
        arguments: '{"command":"pwsh -Command ..."}'
      },
      {
        type: 'message',
        role: 'developer',
        content: 'Approved command prefix saved: [pwsh, -Command, node ...]'
      },
      {
        type: 'function_call_output',
        call_id: 'call_3',
        output: '{"afterSticky":"sequential"}'
      }
    ]
  };

  const body = _responsesToChatBody(parsed);

  assert.equal(body.messages.length, 4);
  assert.equal(body.messages[1].role, 'assistant');
  assert.equal(body.messages[1].tool_calls[0].id, 'call_3');
  assert.equal(body.messages[2].role, 'tool');
  assert.equal(body.messages[2].tool_call_id, 'call_3');
  assert.equal(body.messages[3].role, 'system');
  assert.match(body.messages[3].content, /Approved command prefix saved/);
  assert.equal(findToolCallSequenceError(body.messages), null);
});

test('findToolCallSequenceError detects assistant tool_calls not followed by tool messages', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'running tool',
      tool_calls: [
        {
          id: 'call_missing',
          type: 'function',
          function: { name: 'shell_command', arguments: '{}' }
        }
      ]
    },
    { role: 'assistant', content: 'unexpected extra assistant message' }
  ];

  const error = findToolCallSequenceError(messages);

  assert.ok(error);
  assert.equal(error.assistantIndex, 1);
  assert.deepEqual(error.missingIds, ['call_missing']);
  assert.equal(error.nextRole, 'assistant');
});
