/**
 * Vertex AI Provider
 * Forwards requests to Google Cloud Vertex AI endpoints.
 *
 * Supports two model families with different endpoints and formats:
 *   - Gemini models  → :generateContent (Gemini format)
 *   - Claude models  → :rawPredict     (Anthropic Messages format)
 *
 * Authentication:
 *   - Service Account JSON → auto-generates OAuth2 access tokens with refresh
 *   - apiKey field stores the full Service Account JSON string
 *
 * Required config:
 *   - apiKey:     Service Account JSON string (the full JSON content)
 *   - projectId:  GCP project ID
 *   - location:   Region, e.g. us-central1
 */

import { createSign, randomBytes } from 'crypto';
import { BaseProvider } from './base.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';
import { sanitizeClaudeBody } from '../claude-api.js';
import { cleanCacheControl } from '../thinking-utils.js';

const DEFAULT_MODEL = 'gemini-3-flash-preview';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
// Refresh token 5 minutes before expiry
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

// ─── JWT / OAuth2 helpers ───────────────────────────────────────────────────

function _base64url(data) {
    return Buffer.from(data).toString('base64url');
}

/**
 * Create a signed JWT for Google OAuth2 service account authentication.
 * Uses Node.js built-in crypto — no external dependencies.
 */
function _createJwt(serviceAccount) {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
        iss: serviceAccount.client_email,
        scope: TOKEN_SCOPE,
        aud: TOKEN_URL,
        iat: now,
        exp: now + 3600, // 1 hour
    };

    const headerB64 = _base64url(JSON.stringify(header));
    const payloadB64 = _base64url(JSON.stringify(payload));
    const signInput = `${headerB64}.${payloadB64}`;

    const signer = createSign('RSA-SHA256');
    signer.update(signInput);
    const signature = signer.sign(serviceAccount.private_key, 'base64url');

    return `${signInput}.${signature}`;
}

/**
 * Exchange a JWT assertion for an OAuth2 access token.
 */
