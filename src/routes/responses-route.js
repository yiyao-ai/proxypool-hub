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
import { getUsableAccounts as getUsableClaudeAccounts, advanceUsableAccountsRotation, refreshAccountToken, getAccount as getClaudeAccount } from '../claude-account-manager.js';
import { recordClaudeRuntimeObservation } from '../claude-usage.js';
import { sendClaudeMessageWithMeta, mapToClaudeModel } from '../claude-api.js';
import { listAccounts as listAntigravityAccounts, getAvailableAccountsForModel as getAntigravityAccountsForModel, advanceAvailableAccountsRotation as advanceAntigravityAccountsRotation } from '../antigravity-account-manager.js';
import { sendAntigravityMessage, isAntigravityModel } from '../antigravity-api.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { logger } from '../utils/logger.js';
import { normalizeJsonSchema } from '../json-schema-normalizer.js';
import { getServerSettings } from '../server-settings.js';
import { selectKey, recordUsage, recordError, recordRateLimit, hasKeysForTypes, getKeyRateLimitInfo } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';
import zlib from 'zlib';
import { decompress as fzstdDecompress } from 'fzstd';
import { sendResponsesSSE } from '../utils/responses-sse.js';
import { resolveModel } from '../model-mapping.js';
import { logRequest } from '../request-logger.js';
import { detectRequestApp, resolveAssignedCredentials, orderAssignedCredentials } from '../app-routing.js';
import { resolveCredentialForRequest } from '../credential-selector.js';
import { buildCredentialId } from '../credential-registry.js';
import { getCredentialRuntimeState, markCredentialError, markCredentialRateLimited, markCredentialSuccess, recordRoutingDecision } from '../runtime-state.js';
import { tryHandleLocalResponses } from '../local-routing.js';
import {
    extractDeepSeekReasoningText,
    isDeepSeekProviderType,
    mergeDeepSeekReasoningText,
    normalizeDeepSeekRequestBody
} from '../deepseek-utils.js';
import { shouldInjectEndTurnFalse, maybeInjectFromLocals } from '../utils/codex-compaction-tracker.js';

const UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses';
const UPSTREAM_COMPACT_URL = 'https://chatgpt.com/backend-api/codex/responses/compact';
const MAX_RETRIES = 5;
const MAX_WAIT_BEFORE_ERROR_MS = 120000;
const SHORT_RATE_LIMIT_THRESHOLD_MS = 5000;
const PASSTHROUGH_REQUEST_HEADER_WHITELIST = [
    'x-client-request-id',
    'x-openai-subagent',
    'x-codex-turn-state',
    'x-codex-window-id',
    'x-codex-parent-thread-id',
    'x-codex-turn-metadata',
    'x-codex-installation-id',
    'x-codex-beta-features',
    'x-responsesapi-include-timing-metrics',
    'openai-beta'
];
const PASSTHROUGH_RESPONSE_HEADER_WHITELIST = [
    'openai-model',
    'x-openai-model',
    'x-models-etag',
    'x-reasoning-included',
    'x-codex-turn-state',
    'retry-after',
    'x-ratelimit-reset',
    'x-ratelimit-limit-requests',
    'x-ratelimit-remaining-requests',
    'x-ratelimit-limit-tokens',
    'x-ratelimit-remaining-tokens'
];

let accountRotator = null;
let currentStrategy = null;

function getAccountRotator() {
    const settings = getServerSettings();
    const strategy = settings.accountStrategy || 'sequential';

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

function copyAllowedRequestHeaders(sourceHeaders = {}, targetHeaders = {}) {
    for (const headerName of PASSTHROUGH_REQUEST_HEADER_WHITELIST) {
        const value = sourceHeaders[headerName];
        if (value !== undefined && value !== null && value !== '') {
            targetHeaders[headerName] = value;
        }
    }
}

function copyAllowedResponseHeaders(upstreamResponse, res) {
    for (const headerName of PASSTHROUGH_RESPONSE_HEADER_WHITELIST) {
        const value = upstreamResponse.headers?.get?.(headerName);
        if (value) {
            res.setHeader(headerName, value);
        }
    }
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

function normalizeChatMessageContent(content) {
    if (content === null || content === undefined) return null;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.length > 0 ? content : null;
    return null;
}

function mergeChatMessageContent(existing, incoming) {
    const left = normalizeChatMessageContent(existing);
    const right = normalizeChatMessageContent(incoming);

    if (left === null) return right;
    if (right === null) return left;

    if (typeof left === 'string' && typeof right === 'string') {
        if (!left) return right;
        if (!right) return left;
        return `${left}\n${right}`;
    }

    const toParts = (value) => {
        if (value === null || value === undefined) return [];
        if (typeof value === 'string') return value ? [{ type: 'text', text: value }] : [];
        if (Array.isArray(value)) return value;
        return [];
    };

    const merged = [...toParts(left), ...toParts(right)];
    if (merged.length === 0) return null;
    if (merged.every(part => part?.type === 'text')) {
        return merged.map(part => part.text || '').join('\n');
    }
    return merged;
}

function applyDeepSeekReasoningToChatMessages(messages, responsesInput) {
    if (!Array.isArray(messages) || messages.length === 0 || !Array.isArray(responsesInput)) {
        return messages;
    }

    const normalizedMessages = messages.map((message) => ({ ...message }));
    const assistantIndexes = normalizedMessages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message?.role === 'assistant')
        .map(({ index }) => index);

    let assistantCursor = 0;
    let pendingReasoning = '';

    for (const item of responsesInput) {
        if (item?.type === 'reasoning') {
            pendingReasoning = mergeDeepSeekReasoningText(
                pendingReasoning,
                extractDeepSeekReasoningText(item)
            );
            continue;
        }

        if (item?.type !== 'message' || item.role !== 'assistant') {
            continue;
        }

        if (!pendingReasoning) {
            assistantCursor++;
            continue;
        }

        while (assistantCursor < assistantIndexes.length) {
            const targetIndex = assistantIndexes[assistantCursor++];
            const target = normalizedMessages[targetIndex];
            if (!target.reasoning_content) {
                target.reasoning_content = pendingReasoning;
                pendingReasoning = '';
                break;
            }
        }
    }

    if (pendingReasoning) {
        for (let i = assistantIndexes.length - 1; i >= 0; i--) {
            const target = normalizedMessages[assistantIndexes[i]];
            if (!target.reasoning_content) {
                target.reasoning_content = pendingReasoning;
                break;
            }
        }
    }

    return normalizedMessages;
}

function summarizeChatMessage(message, index) {
    if (!message) return `${index}: <missing>`;

    const parts = [`${index}:${message.role || 'unknown'}`];
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        parts.push(`tool_calls=[${message.tool_calls.map(tc => tc.id).join(',')}]`);
    }
    if (message.tool_call_id) {
        parts.push(`tool_call_id=${message.tool_call_id}`);
    }

    let preview = '';
    if (typeof message.content === 'string') {
        preview = message.content;
    } else if (Array.isArray(message.content)) {
        preview = message.content
            .map(part => part?.text || part?.type || '')
            .filter(Boolean)
            .join(' | ');
    }

    if (preview) {
        const compact = preview.replace(/\s+/g, ' ').slice(0, 80);
        parts.push(`content="${compact}"`);
    }

    return parts.join(' | ');
}

