import { sendMessageStream, sendMessage } from '../direct-api.js';
import { sendKiloMessageStream, sendKiloMessage } from '../kilo-api.js';
import { resolveModelRouting } from '../model-mapper.js';
import { sendAuthError, getCredentialsForAccount } from '../middleware/credentials.js';
import { initSSEResponse, pipeSSEStream, handleStreamError } from '../middleware/sse.js';
import { logger } from '../utils/logger.js';
import { AccountRotator } from '../account-rotation/index.js';
import { listAccounts, getActiveAccount, save } from '../account-manager.js';
import { loadAccounts as loadClaudeAccounts, refreshAccountToken, getAccount as getClaudeAccount } from '../claude-account-manager.js';
import { sendClaudeMessage, sendClaudeStream } from '../claude-api.js';
import { getServerSettings } from '../server-settings.js';
import { selectKey, getAllProviders, recordUsage, recordError, recordRateLimit } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';
import { logRequest } from '../request-logger.js';

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
        logger.info(`[Messages] Account strategy: ${strategy}`);
    }
    return accountRotator;
}

export async function handleMessages(req, res) {
    const startTime = Date.now();
    const body = req.body;
    const requestedModel = body.model || 'gpt-5.2';
    const isStreaming = body.stream !== false;
    const clientBeta = req.headers['anthropic-beta'] || '';

    const { isKilo, kiloTarget, upstreamModel } = resolveModelRouting(requestedModel);

    if (isKilo) {
        return isStreaming
            ? _streamKilo(res, { ...body, model: upstreamModel }, kiloTarget, requestedModel, startTime)
            : _sendKilo(res, { ...body, model: upstreamModel }, kiloTarget, requestedModel, startTime);
    }

    const settings = getServerSettings();
    const priority = settings.routingPriority || 'account-first';
    const hasAccounts = listAccounts().total > 0;
    const hasApiKeys = !!selectKey('anthropic');
    const hasClaudeAccounts = _getUsableClaudeAccounts().length > 0;
    const hasCompatibleKeys = _getCompatibleProviders().length > 0;

    if (priority === 'apikey-first') {
        // apikey-first: Anthropic Key → compatible keys → ChatGPT accounts → Claude accounts
        if (hasApiKeys) {
            const result = await _handleViaApiKey(req, res, body, requestedModel, startTime);
            if (result !== false) return;
        }
        if (hasCompatibleKeys) {
            const result = await _handleViaCompatibleKeys(res, body, requestedModel, isStreaming, startTime);
            if (result !== false) return;
        }
        if (hasAccounts) {
            const poolResult = await _handleViaAccountPool(req, res, body, requestedModel, upstreamModel, isStreaming, startTime);
            if (poolResult !== false) return;
        }
        if (hasClaudeAccounts) {
            const claudeResult = await _handleViaClaudeAccount(res, body, requestedModel, isStreaming, startTime, clientBeta);
            if (claudeResult !== false) return;
        }
    } else {
        // account-first (default): ChatGPT accounts → Claude accounts → Anthropic Key → compatible keys
        if (hasAccounts) {
            const result = await _handleViaAccountPool(req, res, body, requestedModel, upstreamModel, isStreaming, startTime);
            if (result !== false) return;
        }
        if (hasClaudeAccounts) {
            const result = await _handleViaClaudeAccount(res, body, requestedModel, isStreaming, startTime, clientBeta);
            if (result !== false) return;
        }
        if (hasApiKeys) {
            const result = await _handleViaApiKey(req, res, body, requestedModel, startTime);
            if (result !== false) return;
        }
        if (hasCompatibleKeys) {
            const result = await _handleViaCompatibleKeys(res, body, requestedModel, isStreaming, startTime);
            if (result !== false) return;
        }
    }

    if (!hasAccounts && !hasApiKeys && !hasClaudeAccounts && !hasCompatibleKeys) {
        return sendAuthError(res, 'No accounts or API keys configured. Add them in the dashboard.');
    }

    // Check if the failure was due to model quota exhaustion
    const model = body.model || requestedModel;
    const allOnCooldown = hasClaudeAccounts && _getUsableClaudeAccounts().every(a => _isModelCooledDown(a.email, model));
    if (allOnCooldown) {
        return handleStreamError(res, new Error('MODEL_QUOTA_EXHAUSTED: All accounts have exhausted quota for this model. Try a different model or wait.'), requestedModel, startTime);
    }

    return handleStreamError(res, new Error('All accounts and API keys exhausted'), requestedModel, startTime);
}

