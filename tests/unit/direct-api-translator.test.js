import test from 'node:test';
import assert from 'node:assert/strict';

import { sendMessage } from '../../src/direct-api.js';

function createSseResponse(events) {
  const payload = events.map(event => `data: ${JSON.stringify(event)}\n`).join('') + '\n';
  return new Response(payload, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream'
    }
  });
}

test('direct-api sendMessage uses translator kernel for non-stream responses', async () => {
  const originalFetch = global.fetch;
  let capturedBody = null;

  global.fetch = async (_url, options) => {
    capturedBody = JSON.parse(options.body);
    return createSseResponse([
      {
        type: 'response.completed',
        response: {
          output: [
            { type: 'message', content: [{ type: 'output_text', text: 'done' }] }
          ],
          usage: { input_tokens: 4, output_tokens: 6 }
        }
      }
    ]);
  };

  try {
    const result = await sendMessage({
      model: 'gpt-5.4',
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'inspect repo' }]
    }, 'token', 'account');

    assert.equal(capturedBody.model, 'gpt-5.4');
    assert.equal(capturedBody.stream, false);
    assert.equal(capturedBody.max_output_tokens, 2048);
    assert.deepEqual(capturedBody.reasoning, { effort: 'none' });
    assert.equal(capturedBody.input[0].role, 'user');
    assert.equal(result.content[0].text, 'done');
    assert.equal(result.usage.output_tokens, 6);
  } finally {
    global.fetch = originalFetch;
  }
});
