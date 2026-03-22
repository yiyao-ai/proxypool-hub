/**
 * Vertex AI Provider
 * Forwards requests to Google Cloud Vertex AI endpoints.
 *
 * Required config:
 *   - apiKey:     OAuth2 Bearer token or API key
 *   - projectId:  GCP project ID
 *   - location:   Region, e.g. us-central1
 *
 * URL format:
 *   https://{location}-aiplatform.googleapis.com/v1/projects/{projectId}/locations/{location}/publishers/google/models/{model}:generateContent
 */

import { BaseProvider } from './base.js';

const PRICING = {
    'gemini-2.5-pro':        { input: 1.25, output: 10.00 },
    'gemini-2.5-flash':      { input: 0.15, output: 0.60 },
    'gemini-2.0-flash':      { input: 0.10, output: 0.40 },
    'gemini-1.5-pro':        { input: 1.25, output: 5.00 },
    'gemini-1.5-flash':      { input: 0.075, output: 0.30 },
    'claude-sonnet-4-5':     { input: 3.00, output: 15.00 },
    'claude-opus-4-5':       { input: 15.00, output: 75.00 },
    'claude-haiku-4-5':      { input: 0.80, output: 4.00 },
};

const DEFAULT_MODEL = 'gemini-2.5-flash';

function resolveVertexModel(model) {
    if (!model) return DEFAULT_MODEL;
    if (model.startsWith('gemini-') || model.startsWith('claude-')) return model;
    if (model.includes('gpt-4o-mini') || model.includes('gpt-3.5') || model.includes('mini')) return 'gemini-2.0-flash';
    if (model.includes('gpt-4') || model.includes('gpt-5') || model.includes('o1') || model.includes('o3') || model.includes('o4')) return 'gemini-2.5-flash';
    return DEFAULT_MODEL;
}

export class VertexAIProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'vertex-ai',
            baseUrl: config.baseUrl || ''
        });
        this.projectId = config.projectId || '';
        this.location = config.location || 'us-central1';
    }

    /**
     * Build Vertex AI endpoint URL for a given model.
     */
    _buildUrl(model) {
        return `https://${this.location}-aiplatform.googleapis.com/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/${model}:generateContent`;
    }

    /**
     * Determine auth headers based on key format.
     */
    _authHeaders() {
        // OAuth tokens start with ya29. or are very long (JWT)
        if (this.apiKey.startsWith('ya29.') || this.apiKey.length > 200) {
            return { 'Authorization': `Bearer ${this.apiKey}` };
        }
        return {};
    }

    /**
     * Build URL with API key appended if not using Bearer auth.
     */
    _authUrl(url) {
        if (this.apiKey.startsWith('ya29.') || this.apiKey.length > 200) {
            return url;
        }
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}key=${this.apiKey}`;
    }

    /**
     * Convert OpenAI messages to Gemini contents format.
     */
    _convertMessages(messages) {
        const contents = [];
        let systemInstruction = null;

        for (const msg of messages) {
            if (msg.role === 'system') {
                systemInstruction = { parts: [{ text: msg.content }] };
                continue;
            }
            contents.push({
                role: msg.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
            });
        }

        return { contents, systemInstruction };
    }

    /**
     * Convert Vertex/Gemini response to OpenAI format.
     */
    _convertResponse(vertexResponse, model) {
        const candidate = vertexResponse.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text || '';
        const usage = vertexResponse.usageMetadata || {};

        return {
            id: `chatcmpl-vertex-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: text },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: usage.promptTokenCount || 0,
                completion_tokens: usage.candidatesTokenCount || 0,
                total_tokens: usage.totalTokenCount || 0
            }
        };
    }

    async sendRequest(body) {
        const model = resolveVertexModel(body.model);
        const { contents, systemInstruction } = this._convertMessages(body.messages || []);

        const vertexBody = {
            contents,
            generationConfig: {
                maxOutputTokens: body.max_tokens || 4096,
                temperature: body.temperature,
                topP: body.top_p,
            }
        };
        if (systemInstruction) {
            vertexBody.systemInstruction = systemInstruction;
        }

        const url = this._authUrl(this._buildUrl(model));
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this._authHeaders()
            },
            body: JSON.stringify(vertexBody)
        });

        if (!response.ok) return response;

        const data = await response.json();
        return new Response(JSON.stringify(this._convertResponse(data, model)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async validateKey() {
        try {
            const model = 'gemini-2.0-flash';
            const url = this._authUrl(this._buildUrl(model));
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...this._authHeaders()
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

    toJSON() {
        return {
            ...super.toJSON(),
            projectId: this.projectId,
            location: this.location
        };
    }

    static get pricing() {
        return PRICING;
    }
}

export default VertexAIProvider;
