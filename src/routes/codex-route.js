/**
 * Codex Passthrough Route
 * Handles POST /backend-api/codex/responses
 *
 * Proxies requests from Codex CLI directly to ChatGPT's backend API
 * with multi-account rotation. No format conversion is needed because
 * Codex CLI already speaks the OpenAI Responses API format natively.
 */

import { AccountRotator } from '../account-rotation/index.js';
import { listAccounts, getActiveAccount, save } from '../account-manager.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { logger } from '../utils/logger.js';
import { getServerSettings } from '../server-settings.js';
import { fetchModels } from '../model-api.js';
import { selectKey, recordUsage, recordError, recordRateLimit, hasKeysForTypes, getKeyRateLimitInfo } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';
import { sendResponsesSSE } from '../utils/responses-sse.js';
import { resolveModel } from '../model-mapping.js';

const UPSTREAM_BASE = 'https://chatgpt.com/backend-api';
const MAX_RETRIES = 5;
const MAX_WAIT_BEFORE_ERROR_MS = 120000;
const SHORT_RATE_LIMIT_THRESHOLD_MS = 5000;

let accountRotator = null;
let currentStrategy = null;

function getAccountRotator() {
    const settings = getServerSettings();
    const strategy = settings.accountStrategy || 'sticky';

    if (!accountRotator || currentStrategy !== strategy) {
        accountRotator = new AccountRotator({
            listAccounts,
            save,
            getActiveAccount
        }, strategy);
        currentStrategy = strategy;
        logger.info(`[Codex] Account strategy: ${strategy}`);
    }
    return accountRotator;
}

function parseResetTime(response, errorText) {
    const retryAfter = response.headers?.get?.('retry-after');
    if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) return seconds * 1000;
    }

    const ratelimitReset = response.headers?.get?.('x-ratelimit-reset');
    if (ratelimitReset) {
        const timestamp = parseInt(ratelimitReset, 10) * 1000;
        const wait = timestamp - Date.now();
        if (wait > 0) return wait;
    }

    if (errorText) {
        const delayMatch = errorText.match(/quotaResetDelay[:\s"]+(\d+(?:\.\d+)?)(ms|s)/i);
        if (delayMatch) {
            const value = parseFloat(delayMatch[1]);
            return delayMatch[2] === 's' ? value * 1000 : value;
        }

        const secMatch = errorText.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|s\b)/i);
        if (secMatch) {
            return parseInt(secMatch[1], 10) * 1000;
        }
    }

    return 60000;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST /backend-api/codex/responses
 * Transparent proxy with account rotation for Codex CLI.
 * Falls back to API key pool when no accounts are available.
 */
export async function handleCodexResponses(req, res) {
    const startTime = Date.now();
    const body = req.body;
    const modelId = body.model || 'gpt-5.2';
    const isStreaming = body.stream !== false;

    // --- Request logging ---
    const inputSummary = Array.isArray(body.input)
        ? body.input.map(item => {
            if (item.type === 'message') {
                const text = typeof item.content === 'string'
                    ? item.content
                    : Array.isArray(item.content)
                        ? item.content.map(c => c.text || c.type).join(', ')
                        : JSON.stringify(item.content);
                return `[${item.role}] ${text.slice(0, 120)}${text.length > 120 ? '...' : ''}`;
            }
            if (item.type === 'function_call') return `[tool_call] ${item.name}(...)`;
            if (item.type === 'function_call_output') return `[tool_result] ${(item.output || '').slice(0, 80)}...`;
            return `[${item.type}]`;
        })
        : [];
    const toolNames = Array.isArray(body.tools) ? body.tools.map(t => t.name || t.function?.name).filter(Boolean) : [];

    console.log('\n' + '='.repeat(70));
    console.log(`[Codex Proxy] >>> REQUEST RECEIVED`);
    console.log(`  Model:     ${modelId}`);
    console.log(`  Stream:    ${isStreaming}`);
    console.log(`  Tools:     ${toolNames.length > 0 ? toolNames.join(', ') : '(none)'}`);
    if (body.instructions) {
        console.log(`  System:    ${body.instructions.slice(0, 150)}${body.instructions.length > 150 ? '...' : ''}`);
    }
    console.log(`  Messages (${inputSummary.length}):`);
    for (const line of inputSummary.slice(-5)) {
        console.log(`    ${line}`);
    }
    if (inputSummary.length > 5) {
        console.log(`    ... (${inputSummary.length - 5} earlier messages omitted)`);
    }
    console.log('='.repeat(70));

    const settings = getServerSettings();
    const priority = settings.routingPriority || 'account-first';
    const hasAccounts = listAccounts().total > 0;
    const apiKeyTypes = ['openai', 'azure-openai', 'gemini', 'vertex-ai'];
    const hasApiKeys = hasKeysForTypes(apiKeyTypes);

    if (priority === 'apikey-first' && hasApiKeys) {
        const result = await _handleCodexViaApiKey(res, body, modelId, isStreaming, apiKeyTypes, startTime);
        if (result !== false) return;
        if (hasAccounts) {
            const poolResult = await _handleCodexViaAccountPool(res, body, modelId, isStreaming, startTime);
            if (poolResult !== false) return;
        }
        return sendCodexError(res, 503, 'All API keys and accounts exhausted.');
    }

    // account-first (default)
    if (hasAccounts) {
        const poolResult = await _handleCodexViaAccountPool(res, body, modelId, isStreaming, startTime);
        if (poolResult !== false) return;
    }
    if (hasApiKeys) {
        const result = await _handleCodexViaApiKey(res, body, modelId, isStreaming, apiKeyTypes, startTime);
        if (result !== false) return;
    }

    if (!hasAccounts && !hasApiKeys) {
        return sendCodexError(res, 401, 'No accounts or API keys configured. Add them in the dashboard.');
    }
    const rlInfo = getKeyRateLimitInfo(apiKeyTypes);
    if (rlInfo.allRateLimited) {
        const waitSec = Math.ceil(rlInfo.minWaitMs / 1000);
        return sendCodexError(res, 429, `All API keys are rate-limited. Try again in ${waitSec}s.`);
    }
    return sendCodexError(res, 503, 'All accounts and API keys exhausted.');
}

