import { listAccounts } from '../account-manager.js';
import {
  loadAccounts as loadClaudeAccounts,
  refreshAccountToken as refreshClaudeAccountToken,
  getAccount as getClaudeAccount
} from '../claude-account-manager.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { sendMessage } from '../direct-api.js';
import { sendClaudeMessage, mapToClaudeModel } from '../claude-api.js';
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
        response = await sendClaudeMessage(buildAnthropicRequest({
          model: upstreamModel,
          messages,
          temperature
        }), account.accessToken);
      } catch (error) {
        if (!error.message?.startsWith('AUTH_EXPIRED')) {
          throw error;
        }

        const refreshResult = await refreshClaudeAccountToken(email);
        if (!refreshResult.success) {
          throw error;
        }

        account = getClaudeAccount(email) || account;
        response = await sendClaudeMessage(buildAnthropicRequest({
          model: upstreamModel,
          messages,
          temperature
        }), account.accessToken);
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

function buildOpenAIChatRequest({ model, messages, temperature }) {
  const body = {
    model,
    messages: sanitizeOpenAIMessages(messages)
  };

  if (typeof temperature === 'number') {
    body.temperature = temperature;
  }

  return body;
}

function buildAnthropicRequest({ model, messages, temperature }) {
  const body = {
    model,
    messages: [],
    stream: false
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

export default { handleListChatSources, handleChatWithSource };
