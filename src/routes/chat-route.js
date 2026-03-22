/**
 * Chat Completions Route
 * Handles POST /v1/chat/completions (OpenAI Chat Completions API compatibility)
 * and POST /v1/messages/count_tokens (approximate token counting).
 */

import { sendMessage } from '../direct-api.js';
import { sendKiloMessage } from '../kilo-api.js';
import { resolveModelRouting } from '../model-mapper.js';
import { getCredentialsOrError, sendAuthError } from '../middleware/credentials.js';
import { handleStreamError } from '../middleware/sse.js';
import { logger } from '../utils/logger.js';
import { listAccounts } from '../account-manager.js';
import { getServerSettings } from '../server-settings.js';
import { selectKey, recordUsage, recordError, recordRateLimit, hasKeysForTypes, getKeyRateLimitInfo } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';

/**
 * POST /v1/chat/completions
 * Converts OpenAI Chat format to Anthropic internally, then routes to Codex or Kilo.
 * Always returns a non-streaming OpenAI-compatible response.
 */
export async function handleChatCompletion(req, res) {
  const startTime = Date.now();
  const body = req.body;
  const requestedModel = body.model || 'gpt-5.2';

  const { isKilo, kiloTarget, upstreamModel } = resolveModelRouting(requestedModel);

  // Kilo routing — unchanged
  if (isKilo) {
    const anthropicRequest = _buildAnthropicRequest(body, upstreamModel);
    logger.request('POST', '/v1/chat/completions', { model: upstreamModel, account: 'kilo', messages: body.messages?.length || 0 });
    try {
      const response = await sendKiloMessage(anthropicRequest, kiloTarget);
      const duration = Date.now() - startTime;
      logger.response(200, { model: upstreamModel, tokens: response.usage?.output_tokens || 0, duration });
      return res.json(_buildOpenAIResponse(response, requestedModel));
    } catch (error) {
      return handleStreamError(res, error, upstreamModel, startTime);
    }
  }

  const settings = getServerSettings();
  const priority = settings.routingPriority || 'account-first';
  const hasAccounts = listAccounts().total > 0;
  // Try openai, azure-openai, gemini, vertex-ai keys for chat completions
  const chatKeyTypes = ['openai', 'azure-openai', 'gemini', 'vertex-ai'];
  const hasApiKeys = hasKeysForTypes(chatKeyTypes);

  if (priority === 'apikey-first' && hasApiKeys) {
    const result = await _handleChatViaApiKey(res, body, requestedModel, chatKeyTypes, startTime);
    if (result !== false) return;
    if (hasAccounts) return _handleChatViaAccountPool(res, body, requestedModel, upstreamModel, startTime);
    return sendAuthError(res, 'No available API keys or accounts');
  }

  // account-first (default)
  if (hasAccounts) {
    const result = await _handleChatViaAccountPool(res, body, requestedModel, upstreamModel, startTime);
    if (result !== false) return;
  }
  if (hasApiKeys) {
    const result = await _handleChatViaApiKey(res, body, requestedModel, chatKeyTypes, startTime);
    if (result !== false) return;
  }

  if (!hasAccounts && !hasApiKeys) {
    return sendAuthError(res, 'No accounts or API keys configured. Add them in the dashboard.');
  }
  // Check if all API keys are rate-limited
  const rlInfo = getKeyRateLimitInfo(chatKeyTypes);
  if (rlInfo.allRateLimited) {
    const waitSec = Math.ceil(rlInfo.minWaitMs / 1000);
    return res.status(429).json({ error: { message: `All API keys are rate-limited. Try again in ${waitSec}s.`, type: 'rate_limit_error' } });
  }
  return res.status(503).json({ error: { message: 'All accounts and API keys exhausted. Try again later.', type: 'service_unavailable' } });
}

/**
 * Handle chat completion via API key pool.
 */
async function _handleChatViaApiKey(res, body, requestedModel, keyTypes, startTime) {
  const MAX_KEY_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
    for (const type of keyTypes) {
      const provider = selectKey(type);
      if (!provider) continue;

      try {
        const response = await provider.sendRequest(body);
        const durationMs = Date.now() - startTime;

        if (response.status === 429) {
          const retryAfter = response.headers?.get?.('retry-after');
          recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
          logger.warn(`[Chat] API key rate limited: ${provider.name} (${type})`);
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          recordError(provider.id);
          continue;
        }

        const responseBody = await response.text();
        if (!response.ok) {
          recordError(provider.id);
          recordRequest({ provider: type, keyId: provider.id, model: body.model, durationMs, success: false, error: responseBody.slice(0, 200) });
          res.status(response.status).type('json').send(responseBody);
          return;
        }

        let inputTokens = 0, outputTokens = 0;
        try {
          const parsed = JSON.parse(responseBody);
          inputTokens = parsed.usage?.prompt_tokens || 0;
          outputTokens = parsed.usage?.completion_tokens || 0;
        } catch { /* ignore */ }

        const cost = provider.estimateCost(body.model, inputTokens, outputTokens);
        recordUsage(provider.id, { inputTokens, outputTokens, model: body.model });
        recordRequest({ provider: type, keyId: provider.id, model: body.model, inputTokens, outputTokens, cost, durationMs, success: true });
        logger.info(`[Chat] OK via API key | ${type}/${provider.name} | model=${body.model} | ${inputTokens}+${outputTokens} tokens | $${cost.toFixed(4)} | ${durationMs}ms`);
        res.status(200).type('json').send(responseBody);
        return;
      } catch (error) {
        recordError(provider.id);
        recordRequest({ provider: type, keyId: provider.id, model: body.model, durationMs: Date.now() - startTime, success: false, error: error.message });
        logger.error(`[Chat] API key error: ${provider.name} - ${error.message}`);
        continue;
      }
    }
  }
  return false;
}