// ─── Codex Responses API ↔ Chat Completions format converters ─────────────────

function _codexToChatBody(body) {
    const messages = [];

    if (body.instructions) {
        messages.push({ role: 'system', content: body.instructions });
    }

    if (Array.isArray(body.input)) {
        // Build call_id → function name lookup for tool result messages
        const callIdToName = {};
        for (const item of body.input) {
            if (item.type === 'function_call' && item.name) {
                callIdToName[item.call_id || item.id || ''] = item.name;
            }
        }

        for (const item of body.input) {
            if (item.type === 'message') {
                const role = item.role === 'developer' ? 'system' : item.role;
                let content = '';
                if (typeof item.content === 'string') {
                    content = item.content;
                } else if (Array.isArray(item.content)) {
                    content = item.content.map(c => c.text || '').join('\n');
                }
                messages.push({ role, content });
            } else if (item.type === 'function_call') {
                messages.push({
                    role: 'assistant',
                    content: '',
                    tool_calls: [{
                        id: item.call_id || item.id || `call_${Date.now()}`,
                        type: 'function',
                        function: { name: item.name, arguments: item.arguments || '{}' }
                    }]
                });
            } else if (item.type === 'function_call_output') {
                const callId = item.call_id || item.id || '';
                messages.push({
                    role: 'tool',
                    tool_call_id: callId,
                    name: callIdToName[callId] || 'unknown',
                    content: item.output || ''
                });
            }
        }
    } else if (typeof body.input === 'string') {
        messages.push({ role: 'user', content: body.input });
    }

    const chatBody = {
        model: body.model || 'gpt-4o',
        messages,
        stream: false
    };

    if (body.max_output_tokens) chatBody.max_tokens = body.max_output_tokens;
    if (body.temperature !== undefined) chatBody.temperature = body.temperature;

    if (Array.isArray(body.tools) && body.tools.length > 0) {
        chatBody.tools = body.tools
            .filter(t => t.type === 'function')
            .map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description || '',
                    parameters: t.parameters || { type: 'object', properties: {} }
                }
            }));
    }

    return chatBody;
}

