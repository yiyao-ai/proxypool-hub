import { getServerSettings } from './server-settings.js';
import { getPrimaryLocalRuntime, getDefaultLocalModel } from './local-runtime-manager.js';
import {
  sendOllamaAnthropicRequest,
  sendOllamaChatRequest,
  sendOllamaResponsesRequest
} from './runtimes/ollama.js';
import { sendResponsesSSE } from './utils/responses-sse.js';
import { resolveModel } from './model-mapping.js';

function getRuntimeIfEnabled({ forceLocal = false } = {}) {
  const settings = getServerSettings();
  if (!forceLocal && settings.localModelRoutingEnabled !== true) return null;
  return getPrimaryLocalRuntime();
}

function resolveAssignedModel(runtime, appId, requestedModel, assignedModel = '') {
  if (assignedModel) return assignedModel;
  const configured = runtime?.defaultModels?.[appId] || getDefaultLocalModel(appId);
  return configured || requestedModel;
}

function pipeSSE(res, response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const reader = response.body?.getReader?.();
  if (!reader) {
    res.end();
    return Promise.resolve();
  }

  return (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.writableEnded || res.destroyed) break;
        res.write(value);
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  })();
}

function chatToResponsesFormat(chatResponse, model) {
  const choice = chatResponse.choices?.[0];
  const msg = choice?.message || {};
  const output = [];

  if (msg.content) {
    output.push({
      type: 'message',
      id: `msg_${Date.now()}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: msg.content }]
    });
  }

  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id,
        call_id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments || '{}'
      });
    }
  }

  return {
    id: chatResponse.id || `resp_${Date.now()}`,
    object: 'response',
    created_at: chatResponse.created || Math.floor(Date.now() / 1000),
    model,
    status: 'completed',
    output,
    usage: {
      input_tokens: chatResponse.usage?.prompt_tokens || 0,
      output_tokens: chatResponse.usage?.completion_tokens || 0,
      total_tokens: chatResponse.usage?.total_tokens || 0
    }
  };
}

function codexToChatBody(body, model) {
  const messages = [];

  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type !== 'message') continue;
      const content = Array.isArray(item.content)
        ? item.content
            .map((part) => part?.text || '')
            .filter(Boolean)
            .join('\n')
        : '';
      messages.push({ role: item.role || 'user', content });
    }
  } else if (typeof body.input === 'string') {
    messages.push({ role: 'user', content: body.input });
  }

  const chatBody = {
    model,
    messages,
    stream: false
  };

  if (body.max_output_tokens) chatBody.max_completion_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chatBody.tools = body.tools
      .filter((tool) => tool.type === 'function')
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        }
      }));
  }

  return chatBody;
}

export function getLocalRoutingStatus() {
  const settings = getServerSettings();
  const runtime = getPrimaryLocalRuntime();
  return {
    enabled: settings.localModelRoutingEnabled === true,
    runtimeConfigured: !!runtime,
    runtime
  };
}

export async function tryHandleLocalAnthropic(req, res, body, { appId, requestedModel, assignedModel = '', forceLocal = false }) {
  const runtime = getRuntimeIfEnabled({ forceLocal });
  if (!runtime) return false;
  if (runtime.type !== 'ollama') return false;

  const localModel = resolveAssignedModel(runtime, appId, requestedModel, assignedModel);
  const mappedBody = {
    ...body,
    model: localModel,
    stream: body.stream !== false
  };

  const response = await sendOllamaAnthropicRequest(runtime.baseUrl, mappedBody, {
    headers: {
      'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
      ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {})
    }
  });

  if (!response.ok) return false;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') || mappedBody.stream) {
    await pipeSSE(res, response);
    return true;
  }

  const payload = await response.text();
  res.status(200).type('json').send(payload);
  return true;
}

export async function tryHandleLocalChat(res, body, { appId, requestedModel, assignedModel = '', forceLocal = false }) {
  const runtime = getRuntimeIfEnabled({ forceLocal });
  if (!runtime) return false;
  if (runtime.type !== 'ollama') return false;

  const localModel = resolveAssignedModel(runtime, appId, requestedModel, assignedModel);
  const mappedModel = resolveModel('openai', localModel);
  const response = await sendOllamaChatRequest(runtime.baseUrl, {
    ...body,
    model: mappedModel
  });

  if (!response.ok) return false;
  const payload = await response.text();
  res.status(200).type('json').send(payload);
  return true;
}

export async function tryHandleLocalResponses(res, body, { appId, requestedModel, isStreaming, assignedModel = '', forceLocal = false }) {
  const runtime = getRuntimeIfEnabled({ forceLocal });
  if (!runtime) return false;
  if (runtime.type !== 'ollama') return false;

  const localModel = resolveAssignedModel(runtime, appId, requestedModel, assignedModel);
  let response = await sendOllamaResponsesRequest(runtime.baseUrl, {
    ...body,
    model: localModel,
    stream: false
  });

  if (response.ok) {
    const payload = await response.text();
    try {
      const parsed = JSON.parse(payload);
      if (isStreaming) sendResponsesSSE(res, parsed); else res.json(parsed);
      return true;
    } catch {
      return false;
    }
  }

  const chatBody = codexToChatBody(body, localModel);
  response = await sendOllamaChatRequest(runtime.baseUrl, chatBody);
  if (!response.ok) return false;

  const payload = await response.text();
  try {
    const parsed = JSON.parse(payload);
    const normalized = chatToResponsesFormat(parsed, localModel);
    if (isStreaming) sendResponsesSSE(res, normalized); else res.json(normalized);
    return true;
  } catch {
    return false;
  }
}

export default {
  getLocalRoutingStatus,
  tryHandleLocalAnthropic,
  tryHandleLocalChat,
  tryHandleLocalResponses
};
