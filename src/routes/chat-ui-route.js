import { listAccounts } from '../account-manager.js';
import {
  loadAccounts as loadClaudeAccounts,
  refreshAccountToken as refreshClaudeAccountToken,
  getAccount as getClaudeAccount
} from '../claude-account-manager.js';
import { recordClaudeRuntimeObservation } from '../claude-usage.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { sendMessage, sendMessageStream } from '../direct-api.js';
import { sendClaudeMessageWithMeta, sendClaudeStream, mapToClaudeModel, extractClaudeRateLimitHeaders } from '../claude-api.js';
import { listApiKeys, getProviderById, recordUsage, recordError, recordRateLimit } from '../api-key-manager.js';
import { resolveModel } from '../model-mapping.js';
import { logger } from '../utils/logger.js';

export async function handleListChatSources(_req, res) {
  const chatgptSources = listAccounts().accounts
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      id: `chatgpt:${account.email}`,
      kind: 'chatgpt-account',
      label: account.email,
      description: `ChatGPT account${account.isActive ? ' - active' : ''}`,
      meta: {
        email: account.email,
        planType: account.planType,
        isActive: account.isActive
      }
    }));

  const claudeData = loadClaudeAccounts();
  const claudeSources = (claudeData.accounts || [])
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      id: `claude:${account.email}`,
      kind: 'claude-account',
      label: account.displayName || account.email,
      description: `Claude account - ${account.email}`,
      meta: {
        email: account.email,
        subscriptionType: account.subscriptionType || 'free',
        isActive: account.email === claudeData.activeAccount
      }
    }));

  const apiKeySources = listApiKeys()
    .filter((key) => key.enabled !== false)
    .map((key) => ({
      id: `apikey:${key.id}`,
      kind: 'api-key',
      label: key.name,
      description: `${key.type} - ${key.apiKey}`,
      meta: {
        keyId: key.id,
        providerType: key.type,
        isAvailable: key.isAvailable
      }
    }));

  res.json({
    sources: [...chatgptSources, ...claudeSources, ...apiKeySources]
  });
}