function findToolCallSequenceError(messages) {
    if (!Array.isArray(messages)) return null;

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
            continue;
        }

        const pendingIds = new Set(message.tool_calls.map(tc => tc?.id).filter(Boolean));
        let nextIndex = i + 1;
        while (nextIndex < messages.length && messages[nextIndex]?.role === 'tool') {
            const toolCallId = messages[nextIndex]?.tool_call_id;
            if (toolCallId) pendingIds.delete(toolCallId);
            nextIndex++;
        }

        if (pendingIds.size > 0) {
            const start = Math.max(0, i - 2);
            const end = Math.min(messages.length, nextIndex + 2);
            return {
                assistantIndex: i,
                missingIds: [...pendingIds],
                nextRole: messages[nextIndex]?.role || 'end',
                window: messages.slice(start, end).map((msg, offset) => summarizeChatMessage(msg, start + offset))
            };
        }
    }

    return null;
}

/**
 * POST /responses (and /v1/responses)
 * Raw passthrough proxy with account rotation.
 */
export async function handleResponses(req, res) {
    const startTime = Date.now();
    const contentEncoding = req.headers['content-encoding'] || '';
    const isCompact = req.path.endsWith('/compact');

    // Collect raw body (bypasses express.json)
    const rawBody = await collectRawBody(req);

    // Best-effort extract model and log info
    const modelId = tryExtractModel(rawBody, contentEncoding);
    const parsed = tryExtractSummary(rawBody, contentEncoding);

    // Compact requests must return a final JSON payload, not SSE.
    // Codex parses /responses/compact as a completed value.
    if (isCompact && parsed && parsed.store !== false) {
        parsed.store = false;
    }
    if (isCompact && parsed && parsed.stream !== false) {
        parsed.stream = false;
    }

    // --- Request logging ---
    const routeLabel = isCompact ? '/responses/compact' : '/responses';
    const toolNames = parsed && Array.isArray(parsed.tools) ? parsed.tools.map(t => t.name || t.function?.name).filter(Boolean) : [];
    logger.info(`[Codex] >>> ${routeLabel} | model=${modelId} | ${rawBody.length}B | encoding=${contentEncoding || 'none'} | tools=${toolNames.length}`);

    // Decide once per request whether to patch end_turn=false into the
    // outgoing response so Codex's auto-compaction continuation stays alive.
    // Honored downstream by sendResponsesSSE and by res.json sites via
    // maybeInjectFromLocals. See utils/codex-compaction-tracker.js.
    if (!res.locals) res.locals = {};
    res.locals.codexInjectEndTurn = shouldInjectEndTurnFalse(req, parsed || {});

    const isStreaming = resolveResponsesStreamingMode(isCompact, parsed);

    const settings = getServerSettings();
    const strictCodexCompatibility = settings.strictCodexCompatibility !== false;
    const appId = detectRequestApp(req);
    const priority = settings.routingPriority || 'account-first';
    const hasAccounts = listAccounts().total > 0;
    const chatKeyTypes = ['openai', 'azure-openai', 'gemini', 'vertex-ai', 'deepseek'];
    const hasApiKeys = hasKeysForTypes(chatKeyTypes);
    const hasClaudeAccounts = _getUsableClaudeAccounts().length > 0;
    const hasAntigravityAccounts = settings.antigravityEnabled !== false && listAntigravityAccounts().total > 0;
    const routingPreview = resolveCredentialForRequest({
        appId,
        model: modelId,
        protocol: 'openai-responses',
        settings
    });

    if (routingPreview.selectedCredential) {
        recordRoutingDecision({
            appId,
            protocol: 'openai-responses',
            model: modelId,
            selectedCredentialId: routingPreview.selectedCredential.id,
            selectedCredentialKind: routingPreview.selectedCredential.kind,
            selectedCredentialLabel: routingPreview.selectedCredential.label,
            reason: routingPreview.reason,
            outcome: 'selected'
        });
    } else {
        recordRoutingDecision({
            appId,
            protocol: 'openai-responses',
            model: modelId,
            reason: routingPreview.reason,
            outcome: 'unresolved'
        });
    }

    if (settings.routingMode === 'app-assigned') {
        const assignment = resolveAssignedCredentials(settings, appId);
        if (assignment.matched) {
            const result = await _handleResponsesAssignment(req, res, assignment, rawBody, contentEncoding, parsed, modelId, isStreaming, startTime, isCompact);
            if (result !== false) return;
            if (!assignment.fallbackToDefault) {
                const failureReason = getAssignedFailureReason(assignment);
                return res.status(503).json({
                    error: { message: `Assigned credential unavailable for ${appId}: ${failureReason}` }
                });
            }
        }
    }

    if (parsed) {
        const localResult = await tryHandleLocalResponses(res, parsed, {
            appId,
            requestedModel: modelId,
            isStreaming
        });
        if (localResult !== false) return;
    }

    if (!strictCodexCompatibility && hasAntigravityAccounts && parsed && isAntigravityModel(modelId)) {
        const result = await _handleResponsesViaAntigravityAccount(res, parsed, modelId, isStreaming, startTime);
        if (result !== false) return;
    }

    if (priority === 'apikey-first') {
        // apikey-first: API Key → ChatGPT accounts → Claude accounts
        if (hasApiKeys && parsed) {
            const result = await _handleResponsesViaApiKey(res, parsed, modelId, isStreaming, chatKeyTypes, startTime, req.headers);
            if (result !== false) return;
        }
        if (hasAccounts) {
            const poolResult = await _handleResponsesViaAccountPool(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime, isCompact);
            if (poolResult !== false) return;
        }
        if (!strictCodexCompatibility && hasClaudeAccounts && parsed) {
            const claudeResult = await _handleResponsesViaClaudeAccount(res, parsed, modelId, isStreaming, startTime);
            if (claudeResult !== false) return;
        }
        if (!strictCodexCompatibility && hasAntigravityAccounts && parsed) {
            const antigravityResult = await _handleResponsesViaAntigravityAccount(res, parsed, modelId, isStreaming, startTime);
            if (antigravityResult !== false) return;
        }
    } else {
        // account-first (default): ChatGPT accounts → API Key → optional extended fallback
        if (hasAccounts) {
            const poolResult = await _handleResponsesViaAccountPool(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime, isCompact);
            if (poolResult !== false) return;
        }
        if (hasApiKeys && parsed) {
            const result = await _handleResponsesViaApiKey(res, parsed, modelId, isStreaming, chatKeyTypes, startTime, req.headers);
            if (result !== false) return;
        }
        if (!strictCodexCompatibility && hasClaudeAccounts && parsed) {
            const claudeResult = await _handleResponsesViaClaudeAccount(res, parsed, modelId, isStreaming, startTime);
            if (claudeResult !== false) return;
        }
        if (!strictCodexCompatibility && hasAntigravityAccounts && parsed) {
            const antigravityResult = await _handleResponsesViaAntigravityAccount(res, parsed, modelId, isStreaming, startTime);
            if (antigravityResult !== false) return;
        }
    }

    if (!hasAccounts && !hasApiKeys && !hasClaudeAccounts && !hasAntigravityAccounts) {
        return res.status(401).json({ error: { message: 'No accounts or API keys configured. Add them in the dashboard.' } });
    }
    const rlInfo = getKeyRateLimitInfo(chatKeyTypes);
    if (rlInfo.allRateLimited) {
        const waitSec = Math.ceil(rlInfo.minWaitMs / 1000);
        return res.status(429).json({ error: { message: `All API keys are rate-limited. Try again in ${waitSec}s.`, retry_after: waitSec } });
    }
    return res.status(503).json({ error: { message: 'All accounts and API keys exhausted. Try again later.' } });
}

