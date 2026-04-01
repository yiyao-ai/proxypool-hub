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
import { loadAccounts as loadClaudeAccounts, refreshAccountToken, getAccount as getClaudeAccount } from '../claude-account-manager.js';
import { sendClaudeMessage, mapToClaudeModel } from '../claude-api.js';
import { listAccounts as listAntigravityAccounts, getAvailableAccountForModel as getAntigravityAccountForModel, getAllModels as getAllAntigravityModels } from '../antigravity-account-manager.js';
import { sendAntigravityMessage, isAntigravityModel } from '../antigravity-api.js';
import { getCredentialsForAccount } from '../middleware/credentials.js';
import { logger } from '../utils/logger.js';
import { getServerSettings } from '../server-settings.js';
import { fetchModels } from '../model-api.js';
import { selectKey, recordUsage, recordError, recordRateLimit, hasKeysForTypes, getKeyRateLimitInfo, getAllProviders } from '../api-key-manager.js';
import { recordRequest } from '../usage-tracker.js';
import { sendResponsesSSE } from '../utils/responses-sse.js';
import { resolveModel } from '../model-mapping.js';
import { logRequest } from '../request-logger.js';
import { detectRequestApp, resolveAssignedCredential } from '../app-routing.js';
import { getDiscoveredModels } from '../model-discovery.js';

