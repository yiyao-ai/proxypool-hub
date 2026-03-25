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

import { createSign } from 'crypto';
import { BaseProvider } from './base.js';

const PRICING = {
    'gemini-3.1-pro-preview':        { input: 2.00, output: 12.00 },
    'gemini-3-flash-preview':        { input: 0.50, output: 3.00 },
    'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
    'gemini-2.5-pro':                { input: 1.25, output: 10.00 },
    'gemini-2.5-flash':              { input: 0.30, output: 2.50 },
    'gemini-2.0-flash':              { input: 0.10, output: 0.40 },
    'claude-opus-4-6':               { input: 5.00, output: 25.00 },
    'claude-sonnet-4-6':             { input: 3.00, output: 15.00 },
    'claude-sonnet-4-5':             { input: 3.00, output: 15.00 },
    'claude-haiku-4-5':              { input: 1.00, output: 5.00 },
};

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
     * 'global' doesn't work for model-specific endpoints on Vertex AI.
     * Gemini models → us-central1, Claude models → europe-west1.
     */
    _effectiveLocation(model) {
        if (this.location !== 'global') return this.location;
        if (_isClaudeModel(model)) return 'europe-west1';
        return 'us-central1';
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
        if (!schema || typeof schema !== 'object') return schema;
        if (Array.isArray(schema)) return schema.map(s => this._cleanSchema(s));
        const cleaned = {};
        for (const [key, value] of Object.entries(schema)) {
            if (key === 'additionalProperties') continue;
            cleaned[key] = this._cleanSchema(value);
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

        if (!_isClaudeModel(model)) {
            return new Response(JSON.stringify({
                type: 'error',
                error: { type: 'invalid_request_error', message: `Vertex AI rawPredict only supports Claude models, got: ${model}` }
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        const isStream = body.stream === true;

        // Build rawPredict body: same as Anthropic Messages but with vertex anthropic_version
        const vertexBody = { ...body, anthropic_version: 'vertex-2023-10-16' };
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
        const pricing = PRICING[model];
        if (!pricing) return 0;
        return (inputTokens / 1_000_000) * pricing.input +
               (outputTokens / 1_000_000) * pricing.output;
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
        return PRICING;
    }
}

export default VertexAIProvider;
