/**
 * Gateway Route
 * Unified API gateway that routes requests to the appropriate provider.
 * Handles load balancing, retries, rate limit detection, and usage tracking.
 *
 * POST /api/gateway/chat     — OpenAI-compatible chat completions via API keys
 * POST /api/gateway/messages  — Anthropic-compatible messages via API keys
 */

import { selectKey, recordUsage, recordError, recordRateLimit } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';
import { logger } from '../utils/logger.js';
import { logRequest } from '../request-logger.js';

const MAX_RETRIES = 3;

/**
 * POST /api/gateway/chat
 * OpenAI-compatible chat completions through provider API keys.
 * Supports: openai, gemini (auto-translated)
 */
export async function handleGatewayChat(req, res) {
    const body = req.body;
    const preferredType = req.query.provider || null; // optional: force a provider

    // Try providers in order of preference
    const typesToTry = preferredType
        ? [preferredType]
        : ['openai', 'azure-openai', 'gemini', 'vertex-ai', 'minimax', 'moonshot', 'zhipu'];

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        for (const type of typesToTry) {
            const provider = selectKey(type);
            if (!provider) continue;

            const startTime = Date.now();
            try {
                const response = await provider.sendRequest(body);
                const durationMs = Date.now() - startTime;

                if (response.status === 429) {
                    const retryAfter = response.headers?.get?.('retry-after');
                    const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : 60000;
                    recordRateLimit(provider.id, waitMs);
                    logger.warn(`[Gateway] Rate limited: ${provider.name} (${type}), waiting ${Math.round(waitMs / 1000)}s`);
                    continue;
                }

                if (response.status === 401 || response.status === 403) {
                    recordError(provider.id);
                    logger.error(`[Gateway] Auth failed: ${provider.name} (${type})`);
                    continue;
                }

                if (!response.ok) {
                    const errorText = await response.text();
                    recordError(provider.id);
                    recordRequest({
                        provider: type, keyId: provider.id, model: body.model,
                        durationMs, success: false, error: errorText.slice(0, 200)
                    });
                    return res.status(response.status).type('json').send(errorText);
                }

                // Success — extract usage from response
                const responseBody = await response.text();
                let inputTokens = 0, outputTokens = 0;
                try {
                    const parsed = JSON.parse(responseBody);
                    inputTokens = parsed.usage?.prompt_tokens || 0;
                    outputTokens = parsed.usage?.completion_tokens || 0;
                } catch { /* ignore parse errors */ }

                const cost = provider.estimateCost(body.model, inputTokens, outputTokens);
                recordUsage(provider.id, { inputTokens, outputTokens, model: body.model });
                recordRequest({
                    provider: type, keyId: provider.id, model: body.model,
                    inputTokens, outputTokens, cost, durationMs, success: true
                });
                logRequest({ route: '/api/gateway/chat', provider: type, keyId: provider.id, model: body.model, requestBody: body, responseBody, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });

                logger.info(`[Gateway] OK | ${type}/${provider.name} | model=${body.model} | ${inputTokens}+${outputTokens} tokens | $${cost.toFixed(4)} | ${durationMs}ms`);
                return res.status(200).type('json').send(responseBody);

            } catch (error) {
                recordError(provider.id);
                recordRequest({
                    provider: type, keyId: provider.id, model: body.model,
                    durationMs: Date.now() - startTime, success: false, error: error.message
                });
                logger.error(`[Gateway] Network error: ${provider.name} - ${error.message}`);
                continue;
            }
        }
    }

    return res.status(503).json({
        error: { message: 'No available API keys. Add keys in the dashboard or check rate limits.' }
    });
}

/**
 * POST /api/gateway/messages
 * Anthropic-compatible messages through Anthropic API keys.
 */
export async function handleGatewayMessages(req, res) {
    const body = req.body;
    const provider = selectKey('anthropic');

    if (!provider) {
        return res.status(503).json({
            error: { message: 'No available Anthropic API keys.' }
        });
    }

    const startTime = Date.now();
    try {
        const response = await provider.sendRequest(body);
        const durationMs = Date.now() - startTime;

        if (response.status === 429) {
            const retryAfter = response.headers?.get?.('retry-after');
            recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
            // Try next key
            const fallback = selectKey('anthropic');
            if (fallback && fallback.id !== provider.id) {
                const fbResponse = await fallback.sendRequest(body);
                const fbBody = await fbResponse.text();
                return res.status(fbResponse.status).type('json').send(fbBody);
            }
            const errorText = await response.text();
            return res.status(429).type('json').send(errorText);
        }

        const responseBody = await response.text();

        if (!response.ok) {
            recordError(provider.id);
            recordRequest({
                provider: 'anthropic', keyId: provider.id, model: body.model,
                durationMs, success: false, error: responseBody.slice(0, 200)
            });
            return res.status(response.status).type('json').send(responseBody);
        }

        let inputTokens = 0, outputTokens = 0;
        try {
            const parsed = JSON.parse(responseBody);
            inputTokens = parsed.usage?.input_tokens || 0;
            outputTokens = parsed.usage?.output_tokens || 0;
        } catch { /* ignore */ }

        const cost = provider.estimateCost(body.model, inputTokens, outputTokens);
        recordUsage(provider.id, { inputTokens, outputTokens, model: body.model });
        recordRequest({
            provider: 'anthropic', keyId: provider.id, model: body.model,
            inputTokens, outputTokens, cost, durationMs, success: true
        });
        logRequest({ route: '/api/gateway/messages', provider: 'anthropic', keyId: provider.id, model: body.model, requestBody: body, responseBody, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });

        logger.info(`[Gateway] OK | anthropic/${provider.name} | model=${body.model} | ${inputTokens}+${outputTokens} tokens | $${cost.toFixed(4)} | ${durationMs}ms`);
        return res.status(200).type('json').send(responseBody);

    } catch (error) {
        recordError(provider.id);
        recordRequest({
            provider: 'anthropic', keyId: provider.id, model: body.model,
            durationMs: Date.now() - startTime, success: false, error: error.message
        });
        logger.error(`[Gateway] Network error: ${provider.name} - ${error.message}`);
        return res.status(502).json({ error: { message: `Gateway error: ${error.message}` } });
    }
}

/**
 * GET /api/gateway/providers
 * List available provider types and their pricing info.
 */
export function handleListProviders(req, res) {
    res.json({
        providers: [
            { type: 'openai', name: 'OpenAI' },
            { type: 'anthropic', name: 'Anthropic' },
            { type: 'gemini', name: 'Google Gemini' },
            { type: 'azure-openai', name: 'Azure OpenAI' },
            { type: 'vertex-ai', name: 'Vertex AI' },
            { type: 'minimax', name: 'MiniMax' },
            { type: 'moonshot', name: 'Moonshot (Kimi)' },
            { type: 'zhipu', name: 'ZhipuAI (GLM)' }
        ]
    });
}