async function _handleResponsesAssignment(req, res, assignment, rawBody, contentEncoding, parsed, modelId, isStreaming, startTime, isCompact) {
    const baseAssignments = Array.isArray(assignment.assignments)
        ? assignment.assignments
        : (assignment.credential ? [assignment] : []);
    const settings = getServerSettings();
    const assignments = orderAssignedCredentials(baseAssignments, settings.accountStrategy || 'sequential');

    for (const candidate of assignments) {
        if (!candidate?.credential) continue;
        const targetId = candidate.credential?.email || candidate.credential?.id || candidate.binding?.targetId || 'unknown';
        logger.info(`[Codex] Assigned binding | app=${assignment.appId} | type=${candidate.credentialType} | target=${targetId}`);

        if (candidate.credentialType === 'chatgpt-account') {
            const result = await _handleResponsesViaAssignedAccount(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime, isCompact, candidate.credential.email);
            if (result !== false) return result;
            continue;
        }

        if (candidate.credentialType === 'claude-account') {
            if (!parsed) continue;
            const result = await _handleResponsesViaAssignedClaudeAccount(res, parsed, modelId, isStreaming, startTime, candidate.credential.email);
            if (result !== false) return result;
            continue;
        }
        if (candidate.credentialType === 'antigravity-account') {
            if (!parsed) continue;
            const result = await _handleResponsesViaAssignedAntigravityAccount(res, parsed, modelId, isStreaming, startTime, candidate.credential.email);
            if (result !== false) return result;
            continue;
        }
        if (candidate.credentialType === 'local-model') {
            if (!parsed) continue;
            const result = await tryHandleLocalResponses(res, parsed, {
                appId: assignment.appId,
                requestedModel: modelId,
                isStreaming,
                assignedModel: candidate.credential.model || candidate.credential.id,
                forceLocal: true
            });
            if (result !== false) return result;
            continue;
        }

        if (!parsed) continue;
        const result = await _handleResponsesViaAssignedApiKey(res, parsed, modelId, isStreaming, startTime, candidate.credential, assignment, req.headers);
        if (result !== false) return result;
    }

    return false;
}

async function _handleResponsesViaAssignedApiKey(res, parsed, modelId, isStreaming, startTime, provider, assignment = null, requestHeaders = {}) {
    try {
        let mappedModel;
        let response;
        let responseBody;
        let responsesFormat;

        if (providerSupportsNativeResponses(provider)) {
            ({ mappedModel, response, responseBody, normalized: responsesFormat } = await sendViaNativeResponsesProvider(provider, parsed, modelId, requestHeaders));
        } else {
            const chatBody = _responsesToChatBody(parsed);
            mappedModel = resolveModel(provider.type, modelId);
            const mappedBody = isDeepSeekProviderType(provider.type)
                ? normalizeDeepSeekRequestBody({ ...chatBody, model: mappedModel })
                : { ...chatBody, model: mappedModel };
            response = await provider.sendRequest(mappedBody);
            responseBody = await response.text();
            let chatResponse;
            try {
                chatResponse = JSON.parse(responseBody);
            } catch {
                markCredentialError(buildCredentialId('api-key', provider.id), 'invalid_json_response', { model: mappedModel || modelId });
                recordAssignmentUpstreamError(assignment, {
                    provider: provider.type,
                    keyId: provider.id,
                    status: 'invalid_json',
                    message: 'invalid_json_response'
                });
                logger.warn(`[Codex] Assigned API key invalid JSON response: ${provider.name}`);
                return false;
            }
            responsesFormat = _chatToResponsesFormat(chatResponse, modelId);
        }
        const durationMs = Date.now() - startTime;

        if (!response.ok) {
            const upstreamMessage = extractUpstreamErrorMessage(responseBody, response.status);
            recordAssignmentUpstreamError(assignment, {
                provider: provider.type,
                keyId: provider.id,
                status: response.status,
                message: upstreamMessage
            });
            logger.warn(`[Codex] Assigned API key upstream error | ${provider.type}/${provider.name} | http_${response.status} | ${upstreamMessage}`);
            if (response.status === 429) recordRateLimit(provider.id, 60000);
            if (response.status === 401 || response.status === 403) recordError(provider.id);
            if (response.status === 429) {
                markCredentialRateLimited(buildCredentialId('api-key', provider.id), 60000, { model: mappedModel || modelId });
            } else if (response.status === 401 || response.status === 403) {
                markCredentialError(buildCredentialId('api-key', provider.id), `auth_error_${response.status}`, { model: mappedModel || modelId, invalid: true });
            } else {
                markCredentialError(buildCredentialId('api-key', provider.id), `http_${response.status}: ${upstreamMessage}`, { model: mappedModel || modelId });
            }
            logRequest({
                route: '/responses',
                provider: provider.type,
                keyId: provider.id,
                model: modelId,
                mappedModel,
                requestBody: parsed,
                responseBody,
                durationMs,
                status: response.status,
                success: false,
                error: String(responseBody || '').slice(0, 200)
            });
            return false;
        }

        if (!responsesFormat) {
            markCredentialError(buildCredentialId('api-key', provider.id), 'invalid_chat_response_shape', { model: mappedModel || modelId });
            recordAssignmentUpstreamError(assignment, {
                provider: provider.type,
                keyId: provider.id,
                status: 'invalid_shape',
                message: 'invalid_chat_response_shape'
            });
            logger.warn(`[Codex] Assigned API key returned an unsupported chat response shape: ${provider.name}`);
            return false;
        }
        if (providerSupportsNativeResponses(provider)) {
            logger.info(`[Codex] Native responses output | ${provider.type}/${provider.name} | ${summarizeResponseOutputTypes(responsesFormat)}`);
        }
        const inputTokens = responsesFormat.usage?.input_tokens || 0;
        const outputTokens = responsesFormat.usage?.output_tokens || 0;
        const cost = provider.estimateCost(mappedModel, inputTokens, outputTokens);
        recordUsage(provider.id, { inputTokens, outputTokens, model: mappedModel });
        markCredentialSuccess(buildCredentialId('api-key', provider.id), {
            model: mappedModel,
            latencyMs: durationMs
        });
        recordRequest({ provider: provider.type, keyId: provider.id, model: mappedModel, inputTokens, outputTokens, cost, durationMs, success: true });
        logRequest({ route: '/responses', provider: provider.type, keyId: provider.id, model: modelId, mappedModel, requestBody: parsed, responseBody, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });
        logger.success(`[Codex] <<< Assigned API KEY OK | ${provider.type}/${provider.name} | model=${modelId} | ${durationMs}ms`);

        if (providerSupportsNativeResponses(provider)) {
            copyAllowedResponseHeaders(response, res);
        }
        if (isStreaming) sendResponsesSSE(res, responsesFormat); else res.json(maybeInjectFromLocals(res, responsesFormat));
        return true;
    } catch (error) {
        markCredentialError(buildCredentialId('api-key', provider.id), error, { model: modelId });
        recordAssignmentUpstreamError(assignment, {
            provider: provider.type,
            keyId: provider.id,
            status: 'exception',
            message: error?.message || String(error)
        });
        logger.error(`[Codex] Assigned API key error: ${provider.name} - ${error.message}`);
        return false;
    }
}