/**
 * Handle chat completion via ChatGPT account pool (original logic).
 */
async function _handleChatViaAccountPool(res, body, requestedModel, upstreamModel, startTime) {
  const creds = await getCredentialsOrError();
  if (!creds) {
    return false;
  }

  const anthropicRequest = _buildAnthropicRequest(body, upstreamModel);
  logger.request('POST', '/v1/chat/completions', { model: upstreamModel, account: creds.email, messages: body.messages?.length || 0, tools: body.tools?.length || 0 });

  try {
    const response = await sendMessage(anthropicRequest, creds.accessToken, creds.accountId);
    const duration = Date.now() - startTime;
    logger.response(200, { model: upstreamModel, tokens: response.usage?.output_tokens || 0, duration });
    res.json(_buildOpenAIResponse(response, requestedModel));
    return;
  } catch (error) {
    handleStreamError(res, error, upstreamModel, startTime);
    return;
  }
}

/**
 * POST /v1/messages/count_tokens
 * Returns an approximate token count for the given request body.
 */
export function handleCountTokens(req, res) {
  const body = req.body;
  let text = '';

  if (body.system) {
    if (typeof body.system === 'string') {
      text += body.system + ' ';
    } else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block.type === 'text') text += block.text + ' ';
      }
    }
  }

  if (body.tools) {
    for (const tool of body.tools) {
      text += JSON.stringify(tool) + ' ';
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') {
        text += msg.content + ' ';
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            text += block.text + ' ';
          } else if (block.type === 'tool_use' || block.type === 'tool_result') {
            text += JSON.stringify(block) + ' ';
          }
        }
      }
    }
  }

  const approxTokens = Math.ceil(text.length / 4);
  res.json({ input_tokens: approxTokens });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts an OpenAI Chat Completions request body into an Anthropic-style request.
 * @param {object} body
 * @param {string} upstreamModel
 * @returns {object}
 */
function _buildAnthropicRequest(body, upstreamModel) {
  const anthropicRequest = {
    model: upstreamModel,
    messages: [],
    system: null,
    stream: false
  };

  if (body.messages) {
    const systemMsg = body.messages.find(m => m.role === 'system');
    if (systemMsg) {
      anthropicRequest.system = systemMsg.content;
    }

    anthropicRequest.messages = body.messages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (m.role === 'tool') {
          return {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: m.tool_call_id,
              content: m.content
            }]
          };
        }

        if (m.role === 'assistant' && m.tool_calls) {
          const content = [{ type: 'text', text: m.content || '' }];
          for (const call of m.tool_calls) {
            let input = {};
            try {
              input = typeof call.function.arguments === 'string'
                ? JSON.parse(call.function.arguments)
                : call.function.arguments || {};
            } catch {
              input = {};
            }
            content.push({
              type: 'tool_use',
              id: call.id,
              name: call.function.name,
              input
            });
          }
          return { role: 'assistant', content };
        }

        return m;
      });
  }

  if (body.tools) {
    anthropicRequest.tools = body.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));
  }

  return anthropicRequest;
}

/**
 * Converts an Anthropic-style response into an OpenAI Chat Completions response.
 * @param {object} response
 * @param {string} responseModel
 * @returns {object}
 */
function _buildOpenAIResponse(response, responseModel) {
  const content = response.content || [];
  const textContent = content.find(c => c.type === 'text');
  const toolUses = content.filter(c => c.type === 'tool_use');

  const message = {
    role: 'assistant',
    content: textContent?.text || ''
  };

  if (toolUses.length > 0) {
    message.tool_calls = toolUses.map(t => ({
      id: t.id,
      type: 'function',
      function: {
        name: t.name,
        arguments: JSON.stringify(t.input)
      }
    }));
  }

  return {
    id: response.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: responseModel,
    choices: [{
      index: 0,
      message,
      finish_reason: toolUses.length > 0 ? 'tool_calls' : 'stop'
    }],
    usage: {
      prompt_tokens: response.usage?.input_tokens || 0,
      completion_tokens: response.usage?.output_tokens || 0,
      total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
    }
  };
}

export default { handleChatCompletion, handleCountTokens };
