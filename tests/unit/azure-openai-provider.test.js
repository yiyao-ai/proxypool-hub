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

test('AzureOpenAIProvider.sendResponsesRequest retries once after transient network close', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_retry_1',
    name: 'azure-test',
    apiKey: 'test-key',
    baseUrl: 'https://example-resource.openai.azure.com/',
    deploymentName: 'deployment-gpt54'
  });

  const originalFetch = global.fetch;
  let attempts = 0;

  global.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      const cause = new Error('other side closed');
      cause.code = 'UND_ERR_SOCKET';
      throw new TypeError('fetch failed', { cause });
    }

    return new Response(JSON.stringify({
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 2,
        output_tokens: 1,
        total_tokens: 3
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendResponsesRequest({
      model: 'gpt-5.4',
      input: 'hello'
    });

    assert.equal(response.status, 200);
    assert.equal(attempts, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AzureOpenAIProvider.sendResponsesRequest does not retry non-network errors', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_retry_2',
    name: 'azure-test',
    apiKey: 'test-key',
    baseUrl: 'https://example-resource.openai.azure.com/',
    deploymentName: 'deployment-gpt54'
  });

  const originalFetch = global.fetch;
  let attempts = 0;

  global.fetch = async () => {
    attempts++;
    throw new TypeError('invalid url');
  };

  try {
    await assert.rejects(
      () => provider.sendResponsesRequest({
        model: 'gpt-5.4',
        input: 'hello'
      }),
      /Azure OpenAI responses request failed: invalid url/
    );
    assert.equal(attempts, 1);
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

test('AzureOpenAIProvider.sendAnthropicRequest uses Azure responses path and returns Anthropic tool_use blocks', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_4',
    name: 'azure-test',
    apiKey: 'test-key',
    baseUrl: 'https://example-resource.openai.azure.com/',
    deploymentName: 'deployment-gpt54'
  });

  const originalFetch = global.fetch;
  let capturedOptions = null;
  let capturedUrl = null;

  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return new Response(JSON.stringify({
      id: 'resp_123',
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          content: [{ type: 'output_text', text: 'I will inspect files first.' }]
        },
        {
          type: 'function_call',
          id: 'fc_call_1',
          call_id: 'fc_call_1',
          name: 'shell_command',
          arguments: '{"command":"Get-ChildItem"}'
        }
      ],
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        total_tokens: 18
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const response = await provider.sendAnthropicRequest({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'inspect repo' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect files first.' },
            { type: 'tool_use', id: 'toolu_call_1', name: 'shell_command', input: { command: 'Get-ChildItem' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_call_1', content: 'file list' }
          ]
        }
      ]
    });

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'https://example-resource.openai.azure.com/openai/v1/responses');

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.model, 'deployment-gpt54');
    assert.equal(payload.stream, false);
    assert.ok(Array.isArray(payload.input));
    assert.equal(payload.input.some(item => item.type === 'function_call_output'), true);

    const anthropic = await response.json();
    assert.equal(anthropic.role, 'assistant');
    assert.equal(anthropic.model, 'claude-opus-4-6');
    assert.equal(anthropic.stop_reason, 'tool_use');
    assert.equal(anthropic.content[0].type, 'text');
    assert.equal(anthropic.content[1].type, 'tool_use');
    assert.equal(anthropic.content[1].name, 'shell_command');
    assert.deepEqual(anthropic.content[1].input, { command: 'Get-ChildItem' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('AzureOpenAIProvider.sendAnthropicRequest preserves tool schema constraints needed by Claude Code', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_5',
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
      id: 'resp_124',
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [
        {
          type: 'function_call',
          id: 'fc_shell_1',
          call_id: 'fc_shell_1',
          name: 'shell_command',
          arguments: '{"command":"Get-ChildItem","timeout_ms":1000}'
        }
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'run a command' }],
      tools: [{
        name: 'shell_command',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', minLength: 1 },
            timeout_ms: { type: 'integer', minimum: 1 }
          },
          required: ['command'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#'
        }
      }]
    });

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.tools[0].name, 'shell_command');
    assert.deepEqual(payload.tools[0].parameters.required, ['command']);
    assert.equal(payload.tools[0].parameters.additionalProperties, false);
    assert.equal(payload.tools[0].parameters.properties.command.minLength, 1);
    assert.equal(payload.tools[0].parameters.properties.timeout_ms.minimum, 1);
    assert.equal('$schema' in payload.tools[0].parameters, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AzureOpenAIProvider.sendAnthropicRequest normalizes top-level union tool schemas for Azure responses', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_5b',
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
      id: 'resp_124b',
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [],
      usage: {
        input_tokens: 5,
        output_tokens: 3,
        total_tokens: 8
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'run a browser click' }],
      tools: [{
        name: 'browser_click',
        description: 'Click an element',
        input_schema: {
          oneOf: [
            {
              type: 'object',
              properties: {
                selector: { type: 'string' }
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
        }
      }]
    });

    const payload = JSON.parse(capturedOptions.body);
    assert.equal(payload.tools[0].parameters.type, 'object');
    assert.equal(payload.tools[0].parameters.oneOf, undefined);
    assert.equal(payload.tools[0].parameters.anyOf, undefined);
    assert.equal(payload.tools[0].parameters.allOf, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('AzureOpenAIProvider.sendAnthropicRequest preserves anthropic image blocks as responses input_image content', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_6',
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
      id: 'resp_vision_1',
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [{
        type: 'message',
        id: 'msg_vision_1',
        content: [{ type: 'output_text', text: 'It looks like a cat.' }]
      }],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        total_tokens: 25
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'claude-opus-4-6',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
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
    });

    const payload = JSON.parse(capturedOptions.body);
    const userMessage = payload.input.find(item => item.type === 'message' && item.role === 'user');
    assert.ok(Array.isArray(userMessage.content));
    assert.equal(userMessage.content[0].type, 'input_text');
    assert.equal(userMessage.content[1].type, 'input_image');
    assert.equal(userMessage.content[1].image_url, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AzureOpenAIProvider.sendAnthropicRequest preserves tool_result image content as multimodal function_call_output', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_7',
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
      id: 'resp_tool_vision_1',
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [{
        type: 'message',
        id: 'msg_tool_vision_1',
        content: [{ type: 'output_text', text: 'The screenshot contains text.' }]
      }],
      usage: {
        input_tokens: 25,
        output_tokens: 6,
        total_tokens: 31
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'claude-opus-4-6',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'D:\\tmp\\demo.png', pages: '1' } }
          ]
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_read_1',
            content: [
              { type: 'text', text: 'Rendered page 1' },
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
        }
      ]
    });

    const payload = JSON.parse(capturedOptions.body);
    const toolOutput = payload.input.find(item => item.type === 'function_call_output');
    assert.ok(Array.isArray(toolOutput.output));
    assert.equal(toolOutput.output[0].type, 'input_text');
    assert.equal(toolOutput.output[1].type, 'input_image');
    assert.equal(toolOutput.output[1].image_url, 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA');
  } finally {
    global.fetch = originalFetch;
  }
});

test('AzureOpenAIProvider.sendAnthropicRequest preserves anthropic document blocks as responses input_file content', async () => {
  const provider = new AzureOpenAIProvider({
    id: 'azure_8',
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
      id: 'resp_doc_azure_1',
      object: 'response',
      model: 'deployment-gpt54',
      status: 'completed',
      output: [{
        type: 'message',
        id: 'msg_doc_1',
        content: [{ type: 'output_text', text: 'document received' }]
      }],
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        total_tokens: 14
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    await provider.sendAnthropicRequest({
      model: 'claude-opus-4-6',
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          title: 'spec.pdf',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: 'JVBERi0xLjQK'
          }
        }]
      }]
    });

    const payload = JSON.parse(capturedOptions.body);
    const userMessage = payload.input.find(item => item.type === 'message' && item.role === 'user');
    assert.ok(Array.isArray(userMessage.content));
    assert.equal(userMessage.content[0].type, 'input_file');
    assert.equal(userMessage.content[0].filename, 'spec.pdf');
    assert.equal(userMessage.content[0].image_url, undefined);
    assert.equal(userMessage.content[0].file_data, 'data:application/pdf;base64,JVBERi0xLjQK');
  } finally {
    global.fetch = originalFetch;
  }
});
