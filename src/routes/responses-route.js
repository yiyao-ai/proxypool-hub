/**
 * OpenAI Responses API Route
 * Handles POST /responses and /v1/responses
 *
 * Codex CLI sends requests with zstd compression to {openai_base_url}/responses.
 * This handler bypasses express.json() entirely and forwards the raw request
 * bytes to ChatGPT's backend, swapping only the auth credentials for pool rotation.
 */

import { AccountRotator } from '../account-rotation/index.js';
import { listAccounts, getActiveAccount, save } from '../account-manager.js';
import { loadAccounts as loadClaudeAccounts, refreshAccountToken, getAccount as getClaudeAccount } from '../claude-account-manager.js';
import { sendClaudeMessage, mapToClaudeModel } from '../claude-api.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { logger } from '../utils/logger.js';
import { getServerSettings } from '../server-settings.js';
import { selectKey, recordUsage, recordError, recordRateLimit, hasKeysForTypes, getKeyRateLimitInfo } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';
import zlib from 'zlib';
import { decompress as fzstdDecompress } from 'fzstd';
import { sendResponsesSSE } from '../utils/responses-sse.js';
import { resolveModel } from '../model-mapping.js';
import { logRequest } from '../request-logger.js';

const UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses';
const MAX_RETRIES = 5;
const MAX_WAIT_BEFORE_ERROR_MS = 120000;
const SHORT_RATE_LIMIT_THRESHOLD_MS = 5000;

let accountRotator = null;
let currentStrategy = null;