/**
 * Handle request via Anthropic API key pool.
 * Returns false if no keys available, otherwise sends response.
 */
async function _handleViaApiKey(req, res, body, requestedModel, startTime) {
    const MAX_KEY_RETRIES = 3;
    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
        const provider = selectKey('anthropic');
        if (!provider) return false;

        try {
            const response = await provider.sendRequest(body);
            const durationMs = Date.now() - startTime;

            if (response.status === 429) {
                const retryAfter = response.headers?.get?.('retry-after');
                recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
                logger.warn(`[Messages] API key rate limited: ${provider.name}`);
                continue;
            }

            if (response.status === 401 || response.status === 403) {
                recordError(provider.id);
                logger.error(`[Messages] API key auth failed: ${provider.name}`);
                continue;
            }

            const responseBody = await response.text();

            if (!response.ok) {
                recordError(provider.id);
                recordRequest({ provider: 'anthropic', keyId: provider.id, model: body.model, durationMs, success: false, error: responseBody.slice(0, 200) });
                logRequest({ route: '/v1/messages', provider: 'anthropic', keyId: provider.id, model: body.model, requestBody: body, responseBody, durationMs, status: response.status, success: false, error: responseBody.slice(0, 200) });
                logger.warn(`[Messages] API key error ${response.status}: ${provider.name} - ${responseBody.slice(0, 200)}`);
                continue;
            }

            let inputTokens = 0, outputTokens = 0;
            try {
                const parsed = JSON.parse(responseBody);
                inputTokens = parsed.usage?.input_tokens || 0;
                outputTokens = parsed.usage?.output_tokens || 0;
            } catch { /* ignore */ }

            const cost = provider.estimateCost(body.model, inputTokens, outputTokens);
            recordUsage(provider.id, { inputTokens, outputTokens, model: body.model });
            recordRequest({ provider: 'anthropic', keyId: provider.id, model: body.model, inputTokens, outputTokens, cost, durationMs, success: true });
            logRequest({ route: '/v1/messages', provider: 'anthropic', keyId: provider.id, model: body.model, requestBody: body, responseBody, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });
            logger.info(`[Messages] OK via API key | ${provider.name} | model=${body.model} | ${inputTokens}+${outputTokens} tokens | $${cost.toFixed(4)} | ${durationMs}ms`);
            res.status(200).type('json').send(responseBody);
            return;
        } catch (error) {
            recordError(provider.id);
            recordRequest({ provider: 'anthropic', keyId: provider.id, model: body.model, durationMs: Date.now() - startTime, success: false, error: error.message });
            logger.error(`[Messages] API key network error: ${provider.name} - ${error.message}`);
            continue;
        }
    }
    return false;
}

/**
 * Handle request via ChatGPT account pool (original logic).
 * Returns false if completely exhausted.
 */
async function _handleViaAccountPool(req, res, body, requestedModel, upstreamModel, isStreaming, startTime) {
    const rotator = getAccountRotator();
    rotator.clearExpiredLimits();

    const maxAttempts = Math.max(MAX_RETRIES, listAccounts().total);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (rotator.isAllRateLimited(upstreamModel)) {
            const minWait = rotator.getMinWaitTimeMs(upstreamModel);

            if (minWait > MAX_WAIT_BEFORE_ERROR_MS) {
                return false; // Let caller try API keys
            }

            logger.info(`[Messages] All accounts rate-limited, waiting ${Math.round(minWait/1000)}s...`);
            await sleep(minWait + 500);
            rotator.clearExpiredLimits();
            attempt--;
            continue;
        }

        const { account, waitMs } = rotator.selectAccount(upstreamModel);

        if (!account) {
            if (waitMs > 0) {
                await sleep(waitMs);
                attempt--;
                continue;
            }
            return false; // No accounts available
        }

        const creds = await getCredentialsForAccount(account.email);
        if (!creds) {
            rotator.markInvalid(account.email, 'Failed to get credentials');
            continue;
        }

        const anthropicRequest = { ...body, model: upstreamModel };

        try {
            if (isStreaming) {
                await _streamDirectWithRotation(res, anthropicRequest, creds, requestedModel, startTime, rotator);
            } else {
                await _sendDirectWithRotation(res, anthropicRequest, creds, requestedModel, startTime, rotator);
            }
            rotator.notifySuccess(account, upstreamModel);
            return;
        } catch (error) {
            if (error.message.startsWith('RATE_LIMITED:')) {
                const parts = error.message.split(':');
                const resetMs = parseInt(parts[1], 10);

                rotator.notifyRateLimit(account, upstreamModel);

                if (resetMs <= SHORT_RATE_LIMIT_THRESHOLD_MS) {
                    logger.info(`[Messages] Short rate limit on ${account.email}, waiting ${resetMs}ms...`);
                    await sleep(resetMs);
                    attempt--;
                    continue;
                }

                logger.info(`[Messages] Rate limit on ${account.email}, switching account...`);
                continue;
            }

            if (error.message.includes('AUTH_EXPIRED')) {
                rotator.markInvalid(account.email, 'Auth expired');
                continue;
            }

            return handleStreamError(res, error, requestedModel, startTime);
        }
    }

    return false; // All retries exhausted
}

