/**
 * Claude API Client
 * Sends requests to Anthropic's API (api.anthropic.com) using Claude OAuth tokens.
 * Parallel to direct-api.js (which targets ChatGPT's backend).
 */

import { logger } from './utils/logger.js';
import { normalizeJsonSchema } from './json-schema-normalizer.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REQUIRED_BETA_FLAGS = ['oauth-2025-04-20', 'prompt-caching-2024-07-31'];
const CLAUDE_RATELIMIT_HEADERS = {
    status: 'anthropic-ratelimit-unified-status',
    resetAt: 'anthropic-ratelimit-unified-reset',
    fiveHourUtilization: 'anthropic-ratelimit-unified-5h-utilization',
    fiveHourResetAt: 'anthropic-ratelimit-unified-5h-reset',
    sevenDayUtilization: 'anthropic-ratelimit-unified-7d-utilization',
    sevenDayResetAt: 'anthropic-ratelimit-unified-7d-reset',
    representativeClaim: 'anthropic-ratelimit-unified-representative-claim',
    overageStatus: 'anthropic-ratelimit-unified-overage-status',
    overageResetAt: 'anthropic-ratelimit-unified-overage-reset',
    overageDisabledReason: 'anthropic-ratelimit-unified-overage-disabled-reason'
};

function collectErrorMessages(error) {
    const messages = [];
    const queue = [error];
    const seen = new Set();

    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) continue;
        seen.add(current);

        if (typeof current.message === 'string' && current.message.length > 0) {
            messages.push(current.message);
        }
        if (typeof current.code === 'string' && current.code.length > 0) {
            messages.push(`code=${current.code}`);
        }
        if (current.cause && typeof current.cause === 'object') {
            queue.push(current.cause);
        }
    }

    return messages;
}

function buildClaudeNetworkError(operation, error) {
    const details = collectErrorMessages(error);
    const summary = details.length > 0 ? details.join(' | ') : 'unknown network error';
    return new Error(`CLAUDE_NETWORK_ERROR: ${operation} failed: ${summary}`, { cause: error });
}

function logClaudeNetworkError(operation, error) {
    const details = collectErrorMessages(error);
    logger.error(`[ClaudeAPI] ${operation} network error: ${details.join(' | ') || 'unknown network error'}`);
}

export function extractClaudeRateLimitHeaders(headers) {
    if (!headers?.get) return null;

    const extracted = {};
    for (const [key, headerName] of Object.entries(CLAUDE_RATELIMIT_HEADERS)) {
        const value = headers.get(headerName);
        if (value) extracted[key] = value;
    }

    return Object.keys(extracted).length > 0 ? extracted : null;
}

/**
 * Merge client-provided beta flags with our required ones.
 * Deduplicates and preserves order (client flags first, then ours).
 */
function _buildBetaHeader(clientBeta) {
    const flags = new Set();
    if (clientBeta) {
        for (const f of clientBeta.split(',')) {
            const trimmed = f.trim();
            if (trimmed) flags.add(trimmed);
        }
    }
    for (const f of REQUIRED_BETA_FLAGS) flags.add(f);
    return [...flags].join(',');
}

// Fields accepted by the Anthropic Messages API
const ALLOWED_BODY_FIELDS = new Set([
    'model', 'messages', 'max_tokens', 'metadata', 'stop_sequences',
    'stream', 'system', 'temperature', 'thinking', 'tool_choice', 'tools',
    'top_k', 'top_p', 'service_tier', 'budget_tokens', 'speed'
]);

/**
 * Strip non-standard fields from request body to avoid 400 errors.
 * Claude Code sends internal fields like context_management that the API rejects.
 */
export function sanitizeClaudeBody(body) {
    const cleaned = {};
    for (const key of Object.keys(body)) {
        if (ALLOWED_BODY_FIELDS.has(key)) {
            cleaned[key] = body[key];
        }
    }
    // Fix messages to conform to Anthropic API rules:
    // 1. First message must be role "user"
    // 2. Messages must alternate user/assistant (no consecutive same-role)
    if (cleaned.messages && Array.isArray(cleaned.messages)) {
        cleaned.messages = _fixMessageOrder(cleaned.messages);
    }
    if (Array.isArray(cleaned.tools)) {
        cleaned.tools = cleaned.tools.map(tool => sanitizeClaudeTool(tool));
    }
    return cleaned;
}

