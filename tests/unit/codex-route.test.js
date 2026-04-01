import test from 'node:test';
import assert from 'node:assert/strict';

import { _testExports } from '../../src/routes/codex-route.js';

const { _codexToChatBody, findToolCallSequenceError } = _testExports;

test('_codexToChatBody merges assistant text before function_call into one tool-calling assistant message', () => {
  const body = {
    model: 'gpt-5.4',
    input: [
      { type: 'message', role: 'user', content: 'check repo' },
      { type: 'message', role: 'assistant', content: 'I will inspect files first.' },
      { type: 'function_call', call_id: 'call_1', name: 'shell_command', arguments: '{"command":"Get-ChildItem"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file list' }
    ]
  };

  const chatBody = _codexToChatBody(body);

  assert.equal(chatBody.messages.length, 3);
  assert.equal(chatBody.messages[1].role, 'assistant');
  assert.equal(chatBody.messages[1].content, 'I will inspect files first.');
  assert.equal(chatBody.messages[1].tool_calls[0].id, 'call_1');
  assert.equal(chatBody.messages[2].role, 'tool');
  assert.equal(chatBody.messages[2].tool_call_id, 'call_1');
  assert.equal(findToolCallSequenceError(chatBody.messages), null);
});

test('_codexToChatBody defers system messages inserted between tool_calls and tool outputs', () => {
  const body = {
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

  const chatBody = _codexToChatBody(body);

  assert.equal(chatBody.messages.length, 4);
  assert.equal(chatBody.messages[1].role, 'assistant');
  assert.equal(chatBody.messages[1].tool_calls[0].id, 'call_3');
  assert.equal(chatBody.messages[2].role, 'tool');
  assert.equal(chatBody.messages[2].tool_call_id, 'call_3');
  assert.equal(chatBody.messages[3].role, 'system');
  assert.match(chatBody.messages[3].content, /Approved command prefix saved/);
  assert.equal(findToolCallSequenceError(chatBody.messages), null);
});

test('findToolCallSequenceError detects assistant tool_calls not followed by tool messages in codex route', () => {
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

test('_codexToChatBody keeps antigravity model id untouched for downstream mapping', () => {
  const body = {
    model: 'antigravity/gemini-2.5-pro',
    input: [
      { type: 'message', role: 'user', content: 'hello' }
    ]
  };

  const chatBody = _codexToChatBody(body);

  assert.equal(chatBody.model, 'antigravity/gemini-2.5-pro');
  assert.equal(chatBody.messages.length, 1);
  assert.equal(chatBody.messages[0].role, 'user');
});

test('codex route test exports remain available after strict compatibility changes', () => {
  assert.equal(typeof _codexToChatBody, 'function');
  assert.equal(typeof findToolCallSequenceError, 'function');
});
