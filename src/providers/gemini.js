/**
 * Google Gemini Provider
 * Forwards requests to Google Gemini API using API keys.
 * Translates OpenAI-format requests to Gemini format and back.
 */

import { BaseProvider } from './base.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const PRICING = {
    'gemini-3.1-pro-preview':        { input: 2.00, output: 12.00 },
    'gemini-3-flash-preview':        { input: 0.50, output: 3.00 },
    'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
    'gemini-2.5-pro':                { input: 1.25, output: 10.00 },
    'gemini-2.5-flash':              { input: 0.30, output: 2.50 },
    'gemini-2.0-flash':              { input: 0.10, output: 0.40 },
};

const DEFAULT_MODEL = 'gemini-3-flash-preview';

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
     * Handles text, tool_calls (assistant→functionCall), and tool results (tool→functionResponse).
     */
    _convertMessages(messages) {
        const contents = [];
        let systemInstruction = null;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];

            if (msg.role === 'system') {
                systemInstruction = { parts: [{ text: msg.content }] };
                continue;
            }

            // Assistant message with tool_calls → convert to plain text summary
            // Gemini 3.x requires thought_signature on functionCall parts which we can't preserve
            // through OpenAI format conversion, so we flatten tool history to text.
            if (msg.role === 'assistant' && msg.tool_calls) {
                const parts = [];
                if (msg.content) parts.push(msg.content);
                for (const tc of msg.tool_calls) {
                    parts.push(`[Called function: ${tc.function.name}(${tc.function.arguments || '{}'})]`);
                }
                contents.push({ role: 'model', parts: [{ text: parts.join('\n') }] });
                continue;
            }

            // Tool result message → convert to plain text
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

        // Gemini requires alternating user/model roles — merge consecutive same-role messages
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
     * Strip fields unsupported by Gemini from JSON Schema (e.g. additionalProperties).
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
     * Convert OpenAI tools format to Gemini tools format.
     */
    _convertTools(tools) {
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
     * Convert Gemini response to OpenAI format.
     * Handles text parts, functionCall parts, and thinking parts.
     */
    _convertResponse(geminiResponse, model) {
        const candidate = geminiResponse.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const usage = geminiResponse.usageMetadata || {};

        // Extract text (skip thinking parts)
        const textParts = parts.filter(p => p.text !== undefined && !p.thought);
        const text = textParts.map(p => p.text).join('');

        // Extract function calls
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
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }

        return {
            id: `chatcmpl-gemini-${Date.now()}`,
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

    // ─── Claude model → Gemini model mapping ──────────────────────────────

    _mapToGeminiModel(model) {
        if (!model) return DEFAULT_MODEL;
        const m = model.toLowerCase();
        if (m.includes('opus')) return 'gemini-2.5-pro';
        if (m.includes('sonnet')) return DEFAULT_MODEL;
        if (m.includes('haiku')) return 'gemini-2.0-flash';
        return DEFAULT_MODEL;
    }

    // ─── Anthropic Messages → Gemini format ─────────────────────────────────

    _convertAnthropicToGemini(messages, system) {
        const contents = [];
        let systemInstruction = null;

        // Handle system prompt (string or content block array)
        if (system) {
            const text = typeof system === 'string'
                ? system
                : Array.isArray(system)
                    ? system.filter(b => b.type === 'text').map(b => b.text).join('\n')
                    : '';
            if (text) systemInstruction = { parts: [{ text }] };
        }

        for (const msg of messages) {
            const role = msg.role === 'assistant' ? 'model' : 'user';
            const content = msg.content;

            if (typeof content === 'string') {
                contents.push({ role, parts: [{ text: content }] });
            } else if (Array.isArray(content)) {
                const parts = [];
                for (const block of content) {
                    if (block.type === 'text') {
                        parts.push({ text: block.text });
                    } else if (block.type === 'tool_use') {
                        parts.push({ text: `[Tool call: ${block.name}(${JSON.stringify(block.input)})]` });
                    } else if (block.type === 'tool_result') {
                        const r = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
                        parts.push({ text: `[Tool result: ${r}]` });
                    } else if (block.type === 'thinking') {
                        // skip thinking blocks
                    }
                }
                if (parts.length > 0) contents.push({ role, parts });
            }
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

    // ─── Gemini response → Anthropic Messages format ────────────────────────

    _convertGeminiToAnthropic(geminiResponse, originalModel) {
        const candidate = geminiResponse.candidates?.[0];
        const parts = candidate?.content?.parts || [];
        const usage = geminiResponse.usageMetadata || {};

        const content = [];
        for (const part of parts) {
            if (part.text !== undefined && !part.thought) {
                content.push({ type: 'text', text: part.text });
            }
        }
        if (content.length === 0) {
            content.push({ type: 'text', text: '' });
        }

        return {
            id: `msg_gemini_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content,
            model: originalModel,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: usage.promptTokenCount || 0,
                output_tokens: usage.candidatesTokenCount || 0
            }
        };
    }

    // ─── Anthropic Messages API passthrough (for /v1/messages endpoint) ──────

    /**
     * Accept an Anthropic Messages API body, convert to Gemini format,
     * send to Gemini API, and return response in Anthropic Messages format.
     */
    async sendAnthropicRequest(body) {
        const geminiModel = this._mapToGeminiModel(body.model);
        const { contents, systemInstruction } = this._convertAnthropicToGemini(
            body.messages || [], body.system
        );

        const geminiBody = {
            contents,
            generationConfig: {
                maxOutputTokens: body.max_tokens || 8192,
                temperature: body.temperature,
                topP: body.top_p,
            }
        };
        if (systemInstruction) geminiBody.systemInstruction = systemInstruction;

        const url = `${this.baseUrl}/models/${geminiModel}:generateContent?key=${this.apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiBody)
        });

        if (!response.ok) return response;

        const data = await response.json();
        const anthropicResponse = this._convertGeminiToAnthropic(data, body.model);

        return new Response(JSON.stringify(anthropicResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // ─── OpenAI Chat Completions format (existing) ──────────────────────────

    async sendRequest(body) {
        const model = body.model || DEFAULT_MODEL;
        const { contents, systemInstruction } = this._convertMessages(body.messages || []);

        const geminiBody = {
            contents,
            generationConfig: {
                maxOutputTokens: body.max_tokens || 8192,
                temperature: body.temperature,
                topP: body.top_p,
            }
        };
        if (systemInstruction) {
            geminiBody.systemInstruction = systemInstruction;
        }

        // Convert and attach tools
        const geminiTools = this._convertTools(body.tools);
        if (geminiTools) {
            geminiBody.tools = geminiTools;
            // Gemini 3.x requires thought_signature round-trip for tool calls with thinking enabled.
            // Since we convert between OpenAI↔Gemini formats, we can't preserve thought signatures,
            // so disable thinking when tools are present.
            geminiBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };
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