async function _handleResponsesViaAssignedClaudeAccount(res, parsed, modelId, isStreaming, startTime, email) {
    const account = getClaudeAccount(email);
    if (!account?.accessToken || account.enabled === false) return false;

    const anthropicBody = _responsesToAnthropicBody(parsed);
    try {
        const { data: claudeResponse, rateLimitHeaders } = await sendClaudeMessageWithMeta(anthropicBody, account.accessToken);
        recordClaudeRuntimeObservation(account.email, rateLimitHeaders, { model: anthropicBody.model });
        const durationMs = Date.now() - startTime;
        const responsesFormat = _anthropicToResponsesFormat(claudeResponse, modelId);
        const inputTokens = claudeResponse.usage?.input_tokens || 0;
        const outputTokens = claudeResponse.usage?.output_tokens || 0;
        markCredentialSuccess(buildCredentialId('claude-account', account.email), {
            model: anthropicBody.model,
            latencyMs: durationMs
        });
        recordRequest({ provider: 'claude-pool', keyId: account.email, model: anthropicBody.model, inputTokens, outputTokens, durationMs, success: true });
        logRequest({ route: '/responses', provider: 'claude-pool', keyId: account.email, model: modelId, mappedModel: anthropicBody.model, requestBody: parsed, inputTokens, outputTokens, durationMs, status: 200, success: true });
        logger.success(`[Codex] <<< Assigned Claude account OK | ${account.email} | model=${modelId} | ${inputTokens}+${outputTokens} tokens | ${durationMs}ms`);
        if (isStreaming) sendResponsesSSE(res, responsesFormat); else res.json(maybeInjectFromLocals(res, responsesFormat));
        return true;
    } catch (error) {
        recordClaudeRuntimeObservation(account.email, error.rateLimitHeaders, { model: anthropicBody.model });
        markCredentialError(buildCredentialId('claude-account', account.email), error, {
            model: anthropicBody.model,
            invalid: error.message.includes('AUTH_EXPIRED')
        });
        logger.error(`[Codex] Assigned Claude account error: ${account.email} - ${error.message}`);
        return false;
    }
}

async function _handleResponsesViaAssignedAccount(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime, isCompact, email) {
    const creds = await getCredentialsForAccount(email);
    if (!creds) return false;

    try {
        const upstreamHeaders = {
            'Authorization': `Bearer ${creds.accessToken}`,
            'ChatGPT-Account-ID': creds.accountId,
            'Content-Type': req.headers['content-type'] || 'application/json',
            'Accept': isStreaming ? 'text/event-stream' : 'application/json'
        };
        if (contentEncoding) upstreamHeaders['Content-Encoding'] = contentEncoding;

        const targetUrl = isCompact ? UPSTREAM_COMPACT_URL : UPSTREAM_URL;
        const upstreamResponse = await fetch(targetUrl, { method: 'POST', headers: upstreamHeaders, body: rawBody });
        if (!upstreamResponse.ok) return false;

        if (isStreaming) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();
            const reader = upstreamResponse.body.getReader();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
            }
            res.end();
        } else {
            const responseBody = await upstreamResponse.text();
            res.setHeader('Content-Type', 'application/json');
            if (isCompact) {
                const normalized = normalizeCompactResponse(responseBody, modelId);
                if (!normalized) {
                    logger.error(`[Codex Proxy] Invalid compact response body from upstream for model=${modelId}`);
                    return res.status(502).json({ error: { message: 'Invalid compact response from upstream.' } });
                }
                res.json(normalized);
            } else {
                res.send(responseBody);
            }
        }

        const duration = Date.now() - startTime;
        markCredentialSuccess(buildCredentialId('chatgpt-account', creds.email), {
            model: modelId,
            latencyMs: duration
        });
        recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: true });
        logRequest({ route: '/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, mappedModel: modelId, durationMs: duration, status: 200, success: true });
        logger.success(`[Codex] <<< Assigned account OK | account=${creds.email} | model=${modelId} | ${duration}ms`);
        return true;
    } catch (error) {
        markCredentialError(buildCredentialId('chatgpt-account', email), error, { model: modelId });
        logger.error(`[Codex] Assigned account error: ${email} - ${error.message}`);
        return false;
    }
}

// ─── Responses API ↔ Chat Completions format converters ───────────────────────

