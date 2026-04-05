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
    assert.equal('max_completion_tokens' in capturedBody, false);
    assert.equal('max_output_tokens' in capturedBody, false);
    assert.equal('temperature' in capturedBody, false);
    assert.equal('metadata' in capturedBody, false);
    assert.equal('top_p' in capturedBody, false);
    assert.equal('user' in capturedBody, false);
    assert.equal('reasoning' in capturedBody, false);
    assert.equal(capturedBody.input[0].role, 'user');
    assert.equal(result.content[0].text, 'done');
    assert.equal(result.usage.output_tokens, 6);
  } finally {
    global.fetch = originalFetch;
  }
});

test('direct-api sendMessage encodes tool_result images for chatgpt backend as data URLs instead of raw data fields', async () => {
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
    await sendMessage({
      model: 'gpt-5.4',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_img',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAUA'
            }
          }]
        }]
      }]
    }, 'token', 'account');

    const toolOutput = capturedBody.input.find(item => item.type === 'function_call_output');
    const imagePart = toolOutput.output[0];
    assert.equal(imagePart.type, 'input_image');
    assert.equal(imagePart.image_url, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA');
    assert.equal('data' in imagePart, false);
    assert.equal('media_type' in imagePart, false);
  } finally {
    global.fetch = originalFetch;
  }
});