export async function handleChatWithSource(req, res) {
  const { sourceId, model, messages, temperature } = req.body || {};

  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).json({ success: false, error: 'sourceId is required' });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages must be a non-empty array' });
  }

  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : 'gpt-5.2';

  try {
    if (sourceId.startsWith('chatgpt:')) {
      const email = sourceId.slice('chatgpt:'.length);
      const creds = await getCredentialsForAccount(email);
      if (!creds) {
        return res.status(404).json({ success: false, error: `ChatGPT account not available: ${email}` });
      }

      const anthropicRequest = buildAnthropicRequest({
        model: requestedModel,
        messages,
        temperature
      });

      const response = await sendMessage(anthropicRequest, creds.accessToken, creds.accountId);
      return res.json({
        success: true,
        source: {
          id: sourceId,
          kind: 'chatgpt-account',
          label: email
        },
        model: requestedModel,
        reply: normalizeAnthropicResponse(response, requestedModel)
      });
    }

    if (sourceId.startsWith('claude:')) {
      const email = sourceId.slice('claude:'.length);
      const claudeData = loadClaudeAccounts();
      let account = (claudeData.accounts || []).find((item) => item.email === email && item.enabled !== false);
      if (!account?.accessToken) {
        return res.status(404).json({ success: false, error: `Claude account not available: ${email}` });
      }

      const upstreamModel = resolveModel('anthropic', requestedModel) || mapToClaudeModel(requestedModel);
      let response;

      try {
        const result = await sendClaudeMessageWithMeta(buildAnthropicRequest({
          model: upstreamModel,
          messages,
          temperature
        }), account.accessToken);
        response = result.data;
        recordClaudeRuntimeObservation(account.email, result.rateLimitHeaders, { model: upstreamModel });
      } catch (error) {
        recordClaudeRuntimeObservation(account.email, error.rateLimitHeaders, { model: upstreamModel });
        if (!error.message?.startsWith('AUTH_EXPIRED')) {
          throw error;
        }

        const refreshResult = await refreshClaudeAccountToken(email);
        if (!refreshResult.success) {
          throw error;
        }

        account = getClaudeAccount(email) || account;
        const result = await sendClaudeMessageWithMeta(buildAnthropicRequest({
          model: upstreamModel,
          messages,
          temperature
        }), account.accessToken);
        response = result.data;
        recordClaudeRuntimeObservation(account.email, result.rateLimitHeaders, { model: upstreamModel });
      }

      return res.json({
        success: true,
        source: {
          id: sourceId,
          kind: 'claude-account',
          label: account.displayName || email
        },
        model: requestedModel,
        mappedModel: upstreamModel,
        reply: normalizeAnthropicResponse(response, requestedModel)
      });
    }

    if (sourceId.startsWith('apikey:')) {
      const keyId = sourceId.slice('apikey:'.length);
      const provider = getProviderById(keyId);
      if (!provider || provider.enabled === false) {
        return res.status(404).json({ success: false, error: `API key not available: ${keyId}` });
      }

      const startTime = Date.now();
      const isAnthropic = provider.type === 'anthropic';
      const mappedModel = isAnthropic
        ? (resolveModel('anthropic', requestedModel) || mapToClaudeModel(requestedModel))
        : (resolveModel(provider.type, requestedModel) || requestedModel);
      const requestBody = isAnthropic
        ? buildAnthropicRequest({ model: mappedModel, messages, temperature })
        : buildOpenAIChatRequest({ model: mappedModel, messages, temperature });

      const response = await provider.sendRequest(requestBody);
      const durationMs = Date.now() - startTime;
      const responseText = await response.text();

      if (response.status === 429) {
        const retryAfter = response.headers?.get?.('retry-after');
        recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000);
      }

      if (!response.ok) {
        recordError(provider.id);
        return res.status(response.status).json({
          success: false,
          error: responseText || `Provider request failed with ${response.status}`
        });
      }

      const parsed = JSON.parse(responseText);
      const usage = isAnthropic
        ? {
            inputTokens: parsed.usage?.input_tokens || 0,
            outputTokens: parsed.usage?.output_tokens || 0
          }
        : {
            inputTokens: parsed.usage?.prompt_tokens || 0,
            outputTokens: parsed.usage?.completion_tokens || 0
          };

      recordUsage(provider.id, { ...usage, model: mappedModel });
      logger.info(`[ChatUI] OK via ${provider.type}/${provider.name} | ${requestedModel} -> ${mappedModel} | ${durationMs}ms`);

      return res.json({
        success: true,
        source: {
          id: sourceId,
          kind: 'api-key',
          label: provider.name
        },
        model: requestedModel,
        mappedModel,
        reply: isAnthropic
          ? normalizeAnthropicResponse(parsed, requestedModel)
          : normalizeOpenAIResponse(parsed, requestedModel)
      });
    }

    return res.status(400).json({ success: false, error: `Unsupported sourceId: ${sourceId}` });
  } catch (error) {
    logger.error(`[ChatUI] ${sourceId} failed: ${error.message}`);
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function handleStreamChatWithSource(req, res) {
  const { sourceId, model, messages, temperature } = req.body || {};

  if (!sourceId || typeof sourceId !== 'string') {
    return res.status(400).json({ success: false, error: 'sourceId is required' });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, error: 'messages must be a non-empty array' });
  }

  const requestedModel = typeof model === 'string' && model.trim() ? model.trim() : 'gpt-5.2';

  prepareSseResponse(res);

  try {
    if (sourceId.startsWith('chatgpt:')) {
      const email = sourceId.slice('chatgpt:'.length);
      const creds = await getCredentialsForAccount(email);
      if (!creds) {
        writeSse(res, { type: 'error', error: `ChatGPT account not available: ${email}` });
        return res.end();
      }

      writeSse(res, {
        type: 'start',
        source: { id: sourceId, kind: 'chatgpt-account', label: email },
        model: requestedModel
      });

      const anthropicRequest = buildAnthropicRequest({
        model: requestedModel,
        messages,
        temperature,
        stream: true
      });

      return await streamAnthropicEvents(
        sendMessageStream(anthropicRequest, creds.accessToken, creds.accountId),
        res,
        { requestedModel }
      );
    }

    if (sourceId.startsWith('claude:')) {
      const email = sourceId.slice('claude:'.length);
      const claudeData = loadClaudeAccounts();
      let account = (claudeData.accounts || []).find((item) => item.email === email && item.enabled !== false);
      if (!account?.accessToken) {
        writeSse(res, { type: 'error', error: `Claude account not available: ${email}` });
        return res.end();
      }

      const upstreamModel = resolveModel('anthropic', requestedModel) || mapToClaudeModel(requestedModel);
      writeSse(res, {
        type: 'start',
        source: { id: sourceId, kind: 'claude-account', label: account.displayName || email },
        model: requestedModel,
        mappedModel: upstreamModel
      });

      try {
        const response = await sendClaudeStream(buildAnthropicRequest({
          model: upstreamModel,
          messages,
          temperature,
          stream: true
        }), account.accessToken);
        recordClaudeRuntimeObservation(account.email, extractClaudeRateLimitHeaders(response.headers), { model: upstreamModel });
        return await streamAnthropicResponse(response, res, { requestedModel, mappedModel: upstreamModel });
      } catch (error) {
        recordClaudeRuntimeObservation(account.email, error.rateLimitHeaders, { model: upstreamModel });
        if (!error.message?.startsWith('AUTH_EXPIRED')) {
          throw error;
        }

        const refreshResult = await refreshClaudeAccountToken(email);
        if (!refreshResult.success) {
          throw error;
        }

        account = getClaudeAccount(email) || account;
        const retryResponse = await sendClaudeStream(buildAnthropicRequest({
          model: upstreamModel,
          messages,
          temperature,
          stream: true
        }), account.accessToken);
        recordClaudeRuntimeObservation(account.email, extractClaudeRateLimitHeaders(retryResponse.headers), { model: upstreamModel });
        return await streamAnthropicResponse(retryResponse, res, { requestedModel, mappedModel: upstreamModel });
      }
    }

    if (sourceId.startsWith('apikey:')) {
      const keyId = sourceId.slice('apikey:'.length);
      const provider = getProviderById(keyId);
      if (!provider || provider.enabled === false) {
        writeSse(res, { type: 'error', error: `API key not available: ${keyId}` });
        return res.end();
      }

      const isAnthropic = provider.type === 'anthropic';
      const mappedModel = isAnthropic
        ? (resolveModel('anthropic', requestedModel) || mapToClaudeModel(requestedModel))
        : (resolveModel(provider.type, requestedModel) || requestedModel);

      writeSse(res, {
        type: 'start',
        source: { id: sourceId, kind: 'api-key', label: provider.name },
        model: requestedModel,
        mappedModel
      });

      const startTime = Date.now();
      if (isAnthropic) {
        const response = await provider.sendRequest(buildAnthropicRequest({
          model: mappedModel,
          messages,
          temperature,
          stream: true
        }), { stream: true });

        if (!response.ok) {
          const errorText = await response.text();
          if (response.status === 429) {
            const retryAfter = response.headers?.get?.('retry-after');
            recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000);
          }
          recordError(provider.id);
          writeSse(res, { type: 'error', error: errorText || `Provider request failed with ${response.status}` });
          return res.end();
        }

        return await streamAnthropicResponse(response, res, {
          requestedModel,
          mappedModel,
          provider,
          startedAt: startTime
        });
      }

      const response = await provider.sendRequest(buildOpenAIChatRequest({
        model: mappedModel,
        messages,
        temperature,
        stream: true
      }), { stream: true });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 429) {
          const retryAfter = response.headers?.get?.('retry-after');
          recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000);
        }
        recordError(provider.id);
        writeSse(res, { type: 'error', error: errorText || `Provider request failed with ${response.status}` });
        return res.end();
      }

      const contentType = response.headers?.get?.('content-type') || '';
      if (contentType.includes('text/event-stream')) {
        return await streamOpenAIResponse(response, res, {
          requestedModel,
          mappedModel,
          provider,
          startedAt: startTime
        });
      }

      const responseText = await response.text();
      const parsed = JSON.parse(responseText);
      const usage = {
        inputTokens: parsed.usage?.prompt_tokens || 0,
        outputTokens: parsed.usage?.completion_tokens || 0
      };

      recordUsage(provider.id, { ...usage, model: mappedModel });
      logger.info(`[ChatUI] stream fallback via ${provider.type}/${provider.name} | ${requestedModel} -> ${mappedModel} | ${Date.now() - startTime}ms`);

      const reply = normalizeOpenAIResponse(parsed, requestedModel);
      if (reply.content) {
        writeSse(res, { type: 'delta', text: reply.content });
      }
      writeSse(res, { type: 'done', model: requestedModel, mappedModel, usage: reply.usage || null });
      return res.end();
    }

    writeSse(res, { type: 'error', error: `Unsupported sourceId: ${sourceId}` });
    return res.end();
  } catch (error) {
    logger.error(`[ChatUI] stream ${sourceId} failed: ${error.message}`);
    writeSse(res, { type: 'error', error: error.message });
    return res.end();
  }
}