function _responsesToChatBody(parsed) {
    const messages = [];

    // Diagnostic — count reasoning items in input. Used to verify whether the
    // Codex client echoes back `type:'reasoning'` items emitted by the proxy.
    // If this count stays at 0 across multi-turn sessions where the upstream
    // model returned reasoning_content, Codex isn't preserving them, and Plan C
    // Step 2 (writing reasoning_content into outgoing assistant messages) is
    // not feasible on the OpenAI-protocol path.
    if (Array.isArray(parsed?.input)) {
        const reasoningCount = parsed.input.filter(item => item?.type === 'reasoning').length;
        if (reasoningCount > 0) {
            logger.info(`[Codex] _responsesToChatBody received ${reasoningCount} reasoning item(s) in input`);
        }
    }

    // System / instructions
    if (parsed.instructions) {
        messages.push({ role: 'system', content: parsed.instructions });
    }

    // Helper to convert any block (text or image) to OpenAI Chat format
    const convertBlock = (c) => {
        if (!c) return null;
        if (c.type === 'text' || (c.text && c.type !== 'input_image')) {
            return { type: 'text', text: c.text || '' };
        }
        if (c.type === 'input_image' || c.type === 'image') {
            // input_image can carry: data (base64), image_url (string URL), url (string URL), or file_id
            if (c.data) {
                return { type: 'image_url', image_url: { url: `data:${c.media_type || 'image/jpeg'};base64,${c.data}` } };
            }
            if (c.image_url) {
                return { type: 'image_url', image_url: { url: c.image_url } };
            }
            if (c.url) {
                return { type: 'image_url', image_url: { url: c.url } };
            }
            // file_id not supported by Azure/OpenAI Chat API, skip
            return null;
        }
        if (c.type === 'image_url' || c.image_url) {
            return { type: 'image_url', image_url: c.image_url || { url: c.url } };
        }
        return null;
    };

    // Convert input array to messages
    if (Array.isArray(parsed.input)) {
        const callIdToName = {};
        for (const item of parsed.input) {
            if (item.type === 'function_call' && item.name) {
                callIdToName[item.call_id || item.id || ''] = item.name;
            }
        }

        let pendingToolCalls = null;
        let pendingToolCallIds = null;
        let deferredMessages = [];

        const flushDeferredMessages = () => {
            if (deferredMessages.length > 0) {
                messages.push(...deferredMessages);
                deferredMessages = [];
            }
        };

        const ensurePendingToolCallsFlushed = () => {
            if (pendingToolCalls) {
                messages.push(pendingToolCalls);
                pendingToolCallIds = new Set(
                    (pendingToolCalls.tool_calls || []).map(tc => tc.id).filter(Boolean)
                );
                pendingToolCalls = null;
            }
        };

        for (const item of parsed.input) {
            if (item.type === 'function_call') {
                if (pendingToolCallIds?.size > 0) {
                    flushDeferredMessages();
                    pendingToolCallIds = null;
                }
                if (!pendingToolCalls) {
                    const lastMessage = messages[messages.length - 1];
                    if (lastMessage?.role === 'assistant' && !lastMessage.tool_calls) {
                        pendingToolCalls = messages.pop();
                        pendingToolCalls.tool_calls = [];
                        pendingToolCalls.content = normalizeChatMessageContent(pendingToolCalls.content);
                    } else {
                        pendingToolCalls = { role: 'assistant', content: null, tool_calls: [] };
                    }
                }
                pendingToolCalls.tool_calls.push({
                    id: item.call_id || item.id || `call_${Date.now()}`,
                    type: 'function',
                    function: { name: item.name, arguments: item.arguments || '{}' }
                });
            } else {
                if (item.type === 'message') {
                    const role = item.role === 'developer' ? 'system' : item.role;
                    let content;
                    
                    if (typeof item.content === 'string') {
                        content = item.content;
                    } else if (Array.isArray(item.content)) {
                        content = item.content.map(convertBlock).filter(Boolean);
                        if (content.length > 0 && content.every(c => c.type === 'text')) {
                            content = content.map(c => c.text).join('\n');
                        }
                    } else if (item.content && typeof item.content === 'object') {
                        content = [convertBlock(item.content)].filter(Boolean);
                    }
                    
                    content = normalizeChatMessageContent(content);

                    if (role === 'assistant' && pendingToolCalls) {
                        pendingToolCalls.content = mergeChatMessageContent(pendingToolCalls.content, content);
                    } else {
                        if (pendingToolCalls) ensurePendingToolCallsFlushed();
                        if (pendingToolCallIds?.size > 0) {
                            if (content !== null) deferredMessages.push({ role, content });
                        } else if (content !== null) {
                            flushDeferredMessages();
                            messages.push({ role, content });
                        }
                    }
                } else if (item.type === 'input_image') {
                    // Image at top level - wrap in a user message via convertBlock
                    const converted = convertBlock(item);
                    if (converted) {
                        if (pendingToolCalls) ensurePendingToolCallsFlushed();
                        if (pendingToolCallIds?.size > 0) {
                            deferredMessages.push({ role: 'user', content: [converted] });
                        } else {
                            flushDeferredMessages();
                            messages.push({ role: 'user', content: [converted] });
                        }
                    }
                } else if (item.type === 'function_call_output') {
                    if (pendingToolCalls) {
                        ensurePendingToolCallsFlushed();
                    }
                    const callId = item.call_id || item.id || '';
                    let toolContent = item.output || '';
                    // output can be a string or an array with input_image/text blocks
                    if (Array.isArray(toolContent)) {
                        toolContent = toolContent.map(convertBlock).filter(Boolean);
                        if (toolContent.length > 0 && toolContent.every(c => c.type === 'text')) {
                            toolContent = toolContent.map(c => c.text).join('\n');
                        }
                    }
                    messages.push({
                        role: 'tool',
                        tool_call_id: callId,
                        name: callIdToName[callId] || 'unknown',
                        content: toolContent
                    });
                    if (pendingToolCallIds?.size > 0 && callId) {
                        pendingToolCallIds.delete(callId);
                        if (pendingToolCallIds.size === 0) {
                            pendingToolCallIds = null;
                            flushDeferredMessages();
                        }
                    }
                }
            }
        }
        if (pendingToolCalls) {
            ensurePendingToolCallsFlushed();
        }
        flushDeferredMessages();
    } else if (typeof parsed.input === 'string') {
        messages.push({ role: 'user', content: parsed.input });
    }

    const body = {
        model: parsed.model || 'gpt-4o',
        messages,
        stream: false
    };

    if (parsed.max_output_tokens) body.max_completion_tokens = parsed.max_output_tokens;
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

    body.messages = applyDeepSeekReasoningToChatMessages(body.messages, parsed.input);

    return body;
}