async function _streamDirectWithRotation(res, anthropicRequest, creds, responseModel, startTime, rotator) {
    initSSEResponse(res);
    const stream = sendMessageStream(anthropicRequest, creds.accessToken, creds.accountId, rotator, creds.email);
    await pipeSSEStream(res, stream);
    const durationMs = Date.now() - startTime;
    logger.response(200, { model: anthropicRequest.model, duration: durationMs });
    logRequest({ route: '/v1/messages', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: responseModel, mappedModel: anthropicRequest.model, durationMs, status: 200, success: true });
}

async function _sendDirectWithRotation(res, anthropicRequest, creds, responseModel, startTime, rotator) {
    const response = await sendMessage(anthropicRequest, creds.accessToken, creds.accountId);
    const durationMs = Date.now() - startTime;
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    logger.response(200, { model: anthropicRequest.model, tokens: outputTokens, duration: durationMs });
    logRequest({ route: '/v1/messages', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: responseModel, mappedModel: anthropicRequest.model, inputTokens, outputTokens, durationMs, status: 200, success: true });
    res.json({ ...response, model: responseModel });
}

async function _streamKilo(res, anthropicRequest, kiloTarget, responseModel, startTime) {
    initSSEResponse(res);
    const stream = sendKiloMessageStream(anthropicRequest, kiloTarget);
    await pipeSSEStream(res, stream);
    const durationMs = Date.now() - startTime;
    logger.response(200, { model: kiloTarget, duration: durationMs });
    logRequest({ route: '/v1/messages', method: 'POST', provider: 'kilo', model: responseModel, mappedModel: kiloTarget, durationMs, status: 200, success: true });
}

async function _sendKilo(res, anthropicRequest, kiloTarget, responseModel, startTime) {
    const response = await sendKiloMessage(anthropicRequest, kiloTarget);
    const durationMs = Date.now() - startTime;
    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    logger.response(200, { model: kiloTarget, tokens: outputTokens, duration: durationMs });
    logRequest({ route: '/v1/messages', method: 'POST', provider: 'kilo', model: responseModel, mappedModel: kiloTarget, inputTokens, outputTokens, durationMs, status: 200, success: true });
    res.json({
        id: response.id || undefined,
        type: 'message',
        role: 'assistant',
        content: response.content,
        model: responseModel,
        stop_reason: response.stopReason,
        stop_sequence: null,
        usage: response.usage
    });
}

// ─── JSON → Anthropic SSE wrapper ──────────────────────────────────────────────

/**
 * Wrap a complete Anthropic Messages JSON response into SSE events.
 * Used when the client expects streaming but the provider returned non-streaming JSON.
 */