function buildOpenAIChatRequest({ model, messages, temperature, stream = false }) {
  const body = {
    model,
    messages: sanitizeOpenAIMessages(messages)
  };

  if (typeof temperature === 'number') {
    body.temperature = temperature;
  }

  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }

  return body;
}

function buildAnthropicRequest({ model, messages, temperature, stream = false }) {
  const body = {
    model,
    messages: [],
    stream
  };

  const sanitizedMessages = sanitizeOpenAIMessages(messages);
  const systemMessages = sanitizedMessages.filter((msg) => msg.role === 'system');

  if (systemMessages.length > 0) {
    body.system = systemMessages.map((msg) => msg.content).join('\n\n');
  }

  body.messages = sanitizedMessages
    .filter((msg) => msg.role !== 'system')
    .map((msg) => ({
      role: msg.role === 'tool' ? 'user' : msg.role,
      content: coerceAnthropicContent(msg)
    }));

  if (typeof temperature === 'number') {
    body.temperature = temperature;
  }

  return body;
}

function sanitizeOpenAIMessages(messages) {
  return messages
    .filter((msg) => msg && typeof msg.role === 'string')
    .map((msg) => ({
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : coerceTextContent(msg.content)
    }))
    .filter((msg) => msg.content);
}

function coerceAnthropicContent(message) {
  if (message.role === 'assistant') {
    return [{ type: 'text', text: message.content }];
  }
  return message.content;
}

function coerceTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text') return item.text || '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function normalizeAnthropicResponse(response, requestedModel) {
  const text = (response.content || [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('\n\n');

  return {
    role: 'assistant',
    content: text,
    model: requestedModel,
    usage: {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
      total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
    }
  };
}

function normalizeOpenAIResponse(response, requestedModel) {
  const choice = response.choices?.[0];
  return {
    role: 'assistant',
    content: choice?.message?.content || '',
    model: requestedModel,
    usage: {
      prompt_tokens: response.usage?.prompt_tokens || 0,
      completion_tokens: response.usage?.completion_tokens || 0,
      total_tokens: response.usage?.total_tokens
        || ((response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0))
    }
  };
}

function prepareSseResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamAnthropicEvents(eventIterator, res, { requestedModel, mappedModel = null, provider = null, startedAt = Date.now() }) {
  let usage = null;
  let streamedText = false;

  for await (const event of eventIterator) {
    if (event?.event === 'content_block_delta' && event.data?.delta?.type === 'text_delta') {
      const text = event.data.delta.text || '';
      if (text) {
        streamedText = true;
        writeSse(res, { type: 'delta', text });
      }
    }

    if (event?.event === 'message_delta' && event.data?.usage) {
      usage = {
        prompt_tokens: event.data.usage.input_tokens || event.data.usage.prompt_tokens || 0,
        completion_tokens: event.data.usage.output_tokens || event.data.usage.completion_tokens || 0,
        total_tokens: (event.data.usage.input_tokens || event.data.usage.prompt_tokens || 0)
          + (event.data.usage.output_tokens || event.data.usage.completion_tokens || 0)
      };
    }
  }

  if (provider && usage) {
    recordUsage(provider.id, {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      model: mappedModel || requestedModel
    });
    logger.info(`[ChatUI] stream via ${provider.type}/${provider.name} | ${requestedModel} -> ${mappedModel || requestedModel} | ${Date.now() - startedAt}ms`);
  }

  if (!streamedText) {
    writeSse(res, { type: 'delta', text: '' });
  }
  writeSse(res, { type: 'done', model: requestedModel, mappedModel, usage });
  res.end();
}

async function streamAnthropicResponse(response, res, options) {
  return streamAnthropicEvents(parseAnthropicStream(response), res, options);
}

async function* parseAnthropicStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const boundary = /\r?\n\r?\n/g;
    let lastIndex = 0;
    let match;
    const chunks = [];

    while ((match = boundary.exec(buffer)) !== null) {
      chunks.push(buffer.slice(lastIndex, match.index));
      lastIndex = match.index + match[0].length;
    }

    buffer = buffer.slice(lastIndex);

    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/);
      let dataLine = '';

      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLine += line.slice(5).trim();
        }
      }

      if (!dataLine || dataLine === '[DONE]') continue;

      try {
        yield {
          event: currentEvent,
          data: JSON.parse(dataLine)
        };
      } catch {
        // ignore malformed upstream chunk
      }
    }
  }
}

async function streamOpenAIResponse(response, res, { requestedModel, mappedModel = null, provider = null, startedAt = Date.now() }) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;
  let streamedText = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      try {
        const event = JSON.parse(payload);
        const choice = event.choices?.[0];
        const text = choice?.delta?.content;
        if (text) {
          streamedText = true;
          writeSse(res, { type: 'delta', text });
        }

        if (event.usage) {
          usage = {
            prompt_tokens: event.usage.prompt_tokens || 0,
            completion_tokens: event.usage.completion_tokens || 0,
            total_tokens: event.usage.total_tokens
              || ((event.usage.prompt_tokens || 0) + (event.usage.completion_tokens || 0))
          };
        }
      } catch {
        // ignore malformed upstream chunk
      }
    }
  }

  if (provider && usage) {
    recordUsage(provider.id, {
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      model: mappedModel || requestedModel
    });
    logger.info(`[ChatUI] stream via ${provider.type}/${provider.name} | ${requestedModel} -> ${mappedModel || requestedModel} | ${Date.now() - startedAt}ms`);
  }

  if (!streamedText) {
    writeSse(res, { type: 'delta', text: '' });
  }
  writeSse(res, { type: 'done', model: requestedModel, mappedModel, usage });
  res.end();
}

export default { handleListChatSources, handleChatWithSource, handleStreamChatWithSource };