async function _getAccessToken(serviceAccount) {
    const jwt = _createJwt(serviceAccount);
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwt,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OAuth2 token exchange failed (${response.status}): ${err}`);
    }

    const data = await response.json();
    return {
        accessToken: data.access_token,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
    };
}

// ─── Model classification ───────────────────────────────────────────────────

function _isClaudeModel(model) {
    return /^claude-/i.test(model);
}

function _isGeminiModel(model) {
    return /^gemini-/i.test(model);
}

function _cleanAnthropicSystem(system) {
    if (typeof system === 'string' || system === undefined || system === null) {
        return system;
    }
    if (!Array.isArray(system)) {
        return system;
    }

    return system.map(block => {
        if (!block || typeof block !== 'object') return block;
        if (block.cache_control === undefined) return block;
        const { cache_control, ...cleanBlock } = block;
        return cleanBlock;
    });
}

function _generateAnthropicMessageId() {
    return `msg_${randomBytes(16).toString('hex')}`;
}

function _generateAnthropicToolId() {
    return `toolu_${randomBytes(12).toString('hex')}`;
}

function _mapGeminiFinishReasonToAnthropic(finishReason, hasToolUse) {
    if (hasToolUse) return 'tool_use';

    switch ((finishReason || '').toUpperCase()) {
        case 'MAX_TOKENS':
            return 'max_tokens';
        case 'STOP':
        case 'FINISH_REASON_UNSPECIFIED':
        default:
            return 'end_turn';
    }
}

function _isRetryableGeminiModelError(status, bodyText) {
    if (status !== 404) return false;
    const text = String(bodyText || '');
    return text.includes('Publisher Model') && (
        text.includes('was not found') ||
        text.includes('does not have access')
    );
}

function _geminiFallbackModels(model) {
    const curated = {
        'gemini-3.1-pro-preview': ['gemini-2.5-pro', 'gemini-2.5-flash'],
        'gemini-3-flash-preview': ['gemini-2.5-flash', 'gemini-2.0-flash'],
        'gemini-3.1-flash-lite-preview': ['gemini-2.0-flash', 'gemini-2.5-flash']
    };
    const fallbacks = curated[model] || [];
    return [model, ...fallbacks.filter(candidate => candidate !== model)];
}

// ─── Provider ───────────────────────────────────────────────────────────────

export class VertexAIProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'vertex-ai',
            baseUrl: config.baseUrl || ''
        });
        this.projectId = config.projectId || '';
        this.location = config.location || 'us-central1';

        // Parse service account JSON from apiKey field
        this._serviceAccount = null;
        this._accessToken = null;
        this._tokenExpiresAt = 0;

        try {
            this._serviceAccount = JSON.parse(this.apiKey);
        } catch {
            // apiKey might be a raw OAuth2 token (legacy support)
        }
    }

    /**
     * Get a valid OAuth2 access token, refreshing if needed.
     */
    async _ensureToken() {
        // Legacy: if apiKey is not JSON, treat it as a raw token
        if (!this._serviceAccount) {
            return this.apiKey;
        }

        // Check if current token is still valid
        if (this._accessToken && Date.now() < this._tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
            return this._accessToken;
        }

        // Get a new token
        const { accessToken, expiresAt } = await _getAccessToken(this._serviceAccount);
        this._accessToken = accessToken;
        this._tokenExpiresAt = expiresAt;
        return accessToken;
    }

    /**
     * Pick API version: preview models need v1beta1, stable models use v1.
     */
    _apiVersion(model) {
        return /preview/i.test(model) ? 'v1beta1' : 'v1';
    }

    /**
     * Build the base domain for Vertex AI.
     * 'global' location uses aiplatform.googleapis.com (no prefix).
     * Regional locations use {location}-aiplatform.googleapis.com.
     */
    _buildDomain(location) {
        if (location === 'global') {
            return 'aiplatform.googleapis.com';
        }
        return `${location}-aiplatform.googleapis.com`;
    }

    /**
     * Resolve effective location for a model.
     * Gemini models can use 'global' publisher endpoints.
     * Claude models still need a regional endpoint on Vertex AI.
     */
    _effectiveLocation(model) {
        if (this.location !== 'global') return this.location;
        if (_isClaudeModel(model)) return 'europe-west1';
        return 'global';
    }

    /**
     * Build Vertex AI endpoint URL for Gemini models.
     */
    _buildGeminiUrl(model) {
        const ver = this._apiVersion(model);
        const loc = this._effectiveLocation(model);
        const domain = this._buildDomain(loc);
        return `https://${domain}/${ver}/projects/${this.projectId}/locations/${loc}/publishers/google/models/${model}:generateContent`;
    }

    /**
     * Build Vertex AI endpoint URL for Claude models (rawPredict).
     */
    _buildClaudeUrl(model, { stream = false } = {}) {
        const ver = this._apiVersion(model);
        const loc = this._effectiveLocation(model);
        const domain = this._buildDomain(loc);
        const method = stream ? 'streamRawPredict' : 'rawPredict';
        return `https://${domain}/${ver}/projects/${this.projectId}/locations/${loc}/publishers/anthropic/models/${model}:${method}`;
    }

    // ─── Gemini format converters (reused from gemini.js) ────────────────────

    /**
     * Convert OpenAI messages to Gemini contents format.
     */
    _convertMessagesToGemini(messages) {
        const contents = [];
        let systemInstruction = null;

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemInstruction = { parts: [{ text: msg.content }] };
                continue;
            }

            // Flatten tool history to text (Gemini 3.x thought_signature requirement)
            if (msg.role === 'assistant' && msg.tool_calls) {
                const parts = [];
                if (msg.content) parts.push(msg.content);
                for (const tc of msg.tool_calls) {
                    parts.push(`[Called function: ${tc.function.name}(${tc.function.arguments || '{}'})]`);
                }
                contents.push({ role: 'model', parts: [{ text: parts.join('\n') }] });
                continue;
            }

            if (msg.role === 'tool') {
                const name = msg.name || 'unknown';
                contents.push({
                    role: 'user',
                    parts: [{ text: `[Function ${name} returned: ${msg.content || ''}]` }]
                });
                continue;
            }

            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
            });
        }

        // Merge consecutive same-role messages (Gemini requires alternating roles)
        const merged = [];
        for (const c of contents) {
            if (merged.length > 0 && merged[merged.length - 1].role === c.role) {
                merged[merged.length - 1].parts.push(...c.parts);
            } else {
                merged.push({ ...c, parts: [...c.parts] });
            }
        }

        return { contents: merged, systemInstruction };
    }

    /**
     * Strip fields unsupported by Gemini from JSON Schema.
     */
    _cleanSchema(schema) {
        if (!schema || typeof schema !== 'object') {
            return schema;
        }
        if (Array.isArray(schema)) {
            return schema.map(s => this._cleanSchema(s));
        }

        const cleaned = {};
        for (const [key, value] of Object.entries(schema)) {
            if (key === 'const') {
                cleaned.enum = [value];
                continue;
            }

            if (key === 'type') {
                if (Array.isArray(value)) {
                    const nonNullTypes = value.filter(item => item !== 'null');
                    cleaned.type = nonNullTypes[0] || 'string';
                } else {
                    cleaned.type = value;
                }
                continue;
            }

            if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
                cleaned.properties = {};
                for (const [propKey, propValue] of Object.entries(value)) {
                    cleaned.properties[propKey] = this._cleanSchema(propValue);
                }
                continue;
            }

            if (key === 'items') {
                cleaned.items = Array.isArray(value)
                    ? value.map(item => this._cleanSchema(item))
                    : this._cleanSchema(value);
                continue;
            }

            if (key === 'required' && Array.isArray(value)) {
                cleaned.required = value;
                continue;
            }

            if (key === 'enum' && Array.isArray(value)) {
                cleaned.enum = value;
                continue;
            }

            if (['description', 'title', 'format', 'nullable'].includes(key)) {
                cleaned[key] = value;
            }
        }

        if (!cleaned.type) {
            cleaned.type = 'object';
        }
        if (cleaned.type === 'object' && !cleaned.properties) {
            cleaned.properties = {};
        }

        return cleaned;
    }

    /**
     * Convert OpenAI tools to Gemini tools format.
     */
    _convertToolsToGemini(tools) {
        if (!Array.isArray(tools) || tools.length === 0) return null;
        const functionDeclarations = tools
            .filter(t => t.type === 'function' && t.function)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                parameters: this._cleanSchema(t.function.parameters || { type: 'object', properties: {} })
        }));
        return functionDeclarations.length > 0 ? [{ functionDeclarations }] : null;
    }

    _convertAnthropicToolsToGemini(tools) {
        if (!Array.isArray(tools) || tools.length === 0) return null;
        const functionDeclarations = tools.map(tool => ({
            name: tool.name,
            description: tool.description || '',
            parameters: this._cleanSchema(tool.input_schema || { type: 'object', properties: {} })
        }));
        return functionDeclarations.length > 0 ? [{ functionDeclarations }] : null;
    }

    /**
     * Convert Gemini/Vertex response to OpenAI format.
     */
    _convertGeminiResponse(vertexResponse, model) {
        const candidate = vertexResponse.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const usage = vertexResponse.usageMetadata || {};

        const textParts = parts.filter(p => p.text !== undefined && !p.thought);
        const text = textParts.map(p => p.text).join('');

        const functionCalls = parts.filter(p => p.functionCall);
        const toolCalls = functionCalls.map((p, i) => ({
            id: `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args || {})
            }
        }));

        const message = { role: 'assistant', content: text };
        if (toolCalls.length > 0) message.tool_calls = toolCalls;

        return {
            id: `chatcmpl-vertex-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message,
                finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
            }],
            usage: {
                prompt_tokens: usage.promptTokenCount || 0,
                completion_tokens: usage.candidatesTokenCount || 0,
                total_tokens: usage.totalTokenCount || 0
            }
        };
    }

    // ─── Gemini model request ────────────────────────────────────────────────

    async _sendGeminiRequest(body, token) {
        const model = body.model || DEFAULT_MODEL;
        const { contents, systemInstruction } = this._convertMessagesToGemini(body.messages || []);

        const vertexBody = {
            contents,
            generationConfig: {
                maxOutputTokens: body.max_tokens || 8192,
                temperature: body.temperature,
                topP: body.top_p,
            }
        };
        if (systemInstruction) vertexBody.systemInstruction = systemInstruction;

        const vertexTools = this._convertToolsToGemini(body.tools);
        if (vertexTools) {
            vertexBody.tools = vertexTools;
            vertexBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }

        const url = this._buildGeminiUrl(model);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(vertexBody)
        });

        if (!response.ok) return response;

        const data = await response.json();
        return new Response(JSON.stringify(this._convertGeminiResponse(data, model)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async _fetchGeminiWithFallback(modelCandidates, vertexBody, token) {
        let lastErrorResponse = null;

        for (let index = 0; index < modelCandidates.length; index++) {
            const model = modelCandidates[index];
            const response = await fetch(this._buildGeminiUrl(model), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(vertexBody)
            });

            if (response.ok) {
                return { response, model };
            }

            const errorText = await response.text();
            lastErrorResponse = new Response(errorText, {
                status: response.status,
                headers: response.headers
            });

            const canRetry = index < modelCandidates.length - 1 && _isRetryableGeminiModelError(response.status, errorText);
            if (!canRetry) {
                return { response: lastErrorResponse, model };
            }
        }

        return { response: lastErrorResponse, model: modelCandidates[modelCandidates.length - 1] };
    }

    // ─── Claude model request (rawPredict → Anthropic Messages format) ──────

    /**
     * Convert OpenAI Chat Completions messages to Anthropic Messages format.
     * Extracts system messages to top-level 'system' field.
     */
    _convertMessagesToAnthropic(messages) {
        let system = '';
        const anthropicMessages = [];

        for (const msg of messages) {
            if (msg.role === 'system') {
                system += (system ? '\n' : '') + msg.content;
                continue;
            }

            if (msg.role === 'assistant' && msg.tool_calls) {
                // Convert OpenAI tool_calls to Anthropic tool_use content blocks
                const content = [];
                if (msg.content) content.push({ type: 'text', text: msg.content });
                for (const tc of msg.tool_calls) {
                    let input = {};
                    try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
                    content.push({
                        type: 'tool_use',
                        id: tc.id,
                        name: tc.function.name,
                        input
                    });
                }
                anthropicMessages.push({ role: 'assistant', content });
                continue;
            }

            if (msg.role === 'tool') {
                anthropicMessages.push({
                    role: 'user',
                    content: [{
                        type: 'tool_result',
                        tool_use_id: msg.tool_call_id,
                        content: msg.content || ''
                    }]
                });
                continue;
            }

            anthropicMessages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content || ''
            });
        }

        return { system, messages: anthropicMessages };
    }

    /**
     * Convert OpenAI tools to Anthropic tools format.
     */
    _convertToolsToAnthropic(tools) {
        if (!Array.isArray(tools) || tools.length === 0) return null;
        return tools
            .filter(t => t.type === 'function' && t.function)
            .map(t => ({
                name: t.function.name,
                description: t.function.description || '',
                input_schema: t.function.parameters || { type: 'object', properties: {} }
            }));
    }

    /**
     * Convert Anthropic Messages response to OpenAI Chat Completions format.
     */
    _convertAnthropicResponse(anthropicResponse, model) {
        const content = anthropicResponse.content || [];
        const textParts = content.filter(c => c.type === 'text');
        const toolUseParts = content.filter(c => c.type === 'tool_use');

        const text = textParts.map(c => c.text).join('');
        const message = { role: 'assistant', content: text };

        if (toolUseParts.length > 0) {
            message.tool_calls = toolUseParts.map(c => ({
                id: c.id,
                type: 'function',
                function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input || {})
                }
            }));
        }

        return {
            id: `chatcmpl-vertex-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message,
                finish_reason: toolUseParts.length > 0 ? 'tool_calls' : 'stop'
            }],
            usage: {
                prompt_tokens: anthropicResponse.usage?.input_tokens || 0,
                completion_tokens: anthropicResponse.usage?.output_tokens || 0,
                total_tokens: (anthropicResponse.usage?.input_tokens || 0) + (anthropicResponse.usage?.output_tokens || 0)
            }
        };
    }

    _convertAnthropicToGemini(messages, system) {
        const contents = [];
        let systemInstruction = null;
        const toolNamesById = new Map();

        if (system) {
            const text = typeof system === 'string'
                ? system
                : Array.isArray(system)
                    ? system.filter(block => block?.type === 'text').map(block => block.text).join('\n')
                    : '';
            if (text) {
                systemInstruction = { parts: [{ text }] };
            }
        }

        for (const msg of messages || []) {
            const role = msg.role === 'assistant' ? 'model' : 'user';
            const content = msg.content;

            if (typeof content === 'string') {
                contents.push({ role, parts: [{ text: content }] });
                continue;
            }

            if (!Array.isArray(content)) {
                continue;
            }

            const parts = [];
            for (const block of content) {
                if (block?.type === 'text') {
                    parts.push({ text: block.text || '' });
                    continue;
                }

                if (block?.type === 'tool_use') {
                    if (block.id && block.name) {
                        toolNamesById.set(block.id, block.name);
                    }
                    parts.push({
                        functionCall: {
                            name: block.name,
                            args: block.input || {}
                        }
                    });
                    continue;
                }

                if (block?.type === 'tool_result') {
                    const responseText = typeof block.content === 'string'
                        ? block.content
                        : Array.isArray(block.content)
                            ? block.content
                                .filter(item => item?.type === 'text')
                                .map(item => item.text || '')
                                .join('\n')
                            : JSON.stringify(block.content ?? '');
                    const functionName = toolNamesById.get(block.tool_use_id) || 'tool_result';
                    parts.push({
                        functionResponse: {
                            name: functionName,
                            response: {
                                tool_use_id: block.tool_use_id,
                                content: block.is_error ? `Error: ${responseText}` : responseText
                            }
                        }
                    });
                    continue;
                }

                if (block?.type === 'image') {
                    const source = block.source || {};
                    if (source.type === 'base64' && source.data) {
                        parts.push({
                            inlineData: {
                                mimeType: source.media_type || 'image/jpeg',
                                data: source.data
                            }
                        });
                    } else if (source.type === 'url' && source.url) {
                        parts.push({
                            fileData: {
                                mimeType: source.media_type || 'image/jpeg',
                                fileUri: source.url
                            }
                        });
                    }
                }
            }

            if (parts.length > 0) {
                contents.push({ role, parts });
            }
        }

        const merged = [];
        for (const entry of contents) {
            if (merged.length > 0 && merged[merged.length - 1].role === entry.role) {
                merged[merged.length - 1].parts.push(...entry.parts);
            } else {
                merged.push({ ...entry, parts: [...entry.parts] });
            }
        }

        return { contents: merged, systemInstruction };
    }

    _convertGeminiToAnthropic(geminiResponse, originalModel) {
        const candidate = geminiResponse.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const usage = geminiResponse.usageMetadata || {};
        const finishReason = candidate?.finishReason || geminiResponse.finishReason;

        const content = [];
        for (const part of parts) {
            if (part.text !== undefined && !part.thought) {
                content.push({ type: 'text', text: part.text });
            } else if (part.functionCall?.name) {
                content.push({
                    type: 'tool_use',
                    id: part.functionCall.id || _generateAnthropicToolId(),
                    name: part.functionCall.name,
                    input: part.functionCall.args || {}
                });
            }
        }

        if (content.length === 0) {
            content.push({ type: 'text', text: '' });
        }

        const hasToolUse = content.some(block => block.type === 'tool_use');

        return {
            id: _generateAnthropicMessageId(),
            type: 'message',
            role: 'assistant',
            content,
            model: originalModel,
            stop_reason: _mapGeminiFinishReasonToAnthropic(finishReason, hasToolUse),
            stop_sequence: null,
            usage: {
                input_tokens: usage.promptTokenCount || 0,
                output_tokens: usage.candidatesTokenCount || 0
            }
        };
    }

    async _sendClaudeRequest(body, token) {
        const model = body.model;
        const { system, messages } = this._convertMessagesToAnthropic(body.messages || []);

        // rawPredict: model is in the URL, NOT in the body
        const claudeBody = {
            anthropic_version: 'vertex-2023-10-16',
            max_tokens: body.max_tokens || 8192,
            messages,
            stream: false,
        };
        if (system) claudeBody.system = system;
        if (body.temperature !== undefined) claudeBody.temperature = body.temperature;
        if (body.top_p !== undefined) claudeBody.top_p = body.top_p;

        const anthropicTools = this._convertToolsToAnthropic(body.tools);
        if (anthropicTools) claudeBody.tools = anthropicTools;

        const url = this._buildClaudeUrl(model);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(claudeBody)
        });

        if (!response.ok) return response;

        // Convert Anthropic response → OpenAI format
        const data = await response.json();
        return new Response(JSON.stringify(this._convertAnthropicResponse(data, model)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // ─── Anthropic Messages passthrough (for /v1/messages endpoint) ────────

    /**
     * Accept an Anthropic Messages API body directly and forward to Vertex AI
     * Claude rawPredict. No format conversion needed — just auth and URL.
     * Returns a fetch Response object.
     */
    async sendAnthropicRequest(body) {
        const token = await this._ensureToken();
        const model = body.model || 'claude-sonnet-4-6';

        if (_isGeminiModel(model)) {
            const cleanedMessages = cleanCacheControl(body.messages || []);
            const cleanedSystem = _cleanAnthropicSystem(body.system);
            const { contents, systemInstruction } = this._convertAnthropicToGemini(cleanedMessages, cleanedSystem);

            const vertexBody = {
                contents,
                generationConfig: {
                    maxOutputTokens: body.max_tokens || 8192,
                    temperature: body.temperature,
                    topP: body.top_p,
                }
            };
            if (systemInstruction) vertexBody.systemInstruction = systemInstruction;

            const geminiTools = this._convertAnthropicToolsToGemini(body.tools);
            if (geminiTools) {
                vertexBody.tools = geminiTools;
            }

            const { response, model: actualModel } = await this._fetchGeminiWithFallback(_geminiFallbackModels(model), vertexBody, token);
            if (!response.ok) return response;

            const data = await response.json();
            const anthropicResponse = this._convertGeminiToAnthropic(data, model);
            return new Response(JSON.stringify(anthropicResponse), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'x-proxypool-upstream-model': actualModel
                }
            });
        }

        if (!_isClaudeModel(model)) {
            return new Response(JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: `Vertex AI Anthropic bridge only supports Claude or Gemini models, got: ${model}` }
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const isStream = body.stream === true;
        const sanitized = sanitizeClaudeBody(body);
        const cleanedMessages = cleanCacheControl(sanitized.messages || []);
        const cleanedSystem = _cleanAnthropicSystem(sanitized.system);

        // Build rawPredict body: same as Anthropic Messages but with vertex anthropic_version
        const vertexBody = {
            ...sanitized,
            messages: cleanedMessages,
            anthropic_version: 'vertex-2023-10-16'
        };
        if (cleanedSystem !== undefined) {
            vertexBody.system = cleanedSystem;
        }
        // model is in the URL, not the body for rawPredict
        delete vertexBody.model;

        const url = this._buildClaudeUrl(model, { stream: isStream });
        return fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(vertexBody)
        });
    }

    // ─── Public interface ────────────────────────────────────────────────────

    async sendRequest(body) {
        const token = await this._ensureToken();
        const model = body.model || DEFAULT_MODEL;

        if (_isClaudeModel(model)) {
            return this._sendClaudeRequest(body, token);
        }
        return this._sendGeminiRequest(body, token);
    }

    async listModels() {
        try {
            const token = await this._ensureToken();
            const loc = this.location || 'us-central1';
            const domain = this._buildDomain(loc);
            const url = `https://${domain}/v1/projects/${this.projectId}/locations/${loc}/publishers/google/models`;
            const response = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) return [];
            const data = await response.json();
            return (data.models || data.publisherModels || []).map(m => {
                const fullName = m.name || '';
                const id = fullName.split('/').pop() || fullName;
                return { id, name: m.displayName || id };
            });
        } catch {
            return [];
        }
    }

    async validateKey() {
        try {
            const token = await this._ensureToken();
            // Quick validation: try a minimal Gemini request
            const model = 'gemini-2.0-flash';
            const url = this._buildGeminiUrl(model);
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                    generationConfig: { maxOutputTokens: 1 }
                })
            });
            return response.status !== 401 && response.status !== 403;
        } catch {
            return false;
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens);
    }

    get maskedKey() {
        if (this._serviceAccount) {
            const email = this._serviceAccount.client_email || '';
            return email.length > 20 ? email.slice(0, 16) + '...' : email;
        }
        if (!this.apiKey) return '';
        if (this.apiKey.length <= 8) return '****';
        return this.apiKey.slice(0, 4) + '...' + this.apiKey.slice(-4);
    }

    toJSON() {
        return {
            ...super.toJSON(),
            projectId: this.projectId,
            location: this.location
        };
    }

    toSafeJSON() {
        const json = this.toJSON();
        json.apiKey = this.maskedKey;
        json.isAvailable = this.isAvailable;
        json.isRateLimited = this.isRateLimited;
        if (this._serviceAccount) {
            json.serviceAccountEmail = this._serviceAccount.client_email || '';
        }
        return json;
    }

    static get pricing() {
        return getDefaultPricing('vertex-ai');
    }
}

export default VertexAIProvider;
