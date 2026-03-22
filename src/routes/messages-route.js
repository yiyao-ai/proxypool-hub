import { sendMessageStream, sendMessage } from '../direct-api.js';
import { sendKiloMessageStream, sendKiloMessage } from '../kilo-api.js';
import { resolveModelRouting } from '../model-mapper.js';
import { sendAuthError, getCredentialsForAccount } from '../middleware/credentials.js';
import { initSSEResponse, pipeSSEStream, handleStreamError } from '../middleware/sse.js';
import { logger } from '../utils/logger.js';
import { AccountRotator } from '../account-rotation/index.js';
import { listAccounts, getActiveAccount, save } from '../account-manager.js';
import { getServerSettings } from '../server-settings.js';
import { selectKey, recordUsage, recordError, recordRateLimit } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';

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

    if (priority === 'apikey-first' && hasApiKeys) {
        const result = await _handleViaApiKey(req, res, body, requestedModel, startTime);
        if (result !== false) return;
        // API key failed, try account pool
        if (hasAccounts) return _handleViaAccountPool(req, res, body, requestedModel, upstreamModel, isStreaming, startTime);
        return handleStreamError(res, new Error('No available API keys or accounts'), requestedModel, startTime);
    }

    // account-first (default)
    if (hasAccounts) {
        const result = await _handleViaAccountPool(req, res, body, requestedModel, upstreamModel, isStreaming, startTime);
        if (result !== false) return;
    }
    // Fallback to API keys
    if (hasApiKeys) {
        const result = await _handleViaApiKey(req, res, body, requestedModel, startTime);
        if (result !== false) return;
    }

    if (!hasAccounts && !hasApiKeys) {
        return sendAuthError(res, 'No accounts or API keys configured. Add them in the dashboard.');
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
    logger.response(200, { model: anthropicRequest.model, duration: Date.now() - startTime });
}

async function _sendDirectWithRotation(res, anthropicRequest, creds, responseModel, startTime, rotator) {
    const response = await sendMessage(anthropicRequest, creds.accessToken, creds.accountId);
    const duration = Date.now() - startTime;
    logger.response(200, { model: anthropicRequest.model, tokens: response.usage?.output_tokens || 0, duration });
    res.json({ ...response, model: responseModel });
}

async function _streamKilo(res, anthropicRequest, kiloTarget, responseModel, startTime) {
    initSSEResponse(res);
    const stream = sendKiloMessageStream(anthropicRequest, kiloTarget);
    await pipeSSEStream(res, stream);
    logger.response(200, { model: kiloTarget, duration: Date.now() - startTime });
}

async function _sendKilo(res, anthropicRequest, kiloTarget, responseModel, startTime) {
    const response = await sendKiloMessage(anthropicRequest, kiloTarget);
    const duration = Date.now() - startTime;
    logger.response(200, { model: kiloTarget, tokens: response.usage?.output_tokens || 0, duration });
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default { handleMessages };
