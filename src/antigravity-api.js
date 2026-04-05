import { sanitizeClaudeBody } from './claude-api.js';
import { normalizeJsonSchema } from './json-schema-normalizer.js';
import { logger } from './utils/logger.js';

const DEFAULT_OAUTH_CLIENT_KEY = 'antigravity-enterprise';
const DEFAULT_CLIENT_ID = process.env.ANTIGRAVITY_GOOGLE_CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const DEFAULT_CLIENT_SECRET = process.env.ANTIGRAVITY_GOOGLE_CLIENT_SECRET || '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';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const LOAD_CODE_ASSIST_URL = 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist';
const MODEL_DISCOVERY_URLS = [
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'
];
const GENERATE_URLS = [
    'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
    'https://cloudcode-pa.googleapis.com/v1internal:generateContent'
];

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.0 Chrome/135.0.0.0 Safari/537.36';
const CLAUDE_BETA_HEADER = 'claude-code-20250219';
export const ANTIGRAVITY_MODEL_PREFIX = 'antigravity/';

function buildHeaders(accessToken, modelId = '') {
    const headers = {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': DEFAULT_USER_AGENT
    };
    if (String(modelId).toLowerCase().includes('claude')) {
        headers['anthropic-beta'] = CLAUDE_BETA_HEADER;
    }
    return headers;
}

function parseJsonSafely(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function normalizeModelId(modelId) {
    if (!modelId) return modelId;
    return modelId.startsWith(ANTIGRAVITY_MODEL_PREFIX)
        ? modelId.slice(ANTIGRAVITY_MODEL_PREFIX.length)
        : modelId;
}

function normalizeQuotaInfo(quotaInfo) {
    if (!quotaInfo || typeof quotaInfo !== 'object') {
        return null;
    }

    const remainingFraction = Number(quotaInfo.remainingFraction);
    const remainingPercent = Number.isFinite(remainingFraction)
        ? Math.max(0, Math.min(100, Math.round(remainingFraction * 100)))
        : null;

    return {
        remainingFraction: Number.isFinite(remainingFraction) ? remainingFraction : null,
        remainingPercent,
        resetTime: quotaInfo.resetTime || null
    };
}

export function mapAntigravityUpstreamModel(modelId) {
    const normalized = normalizeModelId(modelId);
    const lower = String(normalized || '').toLowerCase();
    if (!lower) return normalized;

    if (lower === 'claude-opus-4' || lower.startsWith('claude-opus-4-5')) {
        return 'claude-opus-4-6-thinking';
    }
    if (lower === 'claude-opus-4-6' || lower.startsWith('claude-opus-4-6-')) {
        return 'claude-opus-4-6-thinking';
    }
    if (lower.startsWith('claude-sonnet-4-5')) {
        return 'claude-sonnet-4-6-thinking';
    }
    if (lower === 'claude-haiku-4' || lower.startsWith('claude-haiku-4-5') || lower === 'claude-3-haiku-20240307') {
        return 'claude-sonnet-4-6';
    }

    return normalized;
}

function encodeInlineImage(block) {
    const source = block?.source || {};
    if (source.type === 'base64' && source.data) {
        return {
            inlineData: {
                mimeType: source.media_type || 'image/jpeg',
                data: source.data
            }
        };
    }
    if (source.type === 'url' && source.url) {
        return {
            fileData: {
                mimeType: source.media_type || 'image/jpeg',
                fileUri: source.url
            }
        };
    }
    return null;
}

function anthropicContentToParts(content) {
    const blocks = typeof content === 'string'
        ? [{ type: 'text', text: content }]
        : Array.isArray(content) ? content : [];

    const parts = [];
    for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'text') {
            parts.push({ text: block.text || '' });
            continue;
        }
        if (block.type === 'tool_use') {
            parts.push({
                functionCall: {
                    name: block.name,
                    args: block.input || {},
                    id: block.id
                }
            });
            continue;
        }
        if (block.type === 'tool_result') {
            const payload = Array.isArray(block.content)
                ? block.content.map((item) => item?.text || '').join('\n')
                : typeof block.content === 'string'
                    ? block.content
                    : JSON.stringify(block.content ?? '');
            parts.push({
                functionResponse: {
                    name: block.tool_use_id || 'tool_result',
                    response: {
                        tool_use_id: block.tool_use_id,
                        content: payload
                    }
                }
            });
            continue;
        }
        if (block.type === 'image') {
            const imagePart = encodeInlineImage(block);
            if (imagePart) parts.push(imagePart);
        }
    }
    return parts.length > 0 ? parts : [{ text: '' }];
}