const UPSTREAM_BASE = 'https://chatgpt.com/backend-api';
const MAX_RETRIES = 5;
const MAX_WAIT_BEFORE_ERROR_MS = 120000;
const SHORT_RATE_LIMIT_THRESHOLD_MS = 5000;
const PASSTHROUGH_REQUEST_HEADER_WHITELIST = [
    'x-client-request-id',
    'x-openai-subagent',
    'x-codex-turn-state'
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

function getStrictNativeCodexModels() {
    const providers = getAllProviders().filter(provider =>
        provider?.enabled !== false && (provider.type === 'openai' || provider.type === 'azure-openai')
    );
    const discovered = getDiscoveredModels();
    const seen = new Set();
    const models = [];

    for (const providerType of ['openai', 'azure-openai']) {
        const providerModels = discovered.providers?.[providerType]?.models || [];
        for (const model of providerModels) {
            if (!model?.id || seen.has(model.id)) continue;
            seen.add(model.id);
            models.push({
                slug: model.id,
                name: model.name || model.id,
                tags: providerType === 'azure-openai' ? ['azure-openai'] : ['openai']
            });
        }
    }

    for (const provider of providers) {
        if (provider.type === 'azure-openai' && provider.deploymentName && !seen.has(provider.deploymentName)) {
            seen.add(provider.deploymentName);
            models.push({
                slug: provider.deploymentName,
                name: provider.deploymentName,
                tags: ['azure-openai']
            });
        }
    }

    if (models.length === 0 && providers.some(provider => provider.type === 'openai')) {
        for (const modelId of ['gpt-4o', 'gpt-4o-mini', 'gpt-5.2']) {
            if (seen.has(modelId)) continue;
            seen.add(modelId);
            models.push({ slug: modelId, name: modelId, tags: ['openai'] });
        }
    }

    return models;
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
 * POST /backend-api/codex/responses
 * Transparent proxy with account rotation for Codex CLI.
 * Falls back to API key pool when no accounts are available.
 */
export async function handleCodexResponses(req, res) {
    const startTime = Date.now();
    const body = req.body;
    const modelId = body.model || 'gpt-5.2';
    const isStreaming = body.stream !== false;
    const rawBody = Buffer.isBuffer(req.rawBody) ? req.rawBody : null;

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
    const strictCodexCompatibility = settings.strictCodexCompatibility !== false;
    const appId = detectRequestApp(req);
    const priority = settings.routingPriority || 'account-first';
    const hasAccounts = listAccounts().total > 0;
    const apiKeyTypes = ['openai', 'azure-openai', 'gemini', 'vertex-ai'];
    const hasApiKeys = hasKeysForTypes(apiKeyTypes);
    const hasClaudeAccounts = _getUsableClaudeAccounts().length > 0;
    const hasAntigravityAccounts = settings.antigravityEnabled !== false && listAntigravityAccounts().total > 0;

    if (settings.routingMode === 'app-assigned') {
        const assignment = resolveAssignedCredential(settings, appId);
        if (assignment.matched) {
            const result = await _handleCodexAssignment(req, res, body, modelId, isStreaming, startTime, assignment);
            if (result !== false) return;
            if (!assignment.fallbackToDefault) {
                return sendCodexError(res, 503, `Assigned credential unavailable for ${appId}: ${assignment.unavailableReason || 'request_failed'}`);
            }
        }
    }

    if (!strictCodexCompatibility && hasAntigravityAccounts && isAntigravityModel(modelId)) {
        const result = await _handleCodexViaAntigravityAccount(res, body, modelId, isStreaming, startTime);
        if (result !== false) return;
    }

    if (priority === 'apikey-first' && hasApiKeys) {
        const result = await _handleCodexViaApiKey(res, body, modelId, isStreaming, apiKeyTypes, startTime);
        if (result !== false) return;
        if (hasAccounts) {
            const poolResult = await _handleCodexViaAccountPool(req, res, body, rawBody, modelId, isStreaming, startTime);
            if (poolResult !== false) return;
        }
        if (!strictCodexCompatibility && hasClaudeAccounts) {
            const claudeResult = await _handleCodexViaClaudeAccount(res, body, modelId, isStreaming, startTime);
            if (claudeResult !== false) return;
        }
        if (!strictCodexCompatibility && hasAntigravityAccounts) {
            const antigravityResult = await _handleCodexViaAntigravityAccount(res, body, modelId, isStreaming, startTime);
            if (antigravityResult !== false) return;
        }
        return sendCodexError(res, 503, 'All API keys and accounts exhausted.');
    }

    // account-first (default)
    if (hasAccounts) {
        const poolResult = await _handleCodexViaAccountPool(req, res, body, rawBody, modelId, isStreaming, startTime);
        if (poolResult !== false) return;
    }
    if (hasApiKeys) {
        const result = await _handleCodexViaApiKey(res, body, modelId, isStreaming, apiKeyTypes, startTime);
        if (result !== false) return;
    }
    if (!strictCodexCompatibility && hasClaudeAccounts) {
        const claudeResult = await _handleCodexViaClaudeAccount(res, body, modelId, isStreaming, startTime);
        if (claudeResult !== false) return;
    }
    if (!strictCodexCompatibility && hasAntigravityAccounts) {
        const antigravityResult = await _handleCodexViaAntigravityAccount(res, body, modelId, isStreaming, startTime);
        if (antigravityResult !== false) return;
    }

    if (!hasAccounts && !hasApiKeys && !hasClaudeAccounts && !hasAntigravityAccounts) {
        return sendCodexError(res, 401, 'No accounts or API keys configured. Add them in the dashboard.');
    }
    const rlInfo = getKeyRateLimitInfo(apiKeyTypes);
    if (rlInfo.allRateLimited) {
        const waitSec = Math.ceil(rlInfo.minWaitMs / 1000);
        return sendCodexError(res, 429, `All API keys are rate-limited. Try again in ${waitSec}s.`);
    }
    return sendCodexError(res, 503, 'All accounts and API keys exhausted.');
}

async function _handleCodexAssignment(req, res, body, modelId, isStreaming, startTime, assignment) {
    if (!assignment.credential) return false;

    if (assignment.credentialType === 'chatgpt-account') {
        return _handleCodexViaAssignedAccount(req, res, body, modelId, isStreaming, startTime, assignment.credential.email);
    }
    if (assignment.credentialType === 'claude-account') {
        return _handleCodexViaAssignedClaudeAccount(res, body, modelId, isStreaming, startTime, assignment.credential.email);
    }
    if (assignment.credentialType === 'antigravity-account') {
        return _handleCodexViaAssignedAntigravityAccount(res, body, modelId, isStreaming, startTime, assignment.credential.email);
    }
    return _handleCodexViaAssignedApiKey(res, body, modelId, isStreaming, startTime, assignment.credential);
}

async function _handleCodexViaAssignedApiKey(res, body, modelId, isStreaming, startTime, provider) {
    try {
        let mappedModel;
        let response;
        let responseBody;
        let codexResponse;

        if (providerSupportsNativeResponses(provider)) {
            ({ mappedModel, response, responseBody, normalized: codexResponse } = await sendViaNativeResponsesProvider(provider, body, modelId));
        } else {
            const chatBody = _codexToChatBody(body);
            mappedModel = resolveModel(provider.type, modelId);
            const mappedBody = { ...chatBody, model: mappedModel };
            response = await provider.sendRequest(mappedBody);
            responseBody = await response.text();
            const chatResponse = JSON.parse(responseBody);
            codexResponse = _chatToCodexResponse(chatResponse, modelId);
        }
        if (!response.ok || !codexResponse) return false;
        if (providerSupportsNativeResponses(provider)) {
            logger.info(`[Codex] Native responses output | ${provider.type}/${provider.name} | ${summarizeResponseOutputTypes(codexResponse)}`);
        }
        const durationMs = Date.now() - startTime;
        const inputTokens = codexResponse.usage?.input_tokens || 0;
        const outputTokens = codexResponse.usage?.output_tokens || 0;
        const cost = provider.estimateCost(mappedModel, inputTokens, outputTokens);
        recordUsage(provider.id, { inputTokens, outputTokens, model: mappedModel });
        recordRequest({ provider: provider.type, keyId: provider.id, model: mappedModel, inputTokens, outputTokens, cost, durationMs, success: true });
        logRequest({ route: '/backend-api/codex/responses', provider: provider.type, keyId: provider.id, model: modelId, mappedModel, requestBody: body, responseBody, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });
        if (isStreaming) sendResponsesSSE(res, codexResponse); else res.json(codexResponse);
        return true;
    } catch {
        return false;
    }
}

async function _handleCodexViaAssignedAccount(req, res, body, modelId, isStreaming, startTime, email) {
    const creds = await getCredentialsForAccount(email);
    if (!creds) return false;

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
            res.send(responseBody);
        }

        const duration = Date.now() - startTime;
        recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: true });
        logRequest({ route: '/backend-api/codex/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, status: 200, success: true });
        return true;
    } catch {
        return false;
    }
}

