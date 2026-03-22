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
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { logger } from '../utils/logger.js';
import { getServerSettings } from '../server-settings.js';
import { selectKey, recordUsage, recordError, recordRateLimit, hasKeysForTypes, getKeyRateLimitInfo } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';
import zlib from 'zlib';
import { sendResponsesSSE } from '../utils/responses-sse.js';
import { resolveModel } from '../model-mapping.js';

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
function tryExtractModel(rawBody, contentEncoding) {
    try {
        let jsonBuf = rawBody;

        if (contentEncoding === 'zstd') {
            // Node 22+ has zstd support in zlib
            if (typeof zlib.zstdDecompressSync === 'function') {
                jsonBuf = zlib.zstdDecompressSync(rawBody);
            } else {
                // Can't decompress, use default
                return 'unknown';
            }
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

        if (contentEncoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
            jsonBuf = zlib.zstdDecompressSync(rawBody);
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
    console.log('\n' + '='.repeat(70));
    console.log(`[Codex Proxy] >>> REQUEST via /responses`);
    console.log(`  Model:       ${modelId}`);
    console.log(`  Encoding:    ${contentEncoding || 'none'}`);
    console.log(`  Body size:   ${rawBody.length} bytes`);
    if (parsed) {
        console.log(`  Stream:      ${parsed.stream !== false}`);
        const toolNames = Array.isArray(parsed.tools) ? parsed.tools.map(t => t.name || t.function?.name).filter(Boolean) : [];
        console.log(`  Tools:       ${toolNames.length > 0 ? toolNames.join(', ') : '(none)'}`);
        if (parsed.instructions) {
            console.log(`  System:      ${parsed.instructions.slice(0, 120)}${parsed.instructions.length > 120 ? '...' : ''}`);
        }
        if (Array.isArray(parsed.input)) {
            const msgs = parsed.input.slice(-3).map(item => {
                if (item.type === 'message') {
                    const text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
                    return `[${item.role}] ${text.slice(0, 100)}${text.length > 100 ? '...' : ''}`;
                }
                return `[${item.type}]`;
            });
            console.log(`  Last msgs (${parsed.input.length} total):`);
            for (const m of msgs) console.log(`    ${m}`);
        }
    }
    console.log('='.repeat(70));

    const isStreaming = parsed ? parsed.stream !== false : true;

    const settings = getServerSettings();
    const priority = settings.routingPriority || 'account-first';
    const hasAccounts = listAccounts().total > 0;
    const chatKeyTypes = ['openai', 'azure-openai', 'gemini', 'vertex-ai'];
    const hasApiKeys = hasKeysForTypes(chatKeyTypes);

    if (priority === 'apikey-first' && hasApiKeys && parsed) {
        const result = await _handleResponsesViaApiKey(res, parsed, modelId, isStreaming, chatKeyTypes, startTime);
        if (result !== false) return;
        if (hasAccounts) {
            const poolResult = await _handleResponsesViaAccountPool(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime);
            if (poolResult !== false) return;
        }
        return res.status(503).json({ error: { message: 'All API keys and accounts exhausted.' } });
    }

    // account-first (default)
    if (hasAccounts) {
        const poolResult = await _handleResponsesViaAccountPool(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime);
        if (poolResult !== false) return;
    }
    if (hasApiKeys && parsed) {
        const result = await _handleResponsesViaApiKey(res, parsed, modelId, isStreaming, chatKeyTypes, startTime);
        if (result !== false) return;
    }

    if (!hasAccounts && !hasApiKeys) {
        return res.status(401).json({ error: { message: 'No accounts or API keys configured. Add them in the dashboard.' } });
    }
    // Check if all API keys are rate-limited
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
                console.log(`[Codex Proxy] >>> API KEY fallback | ${type}/${provider.name} | ${modelId}→${mappedModel}`);

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

                const responsesFormat = _chatToResponsesFormat(chatResponse, modelId);
                console.log(`[Codex Proxy] <<< API KEY OK | ${type}/${provider.name} | model=${modelId} | ${durationMs}ms`);

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
            console.log(`[Codex Proxy] All accounts rate-limited, waiting ${Math.round(minWait / 1000)}s...`);
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

        console.log(`[Codex Proxy] >>> FORWARDING | account=${creds.email} | model=${modelId} | attempt=${attempt + 1}`);

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
                    console.log(`[Codex Proxy] Auth expired for ${creds.email}, trying next...`);
                    continue;
                }

                if (upstreamResponse.status === 429) {
                    const resetMs = parseResetTime(upstreamResponse, errorText);
                    rotator.markRateLimited(creds.email, resetMs, modelId);
                    rotator.notifyRateLimit(account, modelId);

                    if (resetMs <= SHORT_RATE_LIMIT_THRESHOLD_MS) {
                        console.log(`[Codex Proxy] Short rate limit on ${creds.email}, waiting ${resetMs}ms...`);
                        await sleep(resetMs);
                        attempt--;
                        continue;
                    }
                    console.log(`[Codex Proxy] Rate limited ${creds.email} (${Math.round(resetMs / 1000)}s), switching...`);
                    continue;
                }

                logger.error(`[Codex Proxy] Upstream error ${upstreamResponse.status}: ${errorText.slice(0, 200)}`);
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
            console.log(`[Codex Proxy] <<< RESPONSE OK | account=${creds.email} | model=${modelId} | ${duration}ms`);
            return;
        } catch (error) {
            logger.error(`[Codex Proxy] Network error on ${creds.email}: ${error.message}`);
            rotator.notifyFailure(account, modelId);
            continue;
        }
    }

    return false; // All retries exhausted
}

export default { handleResponses };
