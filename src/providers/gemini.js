/**
 * Google Gemini Provider
 * Forwards requests to Google Gemini API using API keys.
 * Translates OpenAI-format requests to Gemini format and back.
 */

import { BaseProvider } from './base.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const PRICING = {
    'gemini-2.5-pro':     { input: 1.25, output: 10.00 },
    'gemini-2.5-flash':   { input: 0.15, output: 0.60 },
    'gemini-2.0-flash':   { input: 0.10, output: 0.40 },
    'gemini-1.5-pro':     { input: 1.25, output: 5.00 },
    'gemini-1.5-flash':   { input: 0.075, output: 0.30 },
};

const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Map non-Gemini model names to a Gemini model.
 * When requests come from Codex/Claude with OpenAI model names,
 * we need to route them to an appropriate Gemini model.
 */
function resolveGeminiModel(model) {
    if (!model || model.startsWith('gemini-')) return model || DEFAULT_MODEL;
    // Map OpenAI/other model names to Gemini equivalents
    if (model.includes('gpt-4o-mini') || model.includes('gpt-3.5') || model.includes('mini')) return 'gemini-2.0-flash';
    if (model.includes('gpt-4') || model.includes('gpt-5') || model.includes('o1') || model.includes('o3') || model.includes('o4')) return 'gemini-2.5-flash';
    if (model.includes('claude')) return 'gemini-2.5-pro';
    return DEFAULT_MODEL;
}

export class GeminiProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'gemini',
            baseUrl: config.baseUrl || DEFAULT_BASE_URL
        });
    }

    /**
     * Convert OpenAI messages format to Gemini contents format.
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
     * Convert Gemini response to OpenAI format.
     */
    _convertResponse(geminiResponse, model) {
        const candidate = geminiResponse.candidates?.[0];
        const text = candidate?.content?.parts?.[0]?.text || '';
        const usage = geminiResponse.usageMetadata || {};

        return {
            id: `chatcmpl-gemini-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message: { role: 'assistant', content: text },
                finish_reason: candidate?.finishReason === 'STOP' ? 'stop' : 'stop'
            }],
            usage: {
                prompt_tokens: usage.promptTokenCount || 0,
                completion_tokens: usage.candidatesTokenCount || 0,
                total_tokens: usage.totalTokenCount || 0
            }
        };
    }

    async sendRequest(body) {
        const model = resolveGeminiModel(body.model);
        const { contents, systemInstruction } = this._convertMessages(body.messages || []);

        const geminiBody = {
            contents,
            generationConfig: {
                maxOutputTokens: body.max_tokens || 4096,
                temperature: body.temperature,
                topP: body.top_p,
            }
        };
        if (systemInstruction) {
            geminiBody.systemInstruction = systemInstruction;
        }

        const url = `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiBody)
        });

        if (!response.ok) return response;

        // Convert Gemini response to OpenAI format
        const geminiData = await response.json();
        const openaiData = this._convertResponse(geminiData, model);

        return new Response(JSON.stringify(openaiData), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async validateKey() {
        try {
            const url = `${this.baseUrl}/models?key=${this.apiKey}`;
            const response = await fetch(url);
            return response.ok;
        } catch {
            return false;
        }
    }

    async listModels() {
        try {
            const url = `${this.baseUrl}/models?key=${this.apiKey}`;
            const response = await fetch(url);
            if (!response.ok) return [];
            const data = await response.json();
            return (data.models || []).map(m => ({
                id: m.name?.replace('models/', '') || m.name,
                name: m.displayName || m.name
            }));
        } catch {
            return [];
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        const pricing = PRICING[model];
        if (!pricing) return 0;
        return (inputTokens / 1_000_000) * pricing.input +
               (outputTokens / 1_000_000) * pricing.output;
    }

    static get pricing() {
        return PRICING;
    }
}

export default GeminiProvider;
