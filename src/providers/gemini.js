/**
 * Google Gemini Provider
 * Forwards requests to Google Gemini API using API keys.
 * Translates OpenAI-format requests to Gemini format and back.
 */

import { BaseProvider } from './base.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';
import { logger } from '../utils/logger.js';
import {
    translateAnthropicToGeminiRequest,
    summarizeAnthropicToolsForGemini
} from '../translators/request/anthropic-to-gemini.js';
import { translateGeminiToAnthropicMessage } from '../translators/response/gemini-to-anthropic.js';
import { resolveAnthropicGeminiCapabilities } from '../translators/registry.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

const DEFAULT_MODEL = 'gemini-3-flash-preview';

function truncateForLog(value, maxLength = 600) {
    const text = String(value || '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength)}...`;
}

function anthropicContentArrayToGeminiParts(content) {
    if (!Array.isArray(content)) return [];

    const parts = [];
    for (const item of content) {
        if (item?.type === 'text') {
            parts.push({ text: item.text || '' });
            continue;
        }
        if (item?.type === 'image') {
            const source = item.source || {};
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

    return parts;
}

function hasGeminiVisionParts(parts) {
    return Array.isArray(parts) && parts.some(part => part?.inlineData || part?.fileData);
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

    _convertAnthropicTools(tools) {
        if (!Array.isArray(tools) || tools.length === 0) return null;
        const functionDeclarations = tools.map(tool => ({
            name: tool.name,
            description: tool.description || '',
            parameters: this._cleanSchema(tool.input_schema || { type: 'object', properties: {} })
        }));
        return functionDeclarations.length > 0 ? [{ functionDeclarations }] : null;
    }

    _summarizeAnthropicTools(tools) {
        if (!Array.isArray(tools) || tools.length === 0) {
            return { count: 0, names: [], firstSchemaPreview: '' };
        }

        const names = tools.slice(0, 5).map(tool => tool?.name || 'unknown');
        const firstTool = tools[0];
        const firstSchema = this._cleanSchema(firstTool?.input_schema || { type: 'object', properties: {} });
        return {
            count: tools.length,
            names,
            firstSchemaPreview: truncateForLog(JSON.stringify(firstSchema))
        };
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
        if (m.startsWith('gemini-')) return model;
        if (m.includes('opus')) return 'gemini-2.5-pro';
        if (m.includes('sonnet')) return DEFAULT_MODEL;
        if (m.includes('haiku')) return 'gemini-2.0-flash';
        return DEFAULT_MODEL;
    }

    // ─── Anthropic Messages → Gemini format ─────────────────────────────────

    _convertAnthropicToGemini(messages, system) {
        const contents = [];
        let systemInstruction = null;
        const toolNamesById = new Map();

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
                        if (block.id && block.name) {
                            toolNamesById.set(block.id, block.name);
                        }
                        parts.push({
                            functionCall: {
                                name: block.name,
                                args: block.input || {}
                            }
                        });
                    } else if (block.type === 'tool_result') {
                        const responseText = typeof block.content === 'string'
                            ? block.content
                            : Array.isArray(block.content)
                                ? block.content
                                    .filter(item => item?.type === 'text')
                                    .map(item => item.text || '')
                                    .join('\n')
                                : JSON.stringify(block.content ?? '');
                        const responseParts = Array.isArray(block.content)
                            ? anthropicContentArrayToGeminiParts(block.content)
                            : [];
                        const functionName = toolNamesById.get(block.tool_use_id) || block.tool_use_id || 'tool_result';

                        if (hasGeminiVisionParts(responseParts)) {
                            logger.info(`[Gemini] Downgrading multimodal tool_result to user parts | tool=${functionName} | tool_use_id=${block.tool_use_id || 'unknown'}`);
                            if (responseText) {
                                parts.push({
                                    text: `[Function ${functionName} returned${block.is_error ? ' with error' : ''}: ${block.is_error ? `Error: ${responseText}` : responseText}]`
                                });
                            }
                            parts.push(...responseParts);
                        } else {
                            parts.push({
                                functionResponse: {
                                    name: functionName,
                                    response: {
                                        tool_use_id: block.tool_use_id,
                                        content: responseParts.length > 0
                                            ? responseParts
                                            : (block.is_error ? `Error: ${responseText}` : responseText)
                                    }
                                }
                            });
                        }
                    } else if (block.type === 'image') {
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
        const finishReason = candidate?.finishReason || geminiResponse.finishReason;

        const content = [];
        for (const part of parts) {
            if (part.text !== undefined && !part.thought) {
                content.push({ type: 'text', text: part.text });
            } else if (part.functionCall?.name) {
                content.push({
                    type: 'tool_use',
                    id: part.functionCall.id || `toolu_${Date.now()}`,
                    name: part.functionCall.name,
                    input: part.functionCall.args || {}
                });
            }
        }
        if (content.length === 0) {
            content.push({ type: 'text', text: '' });
        }

        const hasToolUse = content.some(block => block.type === 'tool_use');
        let stopReason = 'end_turn';
        if (hasToolUse) {
            stopReason = 'tool_use';
        } else if (String(finishReason || '').toUpperCase() === 'MAX_TOKENS') {
            stopReason = 'max_tokens';
        }

        return {
            id: `msg_gemini_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            content,
            model: originalModel,
            stop_reason: stopReason,
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
        const appId = body?._proxypoolAppId || 'unknown-anthropic-client';
        const geminiModel = this._mapToGeminiModel(body.model);
        const capabilities = resolveAnthropicGeminiCapabilities({
            provider: 'gemini',
            appId,
            hasTools: Array.isArray(body.tools) && body.tools.length > 0
        });
        const geminiBody = translateAnthropicToGeminiRequest(body, {
            capabilityProfile: 'gemini',
            onMultimodalToolResultDowngrade: ({ functionName, toolUseId }) => {
                logger.info(`[Gemini] Downgrading multimodal tool_result to user parts | tool=${functionName} | tool_use_id=${toolUseId}`);
            }
        });

        if (capabilities.disableThinkingBudget) {
            const toolSummary = summarizeAnthropicToolsForGemini(body.tools);
            logger.info(`[Gemini] Enabled Claude Code tool compatibility | model=${geminiModel} | tools=${toolSummary.count} | tool_names=${toolSummary.names.join(',')}`);
        }

        const url = `${this.baseUrl}/models/${geminiModel}:generateContent?key=${this.apiKey}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiBody)
        });

        if (!response.ok) {
            const errorText = await response.text();
            const toolSummary = this._summarizeAnthropicTools(body.tools);
            logger.warn(
                `[Gemini] Anthropic bridge upstream error | model=${geminiModel} | app=${appId} | tools=${toolSummary.count} | tool_names=${toolSummary.names.join(',')} | first_tool_schema=${toolSummary.firstSchemaPreview || '(none)'} | body=${truncateForLog(errorText, 1200)}`
            );
            return new Response(errorText, {
                status: response.status,
                headers: response.headers
            });
        }

        const data = await response.json();
        const anthropicResponse = translateGeminiToAnthropicMessage(data, body.model);

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
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens);
    }

    static get pricing() {
        return getDefaultPricing('gemini');
    }
}

export default GeminiProvider;