function _chatToCodexResponse(chatResponse, model) {
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

    if (msg.tool_calls) {
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

/**
 * Handle /backend-api/codex/responses via API key pool (with format conversion).
 */
async function _handleCodexViaApiKey(res, body, modelId, isStreaming, keyTypes, startTime) {
    const chatBody = _codexToChatBody(body);
    const MAX_KEY_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
        for (const type of keyTypes) {
            const provider = selectKey(type);
            if (!provider) continue;

            try {
                // Map model name to provider-native model
                const mappedModel = resolveModel(type, modelId);
                const mappedBody = { ...chatBody, model: mappedModel };
                console.log(`[Codex Proxy] >>> API KEY fallback | ${type}/${provider.name} | ${modelId}→${mappedModel}`);

                const response = await provider.sendRequest(mappedBody);
                const durationMs = Date.now() - startTime;

                if (response.status === 429) {
                    const retryAfter = response.headers?.get?.('retry-after');
                    recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
                    logger.warn(`[Codex] API key rate limited: ${provider.name} (${type})`);
                    continue;
                }
                if (response.status === 401 || response.status === 403) {
                    recordError(provider.id);
                    continue;
                }

                const responseBody = await response.text();
                if (!response.ok) {
                    recordError(provider.id);
                    recordRequest({ provider: type, keyId: provider.id, model: mappedModel, durationMs, success: false, error: responseBody.slice(0, 200) });
                    logger.warn(`[Codex] API key error ${response.status}: ${provider.name} - ${responseBody.slice(0, 200)}`);
                    continue;
                }

                let chatResponse;
                try { chatResponse = JSON.parse(responseBody); } catch {
                    res.status(200).type('json').send(responseBody);
                    return;
                }

                const inputTokens = chatResponse.usage?.prompt_tokens || 0;
                const outputTokens = chatResponse.usage?.completion_tokens || 0;
                const cost = provider.estimateCost(mappedModel, inputTokens, outputTokens);
                recordUsage(provider.id, { inputTokens, outputTokens, model: mappedModel });
                recordRequest({ provider: type, keyId: provider.id, model: mappedModel, inputTokens, outputTokens, cost, durationMs, success: true });

                const codexResponse = _chatToCodexResponse(chatResponse, modelId);
                console.log(`[Codex Proxy] <<< API KEY OK | ${type}/${provider.name} | ${modelId}→${mappedModel} | ${durationMs}ms`);

                if (isStreaming) {
                    sendResponsesSSE(res, codexResponse);
                } else {
                    res.json(codexResponse);
                }
                return;
            } catch (error) {
                recordError(provider.id);
                recordRequest({ provider: type, keyId: provider.id, model: modelId, durationMs: Date.now() - startTime, success: false, error: error.message });
                logger.error(`[Codex] API key error: ${provider.name} - ${error.message}`);
                continue;
            }
        }
    }
    return false;
}

/**
 * Handle /backend-api/codex/responses via ChatGPT account pool.
 * Returns false if all accounts exhausted.
 */
async function _handleCodexViaAccountPool(res, body, modelId, isStreaming, startTime) {
    const rotator = getAccountRotator();
    rotator.clearExpiredLimits();

    const maxAttempts = Math.max(MAX_RETRIES, listAccounts().total);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (rotator.isAllRateLimited(modelId)) {
            const minWait = rotator.getMinWaitTimeMs(modelId);
            if (minWait > MAX_WAIT_BEFORE_ERROR_MS) {
                return false; // Let caller try API keys
            }
            logger.info(`[Codex] All accounts rate-limited, waiting ${Math.round(minWait / 1000)}s...`);
            await sleep(minWait + 500);
            rotator.clearExpiredLimits();
            attempt--;
            continue;
        }

        const { account, waitMs } = rotator.selectAccount(modelId);
        if (!account) {
            if (waitMs > 0) { await sleep(waitMs); attempt--; continue; }
            return false; // No accounts available
        }

        const creds = await getCredentialsForAccount(account.email);
        if (!creds) {
            rotator.markInvalid(account.email, 'Failed to get credentials');
            continue;
        }

        console.log(`[Codex Proxy] >>> FORWARDING to ChatGPT | account=${creds.email} | model=${modelId} | attempt=${attempt + 1}`);

        try {
            const upstreamResponse = await fetch(`${UPSTREAM_BASE}/codex/responses`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${creds.accessToken}`,
                    'ChatGPT-Account-ID': creds.accountId,
                    'Content-Type': 'application/json',
                    'Accept': isStreaming ? 'text/event-stream' : 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!upstreamResponse.ok) {
                const errorText = await upstreamResponse.text();

                if (upstreamResponse.status === 401) {
                    rotator.markInvalid(creds.email, 'Token expired or revoked');
                    rotator.notifyFailure(account, modelId);
                    logger.warn(`[Codex] Auth expired for ${creds.email}, trying next...`);
                    continue;
                }

                if (upstreamResponse.status === 429) {
                    const resetMs = parseResetTime(upstreamResponse, errorText);
                    rotator.markRateLimited(creds.email, resetMs, modelId);
                    rotator.notifyRateLimit(account, modelId);

                    if (resetMs <= SHORT_RATE_LIMIT_THRESHOLD_MS) {
                        logger.info(`[Codex] Short rate limit on ${creds.email}, waiting ${resetMs}ms...`);
                        await sleep(resetMs);
                        attempt--;
                        continue;
                    }

                    logger.info(`[Codex] Rate limited on ${creds.email} (${Math.round(resetMs / 1000)}s), switching account...`);
                    continue;
                }

                logger.error(`[Codex] Upstream error ${upstreamResponse.status}: ${errorText.slice(0, 200)}`);
                return res.status(upstreamResponse.status)
                    .set('Content-Type', 'application/json')
                    .send(errorText);
            }

            // Success
            rotator.notifySuccess(account, modelId);

            if (isStreaming) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                const reader = upstreamResponse.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(value);
                    }
                } catch (streamErr) {
                    logger.error(`[Codex] Stream error: ${streamErr.message}`);
                } finally {
                    res.end();
                }
            } else {
                const responseBody = await upstreamResponse.text();
                res.setHeader('Content-Type', 'application/json');
                res.send(responseBody);
            }

            const duration = Date.now() - startTime;
            console.log(`[Codex Proxy] <<< RESPONSE OK | account=${creds.email} | model=${modelId} | ${duration}ms`);
            return;
        } catch (error) {
            logger.error(`[Codex] Network error on ${creds.email}: ${error.message}`);
            rotator.notifyFailure(account, modelId);
            continue;
        }
    }

    return false;
}

/**
 * GET /backend-api/codex/models
 * Proxies model listing with account rotation.
 * Falls back to a synthetic model list when only API keys are available.
 */
export async function handleCodexModels(req, res) {
    const creds = await _getAnyCreds();

    if (!creds) {
        // No accounts — check for API keys and return a synthetic model list
        const apiKeyTypes = ['openai', 'azure-openai', 'gemini', 'vertex-ai'];
        const hasApiKeys = apiKeyTypes.some(t => !!selectKey(t));
        if (hasApiKeys) {
            return res.json({
                models: [
                    { slug: 'gpt-4o', name: 'GPT-4o (via API key)', tags: ['gpt4'] },
                    { slug: 'gpt-4o-mini', name: 'GPT-4o Mini (via API key)', tags: ['gpt4'] },
                    { slug: 'gpt-5.2', name: 'GPT-5.2 (via API key)', tags: ['gpt5'] },
                ]
            });
        }
        return sendCodexError(res, 401, 'No available accounts or API keys');
    }

    const clientVersion = req.query.client_version || '0.116.0';
    const url = `${UPSTREAM_BASE}/codex/models?client_version=${clientVersion}`;

    try {
        const upstreamResponse = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${creds.accessToken}`,
                'ChatGPT-Account-ID': creds.accountId,
                'Accept': 'application/json'
            }
        });

        if (!upstreamResponse.ok) {
            const errorText = await upstreamResponse.text();
            logger.error(`[Codex] Models fetch failed: ${upstreamResponse.status}`);
            return res.status(upstreamResponse.status)
                .set('Content-Type', 'application/json')
                .send(errorText);
        }

        const responseBody = await upstreamResponse.text();
        res.setHeader('Content-Type', 'application/json');
        res.send(responseBody);
    } catch (error) {
        logger.error(`[Codex] Models fetch error: ${error.message}`);
        return sendCodexError(res, 502, `Failed to fetch models: ${error.message}`);
    }
}

