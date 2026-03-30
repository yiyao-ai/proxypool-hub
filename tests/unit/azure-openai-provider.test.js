import test from 'node:test';
import assert from 'node:assert/strict';

import { AzureOpenAIProvider } from '../../src/providers/azure-openai.js';

test('AzureOpenAIProvider.sendResponsesRequest uses Azure responses endpoint and deployment name model', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_1',
    name: 'azure-test',
    apiKey: 'test-key',
    baseUrl: 'https://example-resource.openai.azure.com/',
    deploymentName: 'deployment-gpt54',
    apiVersion: '2024-10-21'
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(JSON.stringify({
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendResponsesRequest({
      model: 'gpt-5.4',
      input: 'hello',
      tools: [{ type: 'custom', name: 'apply_patch' }]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://example-resource.openai.azure.com/openai/v1/responses');
    assert.equal(capturedOptions.headers['api-key'], 'test-key');

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.model, 'deployment-gpt54');
    assert.deepEqual(payload.tools, [{ type: 'custom', name: 'apply_patch' }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AzureOpenAIProvider.sendRequest surfaces nested fetch cause details', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_2',
    name: 'azure-test',
    apiKey: 'test-key',
    baseUrl: 'https://example-resource.openai.azure.com/',
    deploymentName: 'deployment-gpt54'
  });

  const originalFetch = global.fetch;
  global.fetch = async () => {
    const cause = new Error('connect ETIMEDOUT example-resource.openai.azure.com');
    throw new TypeError('fetch failed', { cause });
  };

  try {
    await assert.rejects(
      () => provider.sendRequest({ messages: [{ role: 'user', content: 'hi' }] }),
      /Azure OpenAI chat completions request failed: connect ETIMEDOUT/
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('AzureOpenAIProvider.sendResponsesRequest strips encrypted content fields for Azure compatibility', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_3',
    name: 'azure-test',
    apiKey: 'test-key',
    baseUrl: 'https://example-resource.openai.azure.com/',
    deploymentName: 'deployment-gpt54'
  });

  const originalFetch = global.fetch;
  let capturedOptions = null;

  global.fetch = async (_url, options) => {
    capturedOptions = options;
    return new Response(JSON.stringify({
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendResponsesRequest({
      model: 'gpt-5.4',
      include: ['reasoning.encrypted_content', 'something_else'],
      input: [
        {
          type: 'reasoning',
          id: 'rs_1',
          encrypted_content: 'gAAA-secret',
          summary: [{ type: 'summary_text', text: 'plain summary' }],
          signature: 'sig_123'
        },
        {
          type: 'compaction',
          encrypted_content: 'gAAA-compact'
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }]
        }
      ]
    });

    const payload = JSON.parse(capturedOptions.body);
    assert.deepEqual(payload.include, ['something_else']);
    assert.equal(payload.input.length, 2);
    assert.equal(payload.input[0].type, 'reasoning');
    assert.equal('encrypted_content' in payload.input[0], false);
    assert.equal('signature' in payload.input[0], false);
    assert.equal(payload.input[1].type, 'message');
  } finally {
    global.fetch = originalFetch;
  }
});