function sanitizeClaudeTool(tool) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        return tool;
    }

    // Anthropic hosted tools use their own type-specific shape and reject
    // custom-tool fields like input_schema on the messages endpoint.
    if (typeof tool.type === 'string' && tool.type.length > 0) {
        const { input_schema, ...rest } = tool;
        return rest;
    }

    return {
        ...tool,
        input_schema: sanitizeClaudeToolSchema(tool.input_schema)
    };
}

function hasTopLevelClaudeUnsupportedComposition(schema) {
    return !!schema && typeof schema === 'object' && !Array.isArray(schema) && (
        Array.isArray(schema.anyOf) ||
        Array.isArray(schema.oneOf) ||
        Array.isArray(schema.allOf) ||
        typeof schema.$ref === 'string'
    );
}

export function sanitizeClaudeToolSchema(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return { type: 'object', properties: {} };
    }

    if (!hasTopLevelClaudeUnsupportedComposition(schema)) {
        return schema;
    }

    const normalized = normalizeJsonSchema(schema);
    if (normalized.type === 'object') {
        return normalized;
    }

    return {
        type: 'object',
        properties: {
            value: normalized
        },
        required: ['value']
    };
}

/**
 * Fix message array to satisfy Anthropic Messages API constraints:
 * - First message must have role "user"
 * - Roles must strictly alternate (user, assistant, user, ...)
 * - Consecutive same-role messages are merged into one
 */
function _fixMessageOrder(messages) {
    if (!messages.length) return messages;

    // Strip leading assistant messages (API requires first = user)
    let start = 0;
    while (start < messages.length && messages[start].role !== 'user') {
        start++;
    }
    if (start >= messages.length) {
        // No user messages at all — nothing we can do
        return messages;
    }
    const trimmed = messages.slice(start);

    // Merge consecutive same-role messages
    const merged = [];
    for (const msg of trimmed) {
        if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
            // Merge content into the previous message
            const prev = merged[merged.length - 1];
            prev.content = _mergeContent(prev.content, msg.content);
        } else {
            // Clone to avoid mutating the original
            merged.push({ ...msg, content: _cloneContent(msg.content) });
        }
    }

    return merged;
}

function _mergeContent(existing, incoming) {
    const toArray = (c) => {
        if (typeof c === 'string') return [{ type: 'text', text: c }];
        if (Array.isArray(c)) return c;
        return [c];
    };
    return [...toArray(existing), ...toArray(incoming)];
}

function _cloneContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return [...content];
    return content;
}

/**
 * Send a non-streaming request to Claude API.
 * @param {object} body - Anthropic Messages API request body
 * @param {string} accessToken - Claude OAuth access token
 * @returns {Promise<object>} Parsed Anthropic response
 */
export async function sendClaudeMessage(body, accessToken, { clientBeta } = {}) {
    const { data } = await sendClaudeMessageWithMeta(body, accessToken, { clientBeta });
    return data;
}