/**
 * Catch-all proxy for other /backend-api/* requests Codex may send.
 * Forwards to upstream with pool credentials.
 */
export async function handleCodexCatchAll(req, res) {
    const creds = await _getAnyCreds();

    if (!creds) {
        return sendCodexError(res, 401, 'No available accounts');
    }

    const upstreamPath = req.originalUrl; // preserves query string
    const url = `https://chatgpt.com${upstreamPath}`;

    logger.info(`[Codex] Proxy ${req.method} ${upstreamPath} via ${creds.email}`);

    try {
        const headers = {
            'Authorization': `Bearer ${creds.accessToken}`,
            'ChatGPT-Account-ID': creds.accountId,
            'Accept': req.headers.accept || 'application/json'
        };

        const fetchOpts = { method: req.method, headers };

        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            headers['Content-Type'] = 'application/json';
            fetchOpts.body = JSON.stringify(req.body);
        }

        const upstreamResponse = await fetch(url, fetchOpts);
        const responseBody = await upstreamResponse.text();

        // Forward status + headers
        res.status(upstreamResponse.status);
        const ct = upstreamResponse.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);
        res.send(responseBody);
    } catch (error) {
        logger.error(`[Codex] Proxy error: ${error.message}`);
        return sendCodexError(res, 502, `Proxy error: ${error.message}`);
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function _getAnyCreds() {
    const rotator = getAccountRotator();
    const { account } = rotator.selectAccount('default');
    if (account) {
        return getCredentialsForAccount(account.email);
    }
    return null;
}

function sendCodexError(res, status, message) {
    return res.status(status).json({
        error: { message, type: 'proxy_error', code: status }
    });
}

export default { handleCodexResponses, handleCodexModels, handleCodexCatchAll };