function _sendAsAnthropicSSE(res, msg) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // message_start
    sse('message_start', {
        type: 'message_start',
        message: {
            id: msg.id || `msg_proxy_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: msg.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: msg.usage?.input_tokens || 0, output_tokens: 0 }
        }
    });

    // content blocks
    const content = msg.content || [];
    for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (block.type === 'text') {
            sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
            sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } });
            sse('content_block_stop', { type: 'content_block_stop', index: i });
        } else if (block.type === 'tool_use') {
            sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
            sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) } });
            sse('content_block_stop', { type: 'content_block_stop', index: i });
        }
    }

    // message_delta + message_stop
    sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: msg.stop_reason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: msg.usage?.output_tokens || 0 }
    });
    sse('message_stop', { type: 'message_stop' });

    res.end();
}

// ─── Compatible API Keys (any provider with sendAnthropicRequest) ──────────────

/**
 * Get all available providers that support Anthropic Messages format passthrough.
 * Excludes 'anthropic' type (handled separately by _handleViaApiKey).
 * Any provider that implements sendAnthropicRequest() is automatically discovered.
 */
function _getCompatibleProviders() {
    return getAllProviders().filter(p =>
        p.isAvailable &&
        p.type !== 'anthropic' &&
        typeof p.sendAnthropicRequest === 'function'
    );
}

/**
 * Handle request via any compatible API key (Vertex AI, Gemini, etc.).
 * Automatically discovers all providers that implement sendAnthropicRequest().
 * Each provider handles its own format conversion internally.
 * Returns false if no providers succeed.
 */
async function _handleViaCompatibleKeys(res, body, requestedModel, isStreaming, startTime) {
    const providers = _getCompatibleProviders();
    if (providers.length === 0) return false;

    // Least-requests-first load balancing
    providers.sort((a, b) => a.totalRequests - b.totalRequests);

    const MAX_ATTEMPTS = Math.min(3, providers.length);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const provider = providers[attempt];

        try {
            const response = await provider.sendAnthropicRequest(body);
            const durationMs = Date.now() - startTime;

            if (response.status === 429) {
                const retryAfter = response.headers?.get?.('retry-after');
                recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
                logger.warn(`[Messages] ${provider.type} rate limited: ${provider.name}`);
                continue;
            }

            if (response.status === 401 || response.status === 403) {
                recordError(provider.id);
                logger.error(`[Messages] ${provider.type} auth failed: ${provider.name}`);
                continue;
            }

            if (!response.ok) {
                const errorBody = await response.text();
                recordError(provider.id);
                recordRequest({ provider: provider.type, keyId: provider.id, model: body.model, durationMs, success: false, error: errorBody.slice(0, 200) });
                logRequest({ route: '/v1/messages', provider: provider.type, keyId: provider.id, model: body.model, requestBody: body, responseBody: errorBody, durationMs, status: response.status, success: false, error: errorBody.slice(0, 200) });
                logger.warn(`[Messages] ${provider.type} error ${response.status}: ${provider.name} - ${errorBody.slice(0, 200)}`);
                continue;
            }

            // Check if response is streaming (SSE) or JSON
            const contentType = response.headers?.get?.('content-type') || '';
            if (contentType.includes('text/event-stream')) {
                // Native SSE: pipe directly to client
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                const reader = response.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (res.writableEnded || res.destroyed) break;
                        res.write(value);
                    }
                } finally {
                    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
                }

                const streamDurationMs = Date.now() - startTime;
                recordRequest({ provider: provider.type, keyId: provider.id, model: body.model, durationMs: streamDurationMs, success: true });
                logRequest({ route: '/v1/messages', provider: provider.type, keyId: provider.id, model: requestedModel, mappedModel: body.model, durationMs: streamDurationMs, status: 200, success: true });
                logger.info(`[Messages] OK via ${provider.type} (stream) | ${provider.name} | model=${body.model} | ${streamDurationMs}ms`);
            } else {
                // JSON response — read it
                const responseBody = await response.text();

                let inputTokens = 0, outputTokens = 0, parsed = null;
                try {
                    parsed = JSON.parse(responseBody);
                    inputTokens = parsed.usage?.input_tokens || 0;
                    outputTokens = parsed.usage?.output_tokens || 0;
                } catch { /* ignore */ }

                const cost = provider.estimateCost(body.model, inputTokens, outputTokens);
                recordUsage(provider.id, { inputTokens, outputTokens, model: body.model });
                recordRequest({ provider: provider.type, keyId: provider.id, model: body.model, inputTokens, outputTokens, cost, durationMs, success: true });
                logRequest({ route: '/v1/messages', provider: provider.type, keyId: provider.id, model: requestedModel, mappedModel: body.model, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });
                logger.info(`[Messages] OK via ${provider.type} | ${provider.name} | model=${body.model} | ${inputTokens}+${outputTokens} tokens | $${cost.toFixed(4)} | ${durationMs}ms`);

                if (isStreaming && parsed) {
                    // Client expects SSE but provider returned JSON —
                    // wrap the Anthropic Messages response in SSE events
                    _sendAsAnthropicSSE(res, parsed);
                } else {
                    res.status(200).type('json').send(responseBody);
                }
            }
            return;
        } catch (error) {
            recordError(provider.id);
            recordRequest({ provider: provider.type, keyId: provider.id, model: body.model, durationMs: Date.now() - startTime, success: false, error: error.message });
            logger.error(`[Messages] ${provider.type} network error: ${provider.name} - ${error.message}`);
            continue;
        }
    }
    return false;
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
 * Handle request via Claude account pool.
 * Body is already in Anthropic Messages format — direct passthrough.
 */
// Per-model cooldown tracking for Claude OAuth quota exhaustion.
// Key: "email:model" → timestamp when cooldown expires
const _modelCooldowns = new Map();
const MODEL_COOLDOWN_MS = 30 * 1000; // 30 seconds

function _isModelCooledDown(email, model) {
    const key = `${email}:${model}`;
    const expiresAt = _modelCooldowns.get(key);
    if (!expiresAt) return false;
    if (Date.now() >= expiresAt) {
        _modelCooldowns.delete(key);
        return false;
    }
    return true;
}

function _setModelCooldown(email, model) {
    _modelCooldowns.set(`${email}:${model}`, Date.now() + MODEL_COOLDOWN_MS);
}

async function _handleViaClaudeAccount(res, body, requestedModel, isStreaming, startTime, clientBeta) {
    const accounts = _getUsableClaudeAccounts();
    const apiOpts = { clientBeta };
    const model = body.model || requestedModel;

    // Skip all accounts if every one is cooled down for this model
    const available = accounts.filter(a => !_isModelCooledDown(a.email, model));
    if (available.length === 0 && accounts.length > 0) {
        logger.warn(`[Messages] All Claude accounts on cooldown for model=${model}, skipping`);
        return false;
    }

    for (const account of accounts) {
        if (_isModelCooledDown(account.email, model)) continue;

        try {
            const claudeBody = { ...body, max_tokens: body.max_tokens || 8192 };
            logger.info(`[Messages] >>> Claude account | ${account.email} | model=${claudeBody.model}`);

            if (isStreaming) {
                const upstream = await sendClaudeStream(claudeBody, account.accessToken, apiOpts);

                // Pipe Anthropic SSE directly — no format conversion needed
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                const reader = upstream.body.getReader();
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        res.write(value);
                    }
                } catch (streamErr) {
                    // Stream failed mid-flight — write SSE error and close
                    logger.error(`[Messages] Claude stream interrupted: ${account.email} - ${streamErr.message}`);
                    if (!res.writableEnded) {
                        try {
                            res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: streamErr.message } })}\n\n`);
                        } catch { /* ignore */ }
                    }
                    recordRequest({ provider: 'claude-pool', keyId: account.email, model: body.model, durationMs: Date.now() - startTime, success: false, error: streamErr.message });
                    logRequest({ route: '/v1/messages', method: 'POST', provider: 'claude-pool', keyId: account.email, model: requestedModel, mappedModel: body.model, durationMs: Date.now() - startTime, status: 500, success: false, error: streamErr.message });
                    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
                    return true; // Response already committed, do not retry
                }
                if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
            } else {
                const result = await sendClaudeMessage(claudeBody, account.accessToken, apiOpts);
                res.json(result);
            }

            const durationMs = Date.now() - startTime;
            recordRequest({ provider: 'claude-pool', keyId: account.email, model: body.model, durationMs, success: true });
            logRequest({ route: '/v1/messages', method: 'POST', provider: 'claude-pool', keyId: account.email, model: requestedModel, mappedModel: body.model, durationMs, status: 200, success: true });
            logger.success(`[Messages] <<< OK via Claude account | ${account.email} | model=${body.model} | ${durationMs}ms`);
            return true;
        } catch (error) {
            const durationMs = Date.now() - startTime;

            // If headers were already sent (stream started), the response is committed — don't retry
            if (res.headersSent) {
                recordRequest({ provider: 'claude-pool', keyId: account.email, model: body.model, durationMs, success: false, error: error.message });
                logRequest({ route: '/v1/messages', method: 'POST', provider: 'claude-pool', keyId: account.email, model: requestedModel, mappedModel: body.model, durationMs, status: 500, success: false, error: error.message });
                logger.error(`[Messages] Claude account error (stream committed): ${account.email} - ${error.message}`);
                if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
                return true; // Response handled, do not retry
            }

            if (error.message.includes('AUTH_EXPIRED')) {
                logger.warn(`[Messages] Claude account auth expired: ${account.email}, attempting token refresh...`);
                try {
                    const refreshResult = await refreshAccountToken(account.email);
                    if (refreshResult.success) {
                        const refreshed = getClaudeAccount(account.email);
                        if (refreshed && refreshed.accessToken) {
                            logger.info(`[Messages] Token refreshed for ${account.email}, retrying...`);
                            const claudeBody = { ...body, max_tokens: body.max_tokens || 8192 };
                            if (isStreaming) {
                                const upstream = await sendClaudeStream(claudeBody, refreshed.accessToken, apiOpts);
                                res.setHeader('Content-Type', 'text/event-stream');
                                res.setHeader('Cache-Control', 'no-cache');
                                res.setHeader('Connection', 'keep-alive');
                                res.setHeader('X-Accel-Buffering', 'no');
                                res.flushHeaders();
                                const reader = upstream.body.getReader();
                                try {
                                    while (true) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
                                } catch (streamErr) {
                                    logger.error(`[Messages] Claude stream interrupted (after refresh): ${account.email} - ${streamErr.message}`);
                                    if (!res.writableEnded) { try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: streamErr.message } })}\n\n`); } catch { /* ignore */ } }
                                    if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
                                    return true;
                                }
                                if (!res.writableEnded) { try { res.end(); } catch { /* ignore */ } }
                            } else {
                                const result = await sendClaudeMessage(claudeBody, refreshed.accessToken, apiOpts);
                                res.json(result);
                            }
                            const retryDurationMs = Date.now() - startTime;
                            recordRequest({ provider: 'claude-pool', keyId: account.email, model: body.model, durationMs: retryDurationMs, success: true });
                            logRequest({ route: '/v1/messages', method: 'POST', provider: 'claude-pool', keyId: account.email, model: requestedModel, mappedModel: body.model, durationMs: retryDurationMs, status: 200, success: true });
                            logger.success(`[Messages] <<< OK via Claude account (after refresh) | ${account.email} | model=${body.model} | ${retryDurationMs}ms`);
                            return true;
                        }
                    }
                    logger.warn(`[Messages] Token refresh failed for ${account.email}: ${refreshResult.message}`);
                } catch (refreshErr) {
                    logger.warn(`[Messages] Token refresh error for ${account.email}: ${refreshErr.message}`);
                }
                continue;
            }
            if (error.message.startsWith('RATE_LIMITED:')) {
                logger.warn(`[Messages] Claude account rate limited: ${account.email}`);
                continue;
            }
            if (error.message.startsWith('MODEL_QUOTA_EXHAUSTED')) {
                _setModelCooldown(account.email, model);
                logger.warn(`[Messages] Claude account quota exhausted: ${account.email} | model=${model} | cooldown ${MODEL_COOLDOWN_MS / 1000}s`);
                recordRequest({ provider: 'claude-pool', keyId: account.email, model: body.model, durationMs, success: false, error: 'quota_exhausted' });
                logRequest({ route: '/v1/messages', method: 'POST', provider: 'claude-pool', keyId: account.email, model: requestedModel, mappedModel: body.model, durationMs, status: 429, success: false, error: 'Model quota exhausted' });
                continue; // try next account, but don't retry this one
            }
            recordRequest({ provider: 'claude-pool', keyId: account.email, model: body.model, durationMs, success: false, error: error.message });
            logRequest({ route: '/v1/messages', method: 'POST', provider: 'claude-pool', keyId: account.email, model: requestedModel, mappedModel: body.model, durationMs, status: 500, success: false, error: error.message });
            logger.error(`[Messages] Claude account error: ${account.email} - ${error.message}`);
            continue;
        }
    }

    return false;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default { handleMessages };