function _chatToResponsesFormat(chatResponse, model) {
    const choice = chatResponse.choices?.[0];
    const msg = choice?.message || {};
    const output = [];

    // Reasoning content (DeepSeek thinking models, GLM reasoners) — surface as a
    // Responses-API reasoning item so the Codex client can preserve it in
    // conversation history. Other providers (OpenAI/Azure/Gemini) don't return
    // this field on chat-completions, so this branch naturally no-ops for them.
    if (msg.reasoning_content) {
        output.push({
            type: 'reasoning',
            id: `rs_${Date.now()}`,
            summary: [{ type: 'summary_text', text: String(msg.reasoning_content) }]
        });
    }

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

async function _handleResponsesViaAssignedAntigravityAccount(res, parsed, modelId, isStreaming, startTime, email) {
    return _handleResponsesViaAntigravityAccount(res, parsed, modelId, isStreaming, startTime, email);
}

function normalizeCompactResponse(responseBody, modelId) {
    let parsed;
    try {
        parsed = JSON.parse(responseBody);
    } catch {
        return null;
    }

    if (parsed && parsed.object === 'response') {
        return parsed;
    }

    if (parsed && Array.isArray(parsed.choices)) {
        return _chatToResponsesFormat(parsed, modelId);
    }

    if (parsed && Array.isArray(parsed.content) && parsed.usage) {
        return _anthropicToResponsesFormat(parsed, modelId);
    }

    return parsed;
}

function resolveResponsesStreamingMode(isCompact, parsed) {
    if (isCompact) return false;
    return parsed ? parsed.stream !== false : true;
}

function normalizeAssignedFailureReason(value, fallback = 'request_failed') {
    const text = String(value || '').trim();
    return text || fallback;
}

function extractUpstreamErrorMessage(responseBody, statusCode) {
    if (responseBody) {
        try {
            const parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
            const msg = parsed?.error?.message || parsed?.message || parsed?.error?.code || parsed?.error?.type;
            if (msg) return String(msg).slice(0, 200);
        } catch {}
        const text = String(responseBody).trim();
        if (text) return text.slice(0, 200);
    }
    return statusCode ? `http_${statusCode}` : 'request_failed';
}

function recordAssignmentUpstreamError(assignment, info) {
    if (!assignment || !info) return;
    if (!Array.isArray(assignment.upstreamErrors)) assignment.upstreamErrors = [];
    assignment.upstreamErrors.push(info);
}

function formatUpstreamErrorReason(info) {
    if (!info) return '';
    const provider = info.provider || 'upstream';
    const status = info.status ? `_${info.status}` : '';
    const message = info.message ? `: ${info.message}` : '';
    return `${provider}${status}${message}`;
}

function resolveAssignedCredentialRuntimeReason(candidate) {
    const targetId = candidate?.credential?.email || candidate?.credential?.id || candidate?.binding?.targetId || '';
    if (!candidate?.credentialType || !targetId) return '';
    const runtime = getCredentialRuntimeState(buildCredentialId(candidate.credentialType, targetId));
    if (!runtime || runtime.status === 'active') return '';
    return runtime.lastError || runtime.status || '';
}

function getAssignedFailureReason(assignment, fallback = 'request_failed') {
    // Per-request upstream errors (set by _handleResponsesViaAssignedApiKey when the upstream
    // returns a non-OK response) take priority — these contain the actual provider error
    // message instead of the misleading "resolved" credential-lookup state.
    const upstreamErrors = Array.isArray(assignment?.upstreamErrors) ? assignment.upstreamErrors : [];
    if (upstreamErrors.length > 0) {
        const formatted = formatUpstreamErrorReason(upstreamErrors[upstreamErrors.length - 1]);
        if (formatted) return normalizeAssignedFailureReason(formatted, fallback);
    }
    const candidates = Array.isArray(assignment?.assignments) ? assignment.assignments : [];
    for (const candidate of candidates) {
        const runtimeReason = resolveAssignedCredentialRuntimeReason(candidate);
        if (runtimeReason) return normalizeAssignedFailureReason(runtimeReason, fallback);
    }
    return normalizeAssignedFailureReason(assignment?.unavailableReason, fallback);
}

function providerSupportsNativeResponses(provider) {
    return typeof provider?.sendResponsesRequest === 'function';
}

function buildNativeResponsesForwardHeaders(sourceHeaders = {}) {
    const headers = {};
    const candidates = [
        'x-client-request-id',
        'session_id',
        'x-codex-turn-state',
        'x-openai-subagent',
        'x-codex-window-id',
        'x-codex-parent-thread-id',
        'x-codex-turn-metadata',
        'x-codex-installation-id',
        'x-codex-beta-features',
        'x-responsesapi-include-timing-metrics',
        'openai-beta'
    ];

    for (const name of candidates) {
        const value = sourceHeaders?.[name];
        if (value !== undefined && value !== null && value !== '') {
            headers[name] = value;
        }
    }

    return headers;
}

function summarizeResponseOutputTypes(responsesFormat) {
    const items = Array.isArray(responsesFormat?.output) ? responsesFormat.output : [];
    if (items.length === 0) return '(none)';

    const counts = new Map();
    for (const item of items) {
        const type = item?.type || 'unknown';
        counts.set(type, (counts.get(type) || 0) + 1);
    }

    return [...counts.entries()]
        .map(([type, count]) => count > 1 ? `${type}x${count}` : type)
        .join(', ');
}

async function sendViaNativeResponsesProvider(provider, parsed, modelId, requestHeaders = {}) {
    const mappedModel = resolveModel(provider.type, modelId);
    const requestBody = {
        ...parsed,
        model: mappedModel,
        stream: false
    };
    const response = await provider.sendResponsesRequest(requestBody, {
        headers: buildNativeResponsesForwardHeaders(requestHeaders)
    });
    const responseBody = await response.text();
    const normalized = normalizeCompactResponse(responseBody, modelId);
    return { mappedModel, response, responseBody, normalized };
}

/**
 * Handle /responses via API key pool (with format conversion).
 */
async function _handleResponsesViaApiKey(res, parsed, modelId, isStreaming, keyTypes, startTime, requestHeaders = {}) {
    const MAX_KEY_RETRIES = 3;
    let fatalRequestError = false;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
        for (const type of keyTypes) {
            const provider = selectKey(type);
            if (!provider) continue;

            try {
                let mappedModel;
                let response;
                let responseBody;
                let responsesFormat;
                if (providerSupportsNativeResponses(provider)) {
                    mappedModel = resolveModel(type, modelId);
                    logger.info(`[Codex] >>> API KEY RESPONSES | ${type}/${provider.name} | ${modelId}→${mappedModel}`);
                    ({ mappedModel, response, responseBody, normalized: responsesFormat } = await sendViaNativeResponsesProvider(provider, parsed, modelId, requestHeaders));
                } else {
                    const chatBody = _responsesToChatBody(parsed);
                    mappedModel = resolveModel(type, modelId);
                    const mappedBody = isDeepSeekProviderType(type)
                        ? normalizeDeepSeekRequestBody({ ...chatBody, model: mappedModel })
                        : { ...chatBody, model: mappedModel };
                    const toolSequenceError = findToolCallSequenceError(mappedBody.messages);
                    if (toolSequenceError) {
                        logger.warn(`[Codex Proxy] Invalid tool-call sequence before API key request | provider=${type}/${provider.name} | assistant_index=${toolSequenceError.assistantIndex} | next_role=${toolSequenceError.nextRole} | missing=${toolSequenceError.missingIds.join(',')} | window=${toolSequenceError.window.join(' || ')}`);
                    }
                    logger.info(`[Codex] >>> API KEY | ${type}/${provider.name} | ${modelId}→${mappedModel}`);
                    response = await provider.sendRequest(mappedBody);
                    responseBody = await response.text();
                }
                const durationMs = Date.now() - startTime;

                if (response.status === 429) {
                    const retryAfter = response.headers?.get?.('retry-after');
                    recordRateLimit(provider.id, retryAfter ? parseInt(retryAfter) * 1000 : 60000);
                    markCredentialRateLimited(buildCredentialId('api-key', provider.id), retryAfter ? parseInt(retryAfter) * 1000 : 60000, {
                        model: mappedModel
                    });
                    logger.warn(`[Codex Proxy] API key rate limited: ${provider.name}`);
                    continue;
                }
                if (response.status === 401 || response.status === 403) {
                    recordError(provider.id);
                    markCredentialError(buildCredentialId('api-key', provider.id), `auth_error_${response.status}`, {
                        model: mappedModel,
                        invalid: true
                    });
                    continue;
                }

                if (!response.ok) {
                    if (response.status === 400) {
                        fatalRequestError = true;
                    }
                    recordError(provider.id);
                    markCredentialError(buildCredentialId('api-key', provider.id), `http_${response.status}`, {
                        model: mappedModel
                    });
                    recordRequest({ provider: type, keyId: provider.id, model: mappedModel, durationMs, success: false, error: responseBody.slice(0, 200) });
                    logRequest({ route: '/responses', provider: type, keyId: provider.id, model: modelId, mappedModel, requestBody: parsed, responseBody, durationMs, status: response.status, success: false, error: responseBody.slice(0, 200) });
                    logger.warn(`[Codex Proxy] API key error ${response.status}: ${provider.name} - ${responseBody.slice(0, 200)}`);
                    continue; // Try next provider instead of returning error
                }

                if (!responsesFormat) {
                    let chatResponse;
                    try { chatResponse = JSON.parse(responseBody); } catch {
                        res.status(200).type('json').send(responseBody);
                        return;
                    }
                    responsesFormat = _chatToResponsesFormat(chatResponse, modelId);
                }

                if (providerSupportsNativeResponses(provider)) {
                    logger.info(`[Codex] Native responses output | ${type}/${provider.name} | ${summarizeResponseOutputTypes(responsesFormat)}`);
                }

                const inputTokens = responsesFormat.usage?.input_tokens || 0;
                const outputTokens = responsesFormat.usage?.output_tokens || 0;
                const cost = provider.estimateCost(mappedModel, inputTokens, outputTokens);
                recordUsage(provider.id, { inputTokens, outputTokens, model: mappedModel });
                markCredentialSuccess(buildCredentialId('api-key', provider.id), {
                    model: mappedModel,
                    latencyMs: durationMs
                });
                recordRequest({ provider: type, keyId: provider.id, model: mappedModel, inputTokens, outputTokens, cost, durationMs, success: true });
                logRequest({ route: '/responses', provider: type, keyId: provider.id, model: modelId, mappedModel, requestBody: parsed, responseBody, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });

                logger.success(`[Codex] <<< API KEY OK | ${type}/${provider.name} | model=${modelId} | ${durationMs}ms`);

                if (providerSupportsNativeResponses(provider)) {
                    copyAllowedResponseHeaders(response, res);
                }
                if (isStreaming) {
                    sendResponsesSSE(res, responsesFormat);
                } else {
                    res.json(maybeInjectFromLocals(res, responsesFormat));
                }
                return;
            } catch (error) {
                recordError(provider.id);
                markCredentialError(buildCredentialId('api-key', provider.id), error, { model: modelId });
                recordRequest({ provider: type, keyId: provider.id, model: modelId, durationMs: Date.now() - startTime, success: false, error: error.message });
                logger.error(`[Codex Proxy] API key error: ${provider.name} - ${error.message}`);
                continue;
            }
        }
        if (fatalRequestError) break;
    }
    return false;
}