function getAccountRotator() {
    const settings = getServerSettings();
    const strategy = settings.accountStrategy || 'sticky';

    if (!accountRotator || currentStrategy !== strategy) {
        const accts = listAccounts();
        logger.info(`[Codex Proxy] Initializing rotator: strategy=${strategy}, accounts=${accts.total}, active=${accts.active || 'none'}`);
        accountRotator = new AccountRotator({
            listAccounts,
            save,
            getActiveAccount
        }, strategy);
        currentStrategy = strategy;
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
        if (secMatch) return parseInt(secMatch[1], 10) * 1000;
    }
    return 60000;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Collect raw request body as a Buffer (bypasses express.json).
 */
function collectRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/**
 * Best-effort: decompress and parse JSON body to extract model name.
 * Returns model string or default.
 */
/**
 * Decompress zstd data using Node.js native zlib (22+) or fzstd fallback.
 */
function decompressZstd(buf) {
    if (typeof zlib.zstdDecompressSync === 'function') {
        return zlib.zstdDecompressSync(buf);
    }
    // fzstd returns Uint8Array, convert to Buffer
    return Buffer.from(fzstdDecompress(buf));
}

function tryExtractModel(rawBody, contentEncoding) {
    try {
        let jsonBuf = rawBody;

        if (contentEncoding === 'zstd') {
            jsonBuf = decompressZstd(rawBody);
        } else if (contentEncoding === 'gzip') {
            jsonBuf = zlib.gunzipSync(rawBody);
        } else if (contentEncoding === 'deflate') {
            jsonBuf = zlib.inflateSync(rawBody);
        } else if (contentEncoding === 'br') {
            jsonBuf = zlib.brotliDecompressSync(rawBody);
        }

        const parsed = JSON.parse(jsonBuf.toString('utf8'));
        return parsed.model || 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * Best-effort: extract message summary for logging.
 */
function tryExtractSummary(rawBody, contentEncoding) {
    try {
        let jsonBuf = rawBody;

        if (contentEncoding === 'zstd') {
            jsonBuf = decompressZstd(rawBody);
        } else if (contentEncoding === 'gzip') {
            jsonBuf = zlib.gunzipSync(rawBody);
        } else if (contentEncoding === 'br') {
            jsonBuf = zlib.brotliDecompressSync(rawBody);
        } else if (contentEncoding && contentEncoding !== 'identity') {
            return null;
        }

        return JSON.parse(jsonBuf.toString('utf8'));
    } catch {
        return null;
    }
}

/**
 * POST /responses (and /v1/responses)
 * Raw passthrough proxy with account rotation.
 */
export async function handleResponses(req, res) {
    const startTime = Date.now();
    const contentEncoding = req.headers['content-encoding'] || '';

    // Collect raw body (bypasses express.json)
    const rawBody = await collectRawBody(req);

    // Best-effort extract model and log info
    const modelId = tryExtractModel(rawBody, contentEncoding);
    const parsed = tryExtractSummary(rawBody, contentEncoding);

    // --- Request logging ---
    const toolNames = parsed && Array.isArray(parsed.tools) ? parsed.tools.map(t => t.name || t.function?.name).filter(Boolean) : [];
    logger.info(`[Codex] >>> /responses | model=${modelId} | ${rawBody.length}B | encoding=${contentEncoding || 'none'} | tools=${toolNames.length}`);

    const isStreaming = parsed ? parsed.stream !== false : true;

    const settings = getServerSettings();
    const priority = settings.routingPriority || 'account-first';
    const hasAccounts = listAccounts().total > 0;
    const chatKeyTypes = ['openai', 'azure-openai', 'gemini', 'vertex-ai'];
    const hasApiKeys = hasKeysForTypes(chatKeyTypes);
    const hasClaudeAccounts = _getUsableClaudeAccounts().length > 0;

    if (priority === 'apikey-first') {
        // apikey-first: API Key → ChatGPT accounts → Claude accounts
        if (hasApiKeys && parsed) {
            const result = await _handleResponsesViaApiKey(res, parsed, modelId, isStreaming, chatKeyTypes, startTime);
            if (result !== false) return;
        }
        if (hasAccounts) {
            const poolResult = await _handleResponsesViaAccountPool(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime);
            if (poolResult !== false) return;
        }
        if (hasClaudeAccounts && parsed) {
            const claudeResult = await _handleResponsesViaClaudeAccount(res, parsed, modelId, isStreaming, startTime);
            if (claudeResult !== false) return;
        }
    } else {
        // account-first (default): ChatGPT accounts → Claude accounts → API Key
        if (hasAccounts) {
            const poolResult = await _handleResponsesViaAccountPool(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime);
            if (poolResult !== false) return;
        }
        if (hasClaudeAccounts && parsed) {
            const claudeResult = await _handleResponsesViaClaudeAccount(res, parsed, modelId, isStreaming, startTime);
            if (claudeResult !== false) return;
        }
        if (hasApiKeys && parsed) {
            const result = await _handleResponsesViaApiKey(res, parsed, modelId, isStreaming, chatKeyTypes, startTime);
            if (result !== false) return;
        }
    }

    if (!hasAccounts && !hasApiKeys && !hasClaudeAccounts) {
        return res.status(401).json({ error: { message: 'No accounts or API keys configured. Add them in the dashboard.' } });
    }
    const rlInfo = getKeyRateLimitInfo(chatKeyTypes);
    if (rlInfo.allRateLimited) {
        const waitSec = Math.ceil(rlInfo.minWaitMs / 1000);
        return res.status(429).json({ error: { message: `All API keys are rate-limited. Try again in ${waitSec}s.`, retry_after: waitSec } });
    }
    return res.status(503).json({ error: { message: 'All accounts and API keys exhausted. Try again later.' } });
}

// ─── Responses API ↔ Chat Completions format converters ───────────────────────

function _responsesToChatBody(parsed) {
    const messages = [];

    // System / instructions
    if (parsed.instructions) {
        messages.push({ role: 'system', content: parsed.instructions });
    }

    // Convert input array to messages
    if (Array.isArray(parsed.input)) {
        // Build call_id → function name lookup for tool result messages
        const callIdToName = {};
        for (const item of parsed.input) {
            if (item.type === 'function_call' && item.name) {
                callIdToName[item.call_id || item.id || ''] = item.name;
            }
        }

        for (const item of parsed.input) {
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
    } else if (typeof parsed.input === 'string') {
        messages.push({ role: 'user', content: parsed.input });
    }

    const body = {
        model: parsed.model || 'gpt-4o',
        messages,
        stream: false  // Non-streaming for API key fallback
    };

    if (parsed.max_output_tokens) body.max_tokens = parsed.max_output_tokens;
    if (parsed.temperature !== undefined) body.temperature = parsed.temperature;

    // Convert tools
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        body.tools = parsed.tools
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

    return body;
}

function _chatToResponsesFormat(chatResponse, model) {
    const choice = chatResponse.choices?.[0];
    const msg = choice?.message || {};
    const output = [];

    // Text content
    if (msg.content) {
        output.push({
            type: 'message',
            id: `msg_${Date.now()}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: msg.content }]
        });
    }

    // Tool calls
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
        model: model,
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
 * Handle /responses via API key pool (with format conversion).
 */
async function _handleResponsesViaApiKey(res, parsed, modelId, isStreaming, keyTypes, startTime) {
    const chatBody = _responsesToChatBody(parsed);
    const MAX_KEY_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
        for (const type of keyTypes) {
            const provider = selectKey(type);
            if (!provider) continue;

            try {
                // Map model name to provider-native model
                const mappedModel = resolveModel(type, modelId);
                const mappedBody = { ...chatBody, model: mappedModel };
                logger.info(`[Codex] >>> API KEY | ${type}/${provider.name} | ${modelId}→${mappedModel}`);

                const response = await provider.sendRequest(mappedBody);
                const durationMs = Date.now() - startTime;

                if (response.status === 429) {
                    const retryAfter = response.headers?.get?.('retry-after');
                    recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
                    logger.warn(`[Codex Proxy] API key rate limited: ${provider.name}`);
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
                    logRequest({ route: '/responses', provider: type, keyId: provider.id, model: modelId, mappedModel, requestBody: parsed, responseBody, durationMs, status: response.status, success: false, error: responseBody.slice(0, 200) });
                    logger.warn(`[Codex Proxy] API key error ${response.status}: ${provider.name} - ${responseBody.slice(0, 200)}`);
                    continue; // Try next provider instead of returning error
                }

                // Convert chat completions response → Responses API format
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
                logRequest({ route: '/responses', provider: type, keyId: provider.id, model: modelId, mappedModel, requestBody: parsed, responseBody, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });

                const responsesFormat = _chatToResponsesFormat(chatResponse, modelId);
                logger.success(`[Codex] <<< API KEY OK | ${type}/${provider.name} | model=${modelId} | ${durationMs}ms`);

                if (isStreaming) {
                    sendResponsesSSE(res, responsesFormat);
                } else {
                    res.json(responsesFormat);
                }
                return;
            } catch (error) {
                recordError(provider.id);
                recordRequest({ provider: type, keyId: provider.id, model: modelId, durationMs: Date.now() - startTime, success: false, error: error.message });
                logger.error(`[Codex Proxy] API key error: ${provider.name} - ${error.message}`);
                continue;
            }
        }
    }
    return false;
}

/**
 * Handle /responses via ChatGPT account pool (original logic).
 * Returns false if all accounts exhausted.
 */
async function _handleResponsesViaAccountPool(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime) {
    const rotator = getAccountRotator();
    rotator.clearExpiredLimits();

    const maxAttempts = Math.max(MAX_RETRIES, listAccounts().total);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (rotator.isAllRateLimited(modelId)) {
            const minWait = rotator.getMinWaitTimeMs(modelId);
            if (minWait > MAX_WAIT_BEFORE_ERROR_MS) {
                return false; // Let caller try API keys
            }
            logger.warn(`[Codex] All accounts rate-limited, waiting ${Math.round(minWait / 1000)}s...`);
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
            logger.warn(`[Codex] Credentials failed for ${account.email}, marking invalid`);
            rotator.markInvalid(account.email, 'Failed to get credentials');
            continue;
        }

        logger.info(`[Codex] >>> FORWARDING | account=${creds.email} | model=${modelId} | attempt=${attempt + 1}`);

        try {
            const upstreamHeaders = {
                'Authorization': `Bearer ${creds.accessToken}`,
                'ChatGPT-Account-ID': creds.accountId,
                'Content-Type': req.headers['content-type'] || 'application/json',
                'Accept': isStreaming ? 'text/event-stream' : 'application/json'
            };
            if (contentEncoding) {
                upstreamHeaders['Content-Encoding'] = contentEncoding;
            }

            const upstreamResponse = await fetch(UPSTREAM_URL, {
                method: 'POST',
                headers: upstreamHeaders,
                body: rawBody
            });

            if (!upstreamResponse.ok) {
                const errorText = await upstreamResponse.text();

                if (upstreamResponse.status === 401) {
                    rotator.markInvalid(creds.email, 'Token expired');
                    rotator.notifyFailure(account, modelId);
                    logger.warn(`[Codex] Auth expired for ${creds.email}, trying next...`);
                    continue;
                }

                if (upstreamResponse.status === 429) {
                    const resetMs = parseResetTime(upstreamResponse, errorText);
                    rotator.markRateLimited(creds.email, resetMs, modelId);
                    rotator.notifyRateLimit(account, modelId);

                    if (resetMs <= SHORT_RATE_LIMIT_THRESHOLD_MS) {
                        logger.warn(`[Codex] Short rate limit on ${creds.email}, waiting ${resetMs}ms...`);
                        await sleep(resetMs);
                        attempt--;
                        continue;
                    }
                    logger.warn(`[Codex] Rate limited ${creds.email} (${Math.round(resetMs / 1000)}s), switching...`);
                    continue;
                }

                logger.error(`[Codex Proxy] Upstream error ${upstreamResponse.status}: ${errorText.slice(0, 200)}`);
                recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: Date.now() - startTime, success: false, error: errorText.slice(0, 200) });
                logRequest({ route: '/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: Date.now() - startTime, status: upstreamResponse.status, success: false, error: errorText.slice(0, 200) });
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
                    logger.error(`[Codex Proxy] Stream error: ${streamErr.message}`);
                } finally {
                    res.end();
                }
            } else {
                const responseBody = await upstreamResponse.text();
                res.setHeader('Content-Type', 'application/json');
                res.send(responseBody);
            }

            const duration = Date.now() - startTime;
            recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: true });
            logRequest({ route: '/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, mappedModel: modelId, durationMs: duration, status: 200, success: true });
            logger.success(`[Codex] <<< OK | account=${creds.email} | model=${modelId} | ${duration}ms`);
            return true;
        } catch (error) {
            // If response was already sent (streaming succeeded but post-stream code failed), don't retry
            if (res.headersSent) {
                const duration = Date.now() - startTime;
                recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: true });
                logRequest({ route: '/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, status: 200, success: true });
                logger.warn(`[Codex Proxy] Post-stream error (response already sent): ${error.message}`);
                return true;
            }
            const duration = Date.now() - startTime;
            recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: false, error: error.message });
            logRequest({ route: '/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: false, error: error.message });
            logger.error(`[Codex Proxy] Network error on ${creds.email}: ${error.message}`);
            rotator.notifyFailure(account, modelId);
            continue;
        }
    }

    return false; // All retries exhausted
}

// ─── Claude Account Pool ──────────────────────────────────────────────────────

function _getUsableClaudeAccounts() {
    const data = loadClaudeAccounts();
    return data.accounts.filter(a =>
        a.enabled !== false &&
        a.accessToken &&
        !(a.expiresAt && a.expiresAt < Date.now())
    );
}

/**
 * Convert OpenAI Responses API parsed body → Anthropic Messages API body.
 */
function _responsesToAnthropicBody(parsed) {
    const messages = [];
    const pendingToolResults = [];

    if (Array.isArray(parsed.input)) {
        for (const item of parsed.input) {
            if (item.type === 'message') {
                const role = item.role === 'developer' ? 'user' : item.role;
                let content;
                if (typeof item.content === 'string') {
                    content = item.content;
                } else if (Array.isArray(item.content)) {
                    content = item.content.map(c => ({ type: 'text', text: c.text || '' }));
                } else {
                    content = '';
                }

                if (role === 'user' && pendingToolResults.length > 0) {
                    const textContent = typeof content === 'string'
                        ? [{ type: 'text', text: content }]
                        : content;
                    messages.push({ role: 'user', content: [...pendingToolResults.splice(0), ...textContent] });
                } else {
                    if (pendingToolResults.length > 0) {
                        messages.push({ role: 'user', content: pendingToolResults.splice(0) });
                    }
                    messages.push({ role, content });
                }
            } else if (item.type === 'function_call') {
                if (pendingToolResults.length > 0) {
                    messages.push({ role: 'user', content: pendingToolResults.splice(0) });
                }

                let input = {};
                try {
                    input = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments || {};
                } catch { input = {}; }

                messages.push({
                    role: 'assistant',
                    content: [{
                        type: 'tool_use',
                        id: item.call_id || item.id || `toolu_${Date.now()}`,
                        name: item.name,
                        input
                    }]
                });
            } else if (item.type === 'function_call_output') {
                pendingToolResults.push({
                    type: 'tool_result',
                    tool_use_id: item.call_id || item.id || '',
                    content: item.output || ''
                });
            }
        }

        if (pendingToolResults.length > 0) {
            messages.push({ role: 'user', content: pendingToolResults.splice(0) });
        }
    } else if (typeof parsed.input === 'string') {
        messages.push({ role: 'user', content: parsed.input });
    }

    const body = {
        model: mapToClaudeModel(parsed.model),
        messages,
        max_tokens: parsed.max_output_tokens || 8192
    };

    if (parsed.instructions) {
        body.system = parsed.instructions;
    }
    if (parsed.temperature !== undefined) {
        body.temperature = parsed.temperature;
    }

    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
        body.tools = parsed.tools
            .filter(t => t.type === 'function')
            .map(t => ({
                name: t.name,
                description: t.description || '',
                input_schema: t.parameters || { type: 'object', properties: {} }
            }));
    }

    return body;
}

/**
 * Convert Anthropic Messages API response → OpenAI Responses API format.
 */
function _anthropicToResponsesFormat(claudeResponse, originalModel) {
    const output = [];

    if (claudeResponse.content) {
        for (const block of claudeResponse.content) {
            if (block.type === 'text') {
                output.push({
                    type: 'message',
                    id: `msg_${Date.now()}`,
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: block.text }]
                });
            } else if (block.type === 'tool_use') {
                output.push({
                    type: 'function_call',
                    id: block.id,
                    call_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                });
            }
        }
    }

    return {
        id: claudeResponse.id || `resp_${Date.now()}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: originalModel,
        status: 'completed',
        output,
        usage: {
            input_tokens: claudeResponse.usage?.input_tokens || 0,
            output_tokens: claudeResponse.usage?.output_tokens || 0,
            total_tokens: (claudeResponse.usage?.input_tokens || 0) + (claudeResponse.usage?.output_tokens || 0)
        }
    };
}

/**
 * Handle /responses via Claude account pool (with format conversion).
 */
async function _handleResponsesViaClaudeAccount(res, parsed, modelId, isStreaming, startTime) {
    const accounts = _getUsableClaudeAccounts();
    const anthropicBody = _responsesToAnthropicBody(parsed);

    for (const account of accounts) {
        try {
            const mappedModel = anthropicBody.model;
            logger.info(`[Codex] >>> Claude account | ${account.email} | ${modelId}→${mappedModel}`);

            const claudeResponse = await sendClaudeMessage(anthropicBody, account.accessToken);
            const durationMs = Date.now() - startTime;

            const responsesFormat = _anthropicToResponsesFormat(claudeResponse, modelId);

            const inputTokens = claudeResponse.usage?.input_tokens || 0;
            const outputTokens = claudeResponse.usage?.output_tokens || 0;
            recordRequest({ provider: 'claude-pool', keyId: account.email, model: mappedModel, inputTokens, outputTokens, durationMs, success: true });
            logRequest({ route: '/responses', provider: 'claude-pool', keyId: account.email, model: modelId, mappedModel, requestBody: parsed, inputTokens, outputTokens, durationMs, status: 200, success: true });

            logger.success(`[Codex] <<< Claude account OK | ${account.email} | model=${modelId} | ${inputTokens}+${outputTokens} tokens | ${durationMs}ms`);

            if (isStreaming) {
                sendResponsesSSE(res, responsesFormat);
            } else {
                res.json(responsesFormat);
            }
            return true;
        } catch (error) {
            const durationMs = Date.now() - startTime;
            if (error.message.includes('AUTH_EXPIRED')) {
                logger.warn(`[Codex] Claude account auth expired: ${account.email}, attempting token refresh...`);
                try {
                    const refreshResult = await refreshAccountToken(account.email);
                    if (refreshResult.success) {
                        const refreshed = getClaudeAccount(account.email);
                        if (refreshed && refreshed.accessToken) {
                            logger.info(`[Codex] Token refreshed for ${account.email}, retrying...`);
                            const retryResponse = await sendClaudeMessage(anthropicBody, refreshed.accessToken);
                            const retryDurationMs = Date.now() - startTime;
                            const responsesFormat = _anthropicToResponsesFormat(retryResponse, modelId);
                            const inputTokens = retryResponse.usage?.input_tokens || 0;
                            const outputTokens = retryResponse.usage?.output_tokens || 0;
                            recordRequest({ provider: 'claude-pool', keyId: account.email, model: anthropicBody.model, inputTokens, outputTokens, durationMs: retryDurationMs, success: true });
                            logger.success(`[Codex] <<< Claude account OK (after refresh) | ${account.email} | model=${modelId} | ${inputTokens}+${outputTokens} tokens | ${retryDurationMs}ms`);
                            if (isStreaming) { sendResponsesSSE(res, responsesFormat); } else { res.json(responsesFormat); }
                            return true;
                        }
                    }
                    logger.warn(`[Codex] Token refresh failed for ${account.email}: ${refreshResult.message}`);
                } catch (refreshErr) {
                    logger.warn(`[Codex] Token refresh error for ${account.email}: ${refreshErr.message}`);
                }
                continue;
            }
            if (error.message.startsWith('RATE_LIMITED:')) {
                logger.warn(`[Codex] Claude account rate limited: ${account.email}`);
                continue;
            }
            recordRequest({ provider: 'claude-pool', keyId: account.email, model: modelId, durationMs, success: false, error: error.message });
            logger.error(`[Codex] Claude account error: ${account.email} - ${error.message}`);
            continue;
        }
    }

    return false;
}

export default { handleResponses };
