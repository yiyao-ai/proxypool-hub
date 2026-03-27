/**
 * Claude API Client
 * Sends requests to Anthropic's API (api.anthropic.com) using Claude OAuth tokens.
 * Parallel to direct-api.js (which targets ChatGPT's backend).
 */

import { logger } from './utils/logger.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

// Fields accepted by the Anthropic Messages API
const ALLOWED_BODY_FIELDS = new Set([
    'model', 'messages', 'max_tokens', 'metadata', 'stop_sequences',
    'stream', 'system', 'temperature', 'thinking', 'tool_choice', 'tools',
    'top_k', 'top_p', 'service_tier'
]);

/**
 * Strip non-standard fields from request body to avoid 400 errors.
 * Claude Code sends internal fields like context_management that the API rejects.
 */
function _sanitizeBody(body) {
    const cleaned = {};
    for (const key of Object.keys(body)) {
        if (ALLOWED_BODY_FIELDS.has(key)) {
            cleaned[key] = body[key];
        }
    }
    return cleaned;
}

/**
 * Send a non-streaming request to Claude API.
 * @param {object} body - Anthropic Messages API request body
 * @param {string} accessToken - Claude OAuth access token
 * @returns {Promise<object>} Parsed Anthropic response
 */
export async function sendClaudeMessage(body, accessToken) {
    const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': OAUTH_BETA_HEADER,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ..._sanitizeBody(body), stream: false })
    });

    if (!response.ok) {
        _throwApiError(response, await response.text());
    }

    return await response.json();
}

/**
 * Send a streaming request to Claude API.
 * Returns the raw fetch Response for direct piping (both sides use Anthropic SSE format).
 * @param {object} body - Anthropic Messages API request body
 * @param {string} accessToken - Claude OAuth access token
 * @returns {Promise<Response>} Raw fetch response with SSE body
 */
export async function sendClaudeStream(body, accessToken) {
    const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': OAUTH_BETA_HEADER,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ..._sanitizeBody(body), stream: true })
    });

    if (!response.ok) {
        _throwApiError(response, await response.text());
    }

    return response;
}

function _throwApiError(response, errorText) {
    if (response.status === 401 || response.status === 403) {
        logger.error(`[ClaudeAPI] Auth error ${response.status}: ${errorText.slice(0, 500)}`);
        throw new Error(`AUTH_EXPIRED: ${response.status} - ${errorText.slice(0, 300)}`);
    }
    if (response.status === 429) {
        const resetMs = _parseResetTime(response, errorText);
        throw new Error(`RATE_LIMITED:${resetMs}:${errorText}`);
    }
    throw new Error(`CLAUDE_API_ERROR: ${response.status} - ${errorText.slice(0, 500)}`);
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

export default { sendClaudeMessage, sendClaudeStream, mapToClaudeModel };