/**
 * Handle /responses via ChatGPT account pool (original logic).
 * Returns false if all accounts exhausted.
 */
async function _handleResponsesViaAccountPool(req, res, rawBody, contentEncoding, modelId, isStreaming, startTime, isCompact = false) {
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
            copyAllowedRequestHeaders(req.headers, upstreamHeaders);
            if (contentEncoding) {
                upstreamHeaders['Content-Encoding'] = contentEncoding;
            }

            const targetUrl = isCompact ? UPSTREAM_COMPACT_URL : UPSTREAM_URL;
            const upstreamResponse = await fetch(targetUrl, {
                method: 'POST',
                headers: upstreamHeaders,
                body: rawBody
            });

            if (!upstreamResponse.ok) {
                const errorText = await upstreamResponse.text();

                if (upstreamResponse.status === 401) {
                    rotator.markInvalid(creds.email, 'Token expired');
                    rotator.notifyFailure(account, modelId);
                    markCredentialError(buildCredentialId('chatgpt-account', creds.email), 'AUTH_EXPIRED', {
                        model: modelId,
                        invalid: true
                    });
                    logger.warn(`[Codex] Auth expired for ${creds.email}, trying next...`);
                    continue;
                }

                if (upstreamResponse.status === 429) {
                    const resetMs = parseResetTime(upstreamResponse, errorText);
                    rotator.markRateLimited(creds.email, resetMs, modelId);
                    rotator.notifyRateLimit(account, modelId);
                    markCredentialRateLimited(buildCredentialId('chatgpt-account', creds.email), resetMs, {
                        model: modelId
                    });

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
                markCredentialError(buildCredentialId('chatgpt-account', creds.email), `http_${upstreamResponse.status}`, {
                    model: modelId
                });
                recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: Date.now() - startTime, success: false, error: errorText.slice(0, 200) });
                logRequest({ route: '/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: Date.now() - startTime, status: upstreamResponse.status, success: false, error: errorText.slice(0, 200) });
                return res.status(upstreamResponse.status)
                    .set('Content-Type', 'application/json')
                    .send(errorText);
            }

            // Success
            rotator.notifySuccess(account, modelId);
            copyAllowedResponseHeaders(upstreamResponse, res);

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
                if (isCompact) {
                    const normalized = normalizeCompactResponse(responseBody, modelId);
                    if (!normalized) {
                        logger.error(`[Codex Proxy] Invalid compact response body from upstream for model=${modelId}`);
                        return res.status(502).json({ error: { message: 'Invalid compact response from upstream.' } });
                    }
                    res.json(normalized);
                } else {
                    res.send(responseBody);
                }
            }

            const duration = Date.now() - startTime;
            markCredentialSuccess(buildCredentialId('chatgpt-account', creds.email), {
                model: modelId,
                latencyMs: duration
            });
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
            markCredentialError(buildCredentialId('chatgpt-account', creds.email), error, {
                model: modelId
            });
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
    return getUsableClaudeAccounts();
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
                    content = item.content.map(c => {
                        if (c.type === 'text') {
                            return { type: 'text', text: c.text || '' };
                        } else if (c.type === 'input_image' || c.type === 'image') {
                            if (c.data) {
                                return {
                                    type: 'image',
                                    source: { type: 'base64', media_type: c.media_type || 'image/jpeg', data: c.data }
                                };
                            }
                            const url = c.image_url || c.url;
                            if (url) {
                                const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
                                if (base64Match) {
                                    return {
                                        type: 'image',
                                        source: { type: 'base64', media_type: base64Match[1], data: base64Match[2] }
                                    };
                                }
                                return { type: 'image', source: { type: 'url', url } };
                            }
                            return null;
                        } else if (c.text) {
                            return { type: 'text', text: c.text };
                        }
                        return null;
                    }).filter(Boolean);
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
                let toolContent = item.output || '';
                if (Array.isArray(toolContent)) {
                    toolContent = toolContent.map(c => {
                        if (c.type === 'text') return { type: 'text', text: c.text || '' };
                        if (c.type === 'input_image' || c.type === 'image') {
                            if (c.data) {
                                return { type: 'image', source: { type: 'base64', media_type: c.media_type || 'image/jpeg', data: c.data } };
                            }
                            const url = c.image_url || c.url;
                            if (url) {
                                const b64 = url.match(/^data:([^;]+);base64,(.+)$/);
                                if (b64) return { type: 'image', source: { type: 'base64', media_type: b64[1], data: b64[2] } };
                                return { type: 'image', source: { type: 'url', url } };
                            }
                            return null;
                        }
                        if (c.text) return { type: 'text', text: c.text };
                        return null;
                    }).filter(Boolean);
                }
                pendingToolResults.push({
                    type: 'tool_result',
                    tool_use_id: item.call_id || item.id || '',
                    content: toolContent
                });
            } else if (item.type === 'input_image') {
                // Top-level input_image - wrap in a user message
                let imageBlock = null;
                if (item.data) {
                    imageBlock = { type: 'image', source: { type: 'base64', media_type: item.media_type || 'image/jpeg', data: item.data } };
                } else {
                    const url = item.image_url || item.url;
                    if (url) {
                        const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
                        if (base64Match) {
                            imageBlock = { type: 'image', source: { type: 'base64', media_type: base64Match[1], data: base64Match[2] } };
                        } else {
                            imageBlock = { type: 'image', source: { type: 'url', url } };
                        }
                    }
                }
                if (imageBlock) {
                    if (pendingToolResults.length > 0) {
                        messages.push({ role: 'user', content: pendingToolResults.splice(0) });
                    }
                    messages.push({ role: 'user', content: [imageBlock] });
                }
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
                input_schema: normalizeJsonSchema(t.parameters || { type: 'object', properties: {} })
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
        advanceUsableAccountsRotation(account.email);
        try {
            const mappedModel = anthropicBody.model;
            logger.info(`[Codex] >>> Claude account | ${account.email} | ${modelId}→${mappedModel}`);

            const { data: claudeResponse, rateLimitHeaders } = await sendClaudeMessageWithMeta(anthropicBody, account.accessToken);
            recordClaudeRuntimeObservation(account.email, rateLimitHeaders, { model: mappedModel });
            const durationMs = Date.now() - startTime;

            const responsesFormat = _anthropicToResponsesFormat(claudeResponse, modelId);

            const inputTokens = claudeResponse.usage?.input_tokens || 0;
            const outputTokens = claudeResponse.usage?.output_tokens || 0;
            markCredentialSuccess(buildCredentialId('claude-account', account.email), {
                model: mappedModel,
                latencyMs: durationMs
            });
            recordRequest({ provider: 'claude-pool', keyId: account.email, model: mappedModel, inputTokens, outputTokens, durationMs, success: true });
            logRequest({ route: '/responses', provider: 'claude-pool', keyId: account.email, model: modelId, mappedModel, requestBody: parsed, inputTokens, outputTokens, durationMs, status: 200, success: true });

            logger.success(`[Codex] <<< Claude account OK | ${account.email} | model=${modelId} | ${inputTokens}+${outputTokens} tokens | ${durationMs}ms`);

            if (isStreaming) {
                sendResponsesSSE(res, responsesFormat);
            } else {
                res.json(maybeInjectFromLocals(res, responsesFormat));
            }
            return true;
        } catch (error) {
            const durationMs = Date.now() - startTime;
            recordClaudeRuntimeObservation(account.email, error.rateLimitHeaders, { model: anthropicBody.model });
            if (error.message.includes('AUTH_EXPIRED')) {
                logger.warn(`[Codex] Claude account auth expired: ${account.email}, attempting token refresh...`);
                try {
                    const refreshResult = await refreshAccountToken(account.email);
                    if (refreshResult.success) {
                        const refreshed = getClaudeAccount(account.email);
                        if (refreshed && refreshed.accessToken) {
                            logger.info(`[Codex] Token refreshed for ${account.email}, retrying...`);
                            const { data: retryResponse, rateLimitHeaders } = await sendClaudeMessageWithMeta(anthropicBody, refreshed.accessToken);
                            recordClaudeRuntimeObservation(account.email, rateLimitHeaders, { model: anthropicBody.model });
                            const retryDurationMs = Date.now() - startTime;
                            const responsesFormat = _anthropicToResponsesFormat(retryResponse, modelId);
                            const inputTokens = retryResponse.usage?.input_tokens || 0;
                            const outputTokens = retryResponse.usage?.output_tokens || 0;
                            markCredentialSuccess(buildCredentialId('claude-account', account.email), {
                                model: anthropicBody.model,
                                latencyMs: retryDurationMs
                            });
                            recordRequest({ provider: 'claude-pool', keyId: account.email, model: anthropicBody.model, inputTokens, outputTokens, durationMs: retryDurationMs, success: true });
                            logger.success(`[Codex] <<< Claude account OK (after refresh) | ${account.email} | model=${modelId} | ${inputTokens}+${outputTokens} tokens | ${retryDurationMs}ms`);
                            if (isStreaming) { sendResponsesSSE(res, responsesFormat); } else { res.json(maybeInjectFromLocals(res, responsesFormat)); }
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
                const parts = error.message.split(':');
                const waitMs = Number(parts[1]) || 60000;
                markCredentialRateLimited(buildCredentialId('claude-account', account.email), waitMs, {
                    model: anthropicBody.model
                });
                logger.warn(`[Codex] Claude account rate limited: ${account.email}`);
                continue;
            }
            markCredentialError(buildCredentialId('claude-account', account.email), error, {
                model: modelId,
                invalid: error.message.includes('AUTH_EXPIRED')
            });
            recordRequest({ provider: 'claude-pool', keyId: account.email, model: modelId, durationMs, success: false, error: error.message });
            logger.error(`[Codex] Claude account error: ${account.email} - ${error.message}`);
            continue;
        }
    }

    return false;
}

async function _handleResponsesViaAntigravityAccount(res, parsed, modelId, isStreaming, startTime, preferredEmail = null) {
    const accounts = getAntigravityAccountsForModel(modelId, preferredEmail)
        .filter((account) => account?.accessToken && account?.projectId);
    if (accounts.length === 0) return false;

    for (const account of accounts) {
        advanceAntigravityAccountsRotation(modelId, account.email, preferredEmail);
        try {
            const anthropicBody = _responsesToAnthropicBody(parsed);
            anthropicBody.model = modelId;
            const antigravityResponse = await sendAntigravityMessage(anthropicBody, account, { modelOverride: modelId });
            const responsesFormat = _anthropicToResponsesFormat(antigravityResponse, modelId);
            const durationMs = Date.now() - startTime;
            recordRequest({
                provider: 'antigravity',
                keyId: account.email,
                model: modelId,
                inputTokens: antigravityResponse.usage?.input_tokens || 0,
                outputTokens: antigravityResponse.usage?.output_tokens || 0,
                durationMs,
                success: true
            });
            markCredentialSuccess(buildCredentialId('antigravity-account', account.email), {
                model: modelId,
                latencyMs: durationMs
            });
            logRequest({
                route: '/responses',
                provider: 'antigravity',
                keyId: account.email,
                model: modelId,
                mappedModel: modelId,
                requestBody: parsed,
                inputTokens: antigravityResponse.usage?.input_tokens || 0,
                outputTokens: antigravityResponse.usage?.output_tokens || 0,
                durationMs,
                status: 200,
                success: true
            });
            if (isStreaming) sendResponsesSSE(res, responsesFormat); else res.json(maybeInjectFromLocals(res, responsesFormat));
            return true;
        } catch (error) {
            markCredentialError(buildCredentialId('antigravity-account', account.email), error, {
                model: modelId
            });
            logger.error(`[Responses] Antigravity error: ${account.email} - ${error.message}`);
        }
    }

    return false;
}

export const _testExports = {
    normalizeCompactResponse,
    _responsesToChatBody: _responsesToChatBody,
    _responsesToAnthropicBody,
    _chatToResponsesFormat,
    buildNativeResponsesForwardHeaders,
    copyAllowedResponseHeaders,
    findToolCallSequenceError,
    resolveResponsesStreamingMode,
    getAssignedFailureReason,
    normalizeAssignedFailureReason
};

export default { handleResponses };