function anthropicMessagesToGeminiContents(messages = []) {
    return messages.map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: anthropicContentToParts(message.content)
    }));
}

function buildFunctionDeclarations(tools = []) {
    return tools
        .filter((tool) => tool?.name)
        .map((tool) => ({
            name: tool.name,
            description: tool.description || '',
            parameters: normalizeJsonSchema(tool.input_schema || { type: 'object', properties: {} })
        }));
}

function buildToolConfig(toolChoice) {
    if (!toolChoice) return null;
    if (typeof toolChoice === 'string') {
        if (toolChoice === 'none') return { functionCallingConfig: { mode: 'NONE' } };
        if (toolChoice === 'any') return { functionCallingConfig: { mode: 'ANY' } };
        return { functionCallingConfig: { mode: 'AUTO' } };
    }
    if (toolChoice.type === 'tool' && toolChoice.name) {
        return {
            functionCallingConfig: {
                mode: 'ANY',
                allowedFunctionNames: [toolChoice.name]
            }
        };
    }
    return { functionCallingConfig: { mode: 'AUTO' } };
}

function buildGeminiRequest(body, projectId, modelId) {
    const cleaned = sanitizeClaudeBody(body);
    const upstreamModel = mapAntigravityUpstreamModel(modelId || cleaned.model);
    const innerRequest = {
        contents: anthropicMessagesToGeminiContents(cleaned.messages || [])
    };

    if (cleaned.system) {
        const systemText = Array.isArray(cleaned.system)
            ? cleaned.system.map((item) => item?.text || '').join('\n')
            : cleaned.system;
        innerRequest.systemInstruction = {
            role: 'user',
            parts: [{ text: systemText }]
        };
    }

    const generationConfig = {};
    if (cleaned.max_tokens) generationConfig.maxOutputTokens = cleaned.max_tokens;
    if (cleaned.temperature !== undefined) generationConfig.temperature = cleaned.temperature;
    if (cleaned.top_p !== undefined) generationConfig.topP = cleaned.top_p;
    if (cleaned.top_k !== undefined) generationConfig.topK = cleaned.top_k;
    if (Array.isArray(cleaned.stop_sequences) && cleaned.stop_sequences.length > 0) {
        generationConfig.stopSequences = cleaned.stop_sequences;
    }
    if (!('topK' in generationConfig)) generationConfig.topK = 40;
    if (!('topP' in generationConfig)) generationConfig.topP = 1.0;
    if (Object.keys(generationConfig).length > 0) innerRequest.generationConfig = generationConfig;

    const functionDeclarations = buildFunctionDeclarations(cleaned.tools || []);
    if (functionDeclarations.length > 0) {
        innerRequest.tools = [{ functionDeclarations }];
        innerRequest.toolConfig = {
            functionCallingConfig: {
                mode: 'VALIDATED'
            }
        };
    }

    const toolConfig = buildToolConfig(cleaned.tool_choice);
    if (toolConfig) innerRequest.toolConfig = toolConfig;

    return {
        project: projectId,
        requestId: `agent/antigravity/${Date.now()}`,
        request: innerRequest,
        model: upstreamModel,
        userAgent: 'antigravity',
        requestType: 'agent'
    };
}

function geminiPartToAnthropicBlocks(part, fallbackIdSeed) {
    if (part?.thought === true && typeof part.text === 'string' && part.text.length > 0) {
        return [{
            type: 'thinking',
            thinking: part.text,
            signature: part.signature || ''
        }];
    }
    if (typeof part?.text === 'string' && part.text.length > 0) {
        return [{ type: 'text', text: part.text }];
    }
    if (part?.functionCall?.name) {
        const callId = part.functionCall.id || `toolu_${fallbackIdSeed}`;
        return [{
            type: 'tool_use',
            id: callId,
            name: part.functionCall.name,
            input: part.functionCall.args || {}
        }];
    }
    return [];
}