export async function sendClaudeMessageWithMeta(body, accessToken, { clientBeta } = {}) {
    const sanitized = { ...sanitizeClaudeBody(body), stream: false };
    let response;
    try {
        response = await fetch(CLAUDE_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'anthropic-version': ANTHROPIC_VERSION,
                'anthropic-beta': _buildBetaHeader(clientBeta),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(sanitized)
        });
    } catch (error) {
        logClaudeNetworkError('messages', error);
        throw buildClaudeNetworkError('messages', error);
    }

    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[ClaudeAPI] Error response: ${errorText.slice(0, 1000)}`);
        _throwApiError(response, errorText);
    }

    return {
        data: await response.json(),
        rateLimitHeaders: extractClaudeRateLimitHeaders(response.headers)
    };
}

/**
 * Send a streaming request to Claude API.
 * Returns the raw fetch Response for direct piping (both sides use Anthropic SSE format).
 * @param {object} body - Anthropic Messages API request body
 * @param {string} accessToken - Claude OAuth access token
 * @returns {Promise<Response>} Raw fetch response with SSE body
 */
export async function sendClaudeStream(body, accessToken, { clientBeta, signal } = {}) {
    const sanitized = { ...sanitizeClaudeBody(body), stream: true };
    let response;
    try {
        response = await fetch(CLAUDE_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'anthropic-version': ANTHROPIC_VERSION,
                'anthropic-beta': _buildBetaHeader(clientBeta),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(sanitized),
            signal
        });
    } catch (error) {
        logClaudeNetworkError('stream', error);
        throw buildClaudeNetworkError('stream', error);
    }

    if (!response.ok) {
        const errorText = await response.text();
        logger.error(`[ClaudeAPI] Stream error response: ${errorText.slice(0, 1000)}`);
        _throwApiError(response, errorText);
    }

    return response;
}

function _throwApiError(response, errorText) {
    if (response.status === 401 || response.status === 403) {
        logger.error(`[ClaudeAPI] Auth error ${response.status}: ${errorText.slice(0, 500)}`);
        const error = new Error(`AUTH_EXPIRED: ${response.status} - ${errorText.slice(0, 300)}`);
        _attachClaudeErrorMetadata(error, response);
        throw error;
    }
    if (response.status === 429) {
        const resetMs = _parseResetTime(response, errorText);
        const error = new Error(`RATE_LIMITED:${resetMs}:${errorText}`);
        _attachClaudeErrorMetadata(error, response);
        throw error;
    }
    // Detect generic 400 "Error" — Claude OAuth returns this when the account
    // has exhausted its model quota (e.g., no more Opus/Sonnet usage left).
    if (response.status === 400) {
        try {
            const parsed = JSON.parse(errorText);
            if (parsed?.error?.message === 'Error' && parsed?.error?.type === 'invalid_request_error') {
                const error = new Error(`MODEL_QUOTA_EXHAUSTED: Account usage limit likely reached for this model tier`);
                _attachClaudeErrorMetadata(error, response);
                throw error;
            }
        } catch (e) {
            if (e.message.startsWith('MODEL_QUOTA_EXHAUSTED')) throw e;
            // not JSON or different format — fall through to generic handler
        }
    }
    const error = new Error(`CLAUDE_API_ERROR: ${response.status} - ${errorText.slice(0, 500)}`);
    _attachClaudeErrorMetadata(error, response);
    throw error;
}

function _attachClaudeErrorMetadata(error, response) {
    error.statusCode = response.status;
    error.rateLimitHeaders = extractClaudeRateLimitHeaders(response.headers);
}

function _parseResetTime(response, errorText) {
    const retryAfter = response.headers?.get?.('retry-after');
    if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) return seconds * 1000;
    }
    if (errorText) {
        const secMatch = errorText.match(/retry\s+(?:after\s+)?(\d+)\s*(?:sec|s\b)/i);
        if (secMatch) return parseInt(secMatch[1], 10) * 1000;
    }
    return 60000;
}

/**
 * Map an incoming model ID to an appropriate Claude model.
 * Used when Claude accounts serve Codex/OpenAI-format requests.
 *
 * Uses the tier-based system from model-mapping.js so that mappings
 * automatically stay current when model discovery updates them.
 * Falls back to keyword matching if module not loaded yet.
 */
export function mapToClaudeModel(modelId) {
    if (!modelId) return 'claude-sonnet-4-6';
    const id = modelId.toLowerCase();

    // Already a Claude model — pass through
    if (id.startsWith('claude-')) return modelId;

    // Use tier system via lazy-loaded module
    if (_modelMapping) {
        const tier = _modelMapping.recognizeTier(modelId);
        const mappings = _modelMapping.getMappings();
        const anthropicMap = mappings.providers?.anthropic;
        if (anthropicMap?.[tier]) return anthropicMap[tier];
    }

    // Keyword fallback
    if (id.includes('mini') || id.includes('haiku') || id.includes('lite') || id.includes('nano')) {
        return 'claude-haiku-4-5';
    }
    if (id.includes('opus') || id.includes('pro') || id.includes('codex')) {
        return 'claude-opus-4-6';
    }
    return 'claude-sonnet-4-6';
}

// Lazy import to avoid circular dependency at module load time
let _modelMapping = null;
import('./model-mapping.js').then(mod => { _modelMapping = mod; }).catch(() => {});

export const _testExports = {
    collectErrorMessages,
    buildClaudeNetworkError
};

export default { sendClaudeMessage, sendClaudeMessageWithMeta, sendClaudeStream, mapToClaudeModel, sanitizeClaudeBody };