async function _handleCodexViaAssignedClaudeAccount(res, body, modelId, isStreaming, startTime, email) {
    const account = getClaudeAccount(email);
    if (!account?.accessToken || account.enabled === false) return false;
    const anthropicBody = _codexToAnthropicBody(body);

    try {
        const claudeResponse = await sendClaudeMessage(anthropicBody, account.accessToken);
        const durationMs = Date.now() - startTime;
        const codexFormat = _anthropicToCodexFormat(claudeResponse, modelId);
        const inputTokens = claudeResponse.usage?.input_tokens || 0;
        const outputTokens = claudeResponse.usage?.output_tokens || 0;
        recordRequest({ provider: 'claude-pool', keyId: account.email, model: anthropicBody.model, inputTokens, outputTokens, durationMs, success: true });
        logRequest({ route: '/backend-api/codex/responses', provider: 'claude-pool', keyId: account.email, model: modelId, mappedModel: anthropicBody.model, requestBody: body, inputTokens, outputTokens, durationMs, status: 200, success: true });
        if (isStreaming) sendResponsesSSE(res, codexFormat); else res.json(codexFormat);
        return true;
    } catch {
        return false;
    }
}

// ─── Codex Responses API ↔ Chat Completions format converters ─────────────────

function _codexToChatBody(body) {
    const messages = [];

    if (body.instructions) {
        messages.push({ role: 'system', content: body.instructions });
    }

    const convertBlock = (c) => {
        if (!c) return null;
        if (c.type === 'text' || (c.text && c.type !== 'input_image')) {
            return { type: 'text', text: c.text || '' };
        }
        if (c.type === 'input_image' || c.type === 'image') {
            if (c.data) {
                return { type: 'image_url', image_url: { url: `data:${c.media_type || 'image/jpeg'};base64,${c.data}` } };
            }
            if (c.image_url) {
                return { type: 'image_url', image_url: { url: c.image_url } };
            }
            if (c.url) {
                return { type: 'image_url', image_url: { url: c.url } };
            }
            return null;
        }
        if (c.type === 'image_url' || c.image_url) {
            return { type: 'image_url', image_url: c.image_url || { url: c.url } };
        }
        return null;
    };

    if (Array.isArray(body.input)) {
        const callIdToName = {};
        for (const item of body.input) {
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

        for (const item of body.input) {
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
                        pendingToolCalls = {
                            role: 'assistant',
                            content: null,
                            tool_calls: []
                        };
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
    } else if (typeof body.input === 'string') {
        messages.push({ role: 'user', content: body.input });
    }

    const chatBody = {
        model: body.model || 'gpt-4o',
        messages,
        stream: false
    };

    if (body.max_output_tokens) chatBody.max_completion_tokens = body.max_output_tokens;
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

async function _handleCodexViaAssignedAntigravityAccount(res, body, modelId, isStreaming, startTime, email) {
    return _handleCodexViaAntigravityAccount(res, body, modelId, isStreaming, startTime, email);
}

function normalizeProviderCodexResponse(responseBody, modelId) {
    let parsed;
    try {
        parsed = JSON.parse(responseBody);
    } catch {
        return null;
    }

    if (parsed?.object === 'response') {
        return parsed;
    }

    if (Array.isArray(parsed?.choices)) {
        return _chatToCodexResponse(parsed, modelId);
    }

    return null;
}

function providerSupportsNativeResponses(provider) {
    return typeof provider?.sendResponsesRequest === 'function';
}

function summarizeResponseOutputTypes(codexResponse) {
    const items = Array.isArray(codexResponse?.output) ? codexResponse.output : [];
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

async function sendViaNativeResponsesProvider(provider, body, modelId) {
    const mappedModel = resolveModel(provider.type, modelId);
    const requestBody = {
        ...body,
        model: mappedModel,
        stream: false
    };
    const response = await provider.sendResponsesRequest(requestBody);
    const responseBody = await response.text();
    const normalized = normalizeProviderCodexResponse(responseBody, modelId);
    return { mappedModel, response, responseBody, normalized };
}

/**
 * Handle /backend-api/codex/responses via API key pool (with format conversion).
 */
async function _handleCodexViaApiKey(res, body, modelId, isStreaming, keyTypes, startTime) {
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
                let codexResponse;
                if (providerSupportsNativeResponses(provider)) {
                    mappedModel = resolveModel(type, modelId);
                    logger.info(`[Codex] >>> API KEY RESPONSES | ${type}/${provider.name} | ${modelId}→${mappedModel}`);
                    ({ mappedModel, response, responseBody, normalized: codexResponse } = await sendViaNativeResponsesProvider(provider, body, modelId));
                } else {
                    const chatBody = _codexToChatBody(body);
                    mappedModel = resolveModel(type, modelId);
                    const mappedBody = { ...chatBody, model: mappedModel };
                    const toolSequenceError = findToolCallSequenceError(mappedBody.messages);
                    if (toolSequenceError) {
                        logger.warn(`[Codex Proxy] Invalid tool-call sequence before API key request | provider=${type}/${provider.name} | assistant_index=${toolSequenceError.assistantIndex} | next_role=${toolSequenceError.nextRole} | missing=${toolSequenceError.missingIds.join(',')} | window=${toolSequenceError.window.join(' || ')}`);
                    }
                    console.log(`[Codex Proxy] >>> API KEY fallback | ${type}/${provider.name} | ${modelId}→${mappedModel}`);
                    response = await provider.sendRequest(mappedBody);
                    responseBody = await response.text();
                }
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

                if (!response.ok) {
                    if (response.status === 400) {
                        fatalRequestError = true;
                    }
                    recordError(provider.id);
                    recordRequest({ provider: type, keyId: provider.id, model: mappedModel, durationMs, success: false, error: responseBody.slice(0, 200) });
                    logRequest({ route: '/backend-api/codex/responses', provider: type, keyId: provider.id, model: modelId, mappedModel, requestBody: body, responseBody, durationMs, status: response.status, success: false, error: responseBody.slice(0, 200) });
                    logger.warn(`[Codex] API key error ${response.status}: ${provider.name} - ${responseBody.slice(0, 200)}`);
                    continue;
                }

                if (!codexResponse) {
                    let chatResponse;
                    try { chatResponse = JSON.parse(responseBody); } catch {
                        res.status(200).type('json').send(responseBody);
                        return;
                    }
                    codexResponse = _chatToCodexResponse(chatResponse, modelId);
                }

                if (providerSupportsNativeResponses(provider)) {
                    logger.info(`[Codex] Native responses output | ${type}/${provider.name} | ${summarizeResponseOutputTypes(codexResponse)}`);
                }

                const inputTokens = codexResponse.usage?.input_tokens || 0;
                const outputTokens = codexResponse.usage?.output_tokens || 0;
                const cost = provider.estimateCost(mappedModel, inputTokens, outputTokens);
                recordUsage(provider.id, { inputTokens, outputTokens, model: mappedModel });
                recordRequest({ provider: type, keyId: provider.id, model: mappedModel, inputTokens, outputTokens, cost, durationMs, success: true });
                logRequest({ route: '/backend-api/codex/responses', provider: type, keyId: provider.id, model: modelId, mappedModel, requestBody: body, responseBody, inputTokens, outputTokens, cost, durationMs, status: 200, success: true });

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
        if (fatalRequestError) break;
    }
    return false;
}

/**
 * Handle /backend-api/codex/responses via ChatGPT account pool.
 * Returns false if all accounts exhausted.
 */
async function _handleCodexViaAccountPool(req, res, body, rawBody, modelId, isStreaming, startTime) {
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
            const payload = rawBody || Buffer.from(JSON.stringify(body));
            const upstreamResponse = await fetch(`${UPSTREAM_BASE}/codex/responses`, {
                method: 'POST',
                headers: (() => {
                    const upstreamHeaders = {
                    'Authorization': `Bearer ${creds.accessToken}`,
                    'ChatGPT-Account-ID': creds.accountId,
                    'Content-Type': req.headers['content-type'] || 'application/json',
                    'Accept': isStreaming ? 'text/event-stream' : 'application/json'
                    };
                    if (req.headers['content-encoding']) {
                        upstreamHeaders['Content-Encoding'] = req.headers['content-encoding'];
                    }
                    copyAllowedRequestHeaders(req.headers || {}, upstreamHeaders);
                    return upstreamHeaders;
                })(),
                body: payload
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
                recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: Date.now() - startTime, success: false, error: errorText.slice(0, 200) });
                logRequest({ route: '/backend-api/codex/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: Date.now() - startTime, status: upstreamResponse.status, success: false, error: errorText.slice(0, 200) });
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
            recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: true });
            logRequest({ route: '/backend-api/codex/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, status: 200, success: true });
            logger.success(`[Codex] <<< OK | account=${creds.email} | model=${modelId} | ${duration}ms`);
            return true;
        } catch (error) {
            if (res.headersSent) {
                const duration = Date.now() - startTime;
                recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: true });
                logRequest({ route: '/backend-api/codex/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, status: 200, success: true });
                logger.warn(`[Codex] Post-stream error (response already sent): ${error.message}`);
                return true;
            }
            const duration = Date.now() - startTime;
            recordRequest({ provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: false, error: error.message });
            logRequest({ route: '/backend-api/codex/responses', method: 'POST', provider: 'chatgpt-pool', keyId: creds.email, model: modelId, durationMs: duration, success: false, error: error.message });
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
    const antigravityModels = getAllAntigravityModels();
    const settings = getServerSettings();
    const strictCodexCompatibility = settings.strictCodexCompatibility !== false;

    if (!creds) {
        if (strictCodexCompatibility) {
            const models = getStrictNativeCodexModels();
            if (models.length > 0) {
                return res.json({ models });
            }
            return sendCodexError(res, 401, 'No native ChatGPT/OpenAI/Azure credentials available');
        }

        // No accounts — check for API keys and return a synthetic model list
        const apiKeyTypes = ['openai', 'azure-openai', 'gemini', 'vertex-ai'];
        const hasApiKeys = apiKeyTypes.some(t => !!selectKey(t));
        if (hasApiKeys || antigravityModels.length > 0) {
            return res.json({
                models: [
                    { slug: 'gpt-4o', name: 'GPT-4o (via API key)', tags: ['gpt4'] },
                    { slug: 'gpt-4o-mini', name: 'GPT-4o Mini (via API key)', tags: ['gpt4'] },
                    { slug: 'gpt-5.2', name: 'GPT-5.2 (via API key)', tags: ['gpt5'] },
                    ...antigravityModels.map((model) => ({ slug: model.id, name: model.description || model.id, tags: ['antigravity'] }))
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
        const parsed = JSON.parse(responseBody);
        if (!strictCodexCompatibility && Array.isArray(parsed?.models) && antigravityModels.length > 0) {
            const seen = new Set(parsed.models.map((model) => model.slug));
            for (const model of antigravityModels) {
                if (seen.has(model.id)) continue;
                parsed.models.push({ slug: model.id, name: model.description || model.id, tags: ['antigravity'] });
            }
            res.setHeader('Content-Type', 'application/json');
            return res.send(JSON.stringify(parsed));
        }
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

// ─── Claude Account Pool ──────────────────────────────────────────────────────

function _getUsableClaudeAccounts() {
    const data = loadClaudeAccounts();
    return data.accounts.filter(a =>
        a.enabled !== false &&
        a.accessToken &&
        !(a.expiresAt && a.expiresAt < Date.now())
    );
}

function _codexToAnthropicBody(body) {
    const messages = [];
    const pendingToolResults = [];

    if (Array.isArray(body.input)) {
        for (const item of body.input) {
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
    } else if (typeof body.input === 'string') {
        messages.push({ role: 'user', content: body.input });
    }

    const result = {
        model: mapToClaudeModel(body.model),
        messages,
        max_tokens: body.max_output_tokens || 8192
    };
    if (body.instructions) result.system = body.instructions;
    if (body.temperature !== undefined) result.temperature = body.temperature;

    if (Array.isArray(body.tools) && body.tools.length > 0) {
        result.tools = body.tools
            .filter(t => t.type === 'function')
            .map(t => ({
                name: t.name,
                description: t.description || '',
                input_schema: t.parameters || { type: 'object', properties: {} }
            }));
    }

    return result;
}

function _anthropicToCodexFormat(claudeResponse, originalModel) {
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

async function _handleCodexViaClaudeAccount(res, body, modelId, isStreaming, startTime) {
    const accounts = _getUsableClaudeAccounts();
    const anthropicBody = _codexToAnthropicBody(body);

    for (const account of accounts) {
        try {
            const mappedModel = anthropicBody.model;
            logger.info(`[Codex] >>> Claude account | ${account.email} | ${modelId}→${mappedModel}`);

            const claudeResponse = await sendClaudeMessage(anthropicBody, account.accessToken);
            const durationMs = Date.now() - startTime;

            const codexFormat = _anthropicToCodexFormat(claudeResponse, modelId);

            const inputTokens = claudeResponse.usage?.input_tokens || 0;
            const outputTokens = claudeResponse.usage?.output_tokens || 0;
            recordRequest({ provider: 'claude-pool', keyId: account.email, model: mappedModel, inputTokens, outputTokens, durationMs, success: true });
            logRequest({ route: '/backend-api/codex/responses', provider: 'claude-pool', keyId: account.email, model: modelId, mappedModel, requestBody: body, inputTokens, outputTokens, durationMs, status: 200, success: true });

            logger.success(`[Codex] <<< Claude account OK | ${account.email} | model=${modelId} | ${inputTokens}+${outputTokens} tokens | ${durationMs}ms`);

            if (isStreaming) {
                sendResponsesSSE(res, codexFormat);
            } else {
                res.json(codexFormat);
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
                            const codexFormat = _anthropicToCodexFormat(retryResponse, modelId);
                            const inputTokens = retryResponse.usage?.input_tokens || 0;
                            const outputTokens = retryResponse.usage?.output_tokens || 0;
                            recordRequest({ provider: 'claude-pool', keyId: account.email, model: anthropicBody.model, inputTokens, outputTokens, durationMs: retryDurationMs, success: true });
                            logger.success(`[Codex] <<< Claude account OK (after refresh) | ${account.email} | model=${modelId} | ${inputTokens}+${outputTokens} tokens | ${retryDurationMs}ms`);
                            if (isStreaming) { sendResponsesSSE(res, codexFormat); } else { res.json(codexFormat); }
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

async function _handleCodexViaAntigravityAccount(res, body, modelId, isStreaming, startTime, preferredEmail = null) {
    const account = getAntigravityAccountForModel(modelId, preferredEmail);
    if (!account?.accessToken || !account?.projectId) return false;

    try {
        const anthropicBody = _codexToAnthropicBody(body);
        anthropicBody.model = modelId;
        const antigravityResponse = await sendAntigravityMessage(anthropicBody, account, { modelOverride: modelId });
        const codexFormat = _anthropicToCodexFormat(antigravityResponse, modelId);
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
        logRequest({
            route: '/backend-api/codex/responses',
            provider: 'antigravity',
            keyId: account.email,
            model: modelId,
            mappedModel: modelId,
            requestBody: body,
            inputTokens: antigravityResponse.usage?.input_tokens || 0,
            outputTokens: antigravityResponse.usage?.output_tokens || 0,
            durationMs,
            status: 200,
            success: true
        });
        if (isStreaming) sendResponsesSSE(res, codexFormat); else res.json(codexFormat);
        return true;
    } catch (error) {
        logger.error(`[Codex] Antigravity error: ${account.email} - ${error.message}`);
        return false;
    }
}

export const _testExports = {
    _codexToChatBody,
    findToolCallSequenceError
};

export default { handleCodexResponses, handleCodexModels, handleCodexCatchAll };