function extractUsage(raw) {
    const usage = raw?.usageMetadata || raw?.usage_metadata || raw?.usage || {};
    const inputTokens = usage.promptTokenCount ?? usage.prompt_token_count ?? usage.input_tokens ?? 0;
    const outputTokens = usage.candidatesTokenCount ?? usage.candidates_token_count ?? usage.output_tokens ?? 0;
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens
    };
}

export function isAntigravityModel(modelId) {
    return typeof modelId === 'string' && modelId.startsWith(ANTIGRAVITY_MODEL_PREFIX);
}

export function toPublicAntigravityModel(modelId) {
    return modelId?.startsWith(ANTIGRAVITY_MODEL_PREFIX) ? modelId : `${ANTIGRAVITY_MODEL_PREFIX}${modelId}`;
}

export async function refreshAntigravityAccessToken(refreshToken, oauthClientKey = DEFAULT_OAUTH_CLIENT_KEY) {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: DEFAULT_CLIENT_ID,
            client_secret: DEFAULT_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        }).toString()
    });

    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`ANTIGRAVITY_TOKEN_ERROR: ${response.status} - ${responseText.slice(0, 300)}`);
    }

    const parsed = parseJsonSafely(responseText);
    if (!parsed?.access_token) {
        throw new Error('ANTIGRAVITY_TOKEN_ERROR: access_token missing');
    }

    return {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token || refreshToken,
        expiresAt: Date.now() + ((parsed.expires_in || 3600) * 1000),
        oauthClientKey
    };
}

export async function fetchGoogleUserInfo(accessToken) {
    const response = await fetch(USERINFO_URL, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'User-Agent': DEFAULT_USER_AGENT
        }
    });
    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`ANTIGRAVITY_USERINFO_ERROR: ${response.status} - ${responseText.slice(0, 300)}`);
    }
    const parsed = parseJsonSafely(responseText);
    return {
        email: parsed?.email || null,
        displayName: parsed?.name || parsed?.given_name || null,
        picture: parsed?.picture || null
    };
}

export async function fetchProjectId(accessToken) {
    const response = await fetch(LOAD_CODE_ASSIST_URL, {
        method: 'POST',
        headers: buildHeaders(accessToken),
        body: JSON.stringify({
            metadata: {
                ideType: 'ANTIGRAVITY'
            }
        })
    });
    const responseText = await response.text();
    if (!response.ok) {
        throw new Error(`ANTIGRAVITY_PROJECT_ERROR: ${response.status} - ${responseText.slice(0, 300)}`);
    }
    const parsed = parseJsonSafely(responseText);
    if (!parsed?.cloudaicompanionProject) {
        throw new Error('ANTIGRAVITY_PROJECT_ERROR: cloudaicompanionProject missing');
    }
    return {
        projectId: parsed.cloudaicompanionProject,
        subscriptionType: parsed?.paidTier?.name || parsed?.currentTier?.name || null
    };
}

export async function fetchAvailableModels(accessToken, projectId) {
    let lastError = null;
    for (const url of MODEL_DISCOVERY_URLS) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: buildHeaders(accessToken),
                body: JSON.stringify(projectId ? { project: projectId } : {})
            });
            const responseText = await response.text();
            if (!response.ok) {
                lastError = new Error(`ANTIGRAVITY_MODELS_ERROR: ${response.status} - ${responseText.slice(0, 300)}`);
                if (response.status >= 500 || response.status === 429) continue;
                throw lastError;
            }

            const parsed = parseJsonSafely(responseText) || {};
            const models = Object.entries(parsed.models || {}).map(([id, info]) => ({
                id,
                publicId: toPublicAntigravityModel(id),
                displayName: info?.displayName || id,
                maxTokens: info?.maxTokens || null,
                maxOutputTokens: info?.maxOutputTokens || null,
                supportsImages: info?.supportsImages === true,
                supportsThinking: info?.supportsThinking === true,
                recommended: info?.recommended === true,
                quota: normalizeQuotaInfo(info?.quotaInfo)
            }));
            return models.sort((a, b) => {
                if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
                return a.id.localeCompare(b.id);
            });
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error('ANTIGRAVITY_MODELS_ERROR: unknown');
}

export async function sendAntigravityMessage(body, account, { modelOverride } = {}) {
    if (!account?.accessToken) {
        throw new Error('ANTIGRAVITY_AUTH_ERROR: missing access token');
    }
    if (!account?.projectId) {
        throw new Error('ANTIGRAVITY_PROJECT_ERROR: missing project id');
    }

    const geminiRequest = buildGeminiRequest(body, account.projectId, modelOverride || body.model);
    let lastError = null;

    for (const url of GENERATE_URLS) {
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: buildHeaders(account.accessToken, geminiRequest.model),
                body: JSON.stringify(geminiRequest)
            });
            const responseText = await response.text();

            if (response.status === 401 || response.status === 403) {
                throw new Error(`AUTH_EXPIRED: ${response.status} - ${responseText.slice(0, 300)}`);
            }
            if (response.status === 429) {
                throw new Error(`RATE_LIMITED:60000:${responseText.slice(0, 300)}`);
            }
            if (!response.ok) {
                lastError = new Error(`ANTIGRAVITY_API_ERROR: ${response.status} - ${responseText.slice(0, 400)}`);
                if (response.status >= 500) continue;
                throw lastError;
            }

            const parsed = parseJsonSafely(responseText) || {};
            const raw = parsed.response || parsed;
            const candidate = raw?.candidates?.[0] || {};
            const parts = candidate?.content?.parts || [];
            const content = [];

            parts.forEach((part, index) => {
                content.push(...geminiPartToAnthropicBlocks(part, `${Date.now()}_${index}`));
            });

            if (content.length === 0) {
                content.push({ type: 'text', text: '' });
            }

            return {
                id: raw?.responseId || raw?.id || `msg_${Date.now()}`,
                type: 'message',
                role: 'assistant',
                model: toPublicAntigravityModel(geminiRequest.model),
                content,
                stop_reason: candidate?.finishReason || raw?.finishReason || 'end_turn',
                stop_sequence: null,
                usage: extractUsage(raw)
            };
        } catch (error) {
            lastError = error;
            if (String(error.message || '').startsWith('AUTH_EXPIRED:')) throw error;
            if (String(error.message || '').startsWith('RATE_LIMITED:')) throw error;
        }
    }

    logger.error(`[Antigravity] Upstream request failed: ${lastError?.message || 'unknown error'}`);
    throw lastError || new Error('ANTIGRAVITY_API_ERROR: unknown');
}

export function writeAnthropicSSEFromMessage(res, message) {
    const sse = (event, data) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    sse('message_start', {
        type: 'message_start',
        message: {
            id: message.id,
            type: 'message',
            role: 'assistant',
            model: message.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: message.usage?.input_tokens || 0, output_tokens: 0 }
        }
    });

    (message.content || []).forEach((block, index) => {
        if (block.type === 'thinking') {
            sse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'thinking', thinking: '' }
            });
            if (block.thinking) {
                sse('content_block_delta', {
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'thinking_delta', thinking: block.thinking }
                });
            }
            if (block.signature) {
                sse('content_block_delta', {
                    type: 'content_block_delta',
                    index,
                    delta: { type: 'signature_delta', signature: block.signature }
                });
            }
            sse('content_block_stop', { type: 'content_block_stop', index });
            return;
        }

        if (block.type === 'text') {
            sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
            sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text || '' } });
            sse('content_block_stop', { type: 'content_block_stop', index });
            return;
        }

        if (block.type === 'tool_use') {
            sse('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} }
            });
            sse('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) }
            });
            sse('content_block_stop', { type: 'content_block_stop', index });
        }
    });

    sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: message.stop_reason || 'end_turn', stop_sequence: null },
        usage: { output_tokens: message.usage?.output_tokens || 0 }
    });
    sse('message_stop', { type: 'message_stop' });
    if (!res.writableEnded) res.end();
}

export const _testExports = {
    mapAntigravityUpstreamModel,
    buildGeminiRequest
};
