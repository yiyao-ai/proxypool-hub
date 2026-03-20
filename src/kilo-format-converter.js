/**
 * Kilo Format Converter
 * Converts between Anthropic Messages API and OpenAI Chat Completions format
 */

import { cleanCacheControl } from './thinking-utils.js';
import { toAnthropicToolId, toOpenAIToolId } from './format-converter.js';

function extractSystemPrompt(system) {
    if (!system) return [];
    if (typeof system === 'string') return [{ role: 'system', content: system }];
    if (Array.isArray(system)) {
        const text = system
            .filter(block => block.type === 'text')
            .map(block => block.text)
            .join('\n\n');
        return text ? [{ role: 'system', content: text }] : [];
    }
    return [];
}

function sanitizeSchema(schema) {
    if (typeof schema !== 'object' || schema === null) {
        return { type: 'object' };
    }

    const result = {};

    for (const [key, value] of Object.entries(schema)) {
        if (key === 'const') {
            result.enum = [value];
            continue;
        }

        if ([
            '$schema', '$id', '$ref', '$defs', '$comment',
            'additionalItems', 'definitions', 'examples',
            'minLength', 'maxLength', 'pattern', 'format',
            'minItems', 'maxItems', 'minimum', 'maximum',
            'exclusiveMinimum', 'exclusiveMaximum',
            'allOf', 'anyOf', 'oneOf', 'not'
        ].includes(key)) {
            continue;
        }

        if (key === 'additionalProperties' && typeof value === 'boolean') {
            continue;
        }

        if (key === 'type' && Array.isArray(value)) {
            const nonNullTypes = value.filter(t => t !== 'null');
            result.type = nonNullTypes.length > 0 ? nonNullTypes[0] : 'string';
            continue;
        }

        if (key === 'properties' && value && typeof value === 'object') {
            result.properties = {};
            for (const [propKey, propValue] of Object.entries(value)) {
                result.properties[propKey] = sanitizeSchema(propValue);
            }
            continue;
        }

        if (key === 'items') {
            if (Array.isArray(value)) {
                result.items = value.map(item => sanitizeSchema(item));
            } else if (typeof value === 'object') {
                result.items = sanitizeSchema(value);
            } else {
                result.items = value;
            }
            continue;
        }

        if (key === 'required' && Array.isArray(value)) {
            result.required = value;
            continue;
        }

        if (key === 'enum' && Array.isArray(value)) {
            result.enum = value;
            continue;
        }

        if (['type', 'description', 'title'].includes(key)) {
            result[key] = value;
        }
    }

    if (!result.type) {
        result.type = 'object';
    }

    if (result.type === 'object' && !result.properties) {
        result.properties = {};
    }

    return result;
}

function convertTools(tools) {
    if (!Array.isArray(tools)) return undefined;
    return tools.map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: sanitizeSchema(tool.input_schema || { type: 'object' })
        }
    }));
}

function convertToolChoice(toolChoice) {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === 'string') return toolChoice;
    if (toolChoice.type === 'tool' && toolChoice.name) {
        return { type: 'function', function: { name: toolChoice.name } };
    }
    return undefined;
}

function normalizeTextBlocks(content) {
    if (typeof content === 'string') return [content];
    if (!Array.isArray(content)) return [];
    return content.filter(block => block.type === 'text').map(block => block.text);
}

function normalizeToolResultContent(block) {
    if (typeof block.content === 'string') return block.content;
    if (Array.isArray(block.content)) {
        return block.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    }
    if (block.content && typeof block.content === 'object') {
        return JSON.stringify(block.content);
    }
    return '';
}

function convertMessages(messages = []) {
    // Clean cache_control from messages first
    const cleanedMessages = cleanCacheControl(messages);
    
    const output = [];

    for (const msg of cleanedMessages) {
        if (msg.role === 'user') {
            const textParts = normalizeTextBlocks(msg.content);
            if (textParts.length > 0) {
                output.push({ role: 'user', content: textParts.join('\n\n') });
            }

            if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === 'tool_result') {
                        output.push({
                            role: 'tool',
                            tool_call_id: toOpenAIToolId(block.tool_use_id),
                            content: normalizeToolResultContent(block)
                        });
                    }
                }
            }
        }

        if (msg.role === 'assistant') {
            const textParts = normalizeTextBlocks(msg.content);
            const toolCalls = [];

            if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                    if (block.type === 'tool_use') {
                        const openAIId = toOpenAIToolId(block.id);
                        toolCalls.push({
                            id: openAIId,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: typeof block.input === 'string'
                                    ? block.input
                                    : JSON.stringify(block.input || {})
                            }
                        });
                    }
                }
            }

            if (textParts.length > 0 || toolCalls.length > 0) {
                const message = {
                    role: 'assistant',
                    content: textParts.length > 0 ? textParts.join('\n\n') : null
                };

                if (toolCalls.length > 0) {
                    message.tool_calls = toolCalls;
                }

                output.push(message);
            }
        }
    }

    return output;
}

export function convertAnthropicToOpenAIChat(anthropicRequest, targetModel) {
    const { system, messages, tools, tool_choice, max_tokens, temperature, top_p, stop_sequences, stream } = anthropicRequest;

    const convertedMessages = [
        ...extractSystemPrompt(system),
        ...convertMessages(messages || [])
    ];

    const request = {
        model: targetModel,
        messages: convertedMessages,
        stream: stream !== false
    };

    if (typeof max_tokens === 'number') request.max_tokens = max_tokens;
    if (typeof temperature === 'number') request.temperature = temperature;
    if (typeof top_p === 'number') request.top_p = top_p;
    if (Array.isArray(stop_sequences) && stop_sequences.length > 0) request.stop = stop_sequences;

    const convertedTools = convertTools(tools);
    if (convertedTools?.length) request.tools = convertedTools;

    const convertedToolChoice = convertToolChoice(tool_choice);
    if (convertedToolChoice) request.tool_choice = convertedToolChoice;

    return request;
}

export function convertOpenAIChatToAnthropic(openAiResponse) {
    const message = openAiResponse?.choices?.[0]?.message || {};
    const content = [];

    if (message.reasoning || message.reasoning_content) {
        content.push({ 
            type: 'thinking', 
            thinking: message.reasoning || message.reasoning_content,
            signature: 'kilo-reasoning' // Placeholder signature
        });
    }

    if (message.content) {
        content.push({ type: 'text', text: message.content });
    }

    if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
            let input = {};
            try {
                input = typeof call.function?.arguments === 'string'
                    ? JSON.parse(call.function.arguments)
                    : call.function?.arguments || {};
            } catch (error) {
                input = {};
            }

            content.push({
                type: 'tool_use',
                id: toAnthropicToolId(call.id),
                name: call.function?.name || 'unknown',
                input
            });
        }
    }

    const finishReason = openAiResponse?.choices?.[0]?.finish_reason;
    const stopReason = finishReason === 'tool_calls' ? 'tool_use' : 'end_turn';

    return {
        content: content.length > 0 ? content : [{ type: 'text', text: '' }],
        stopReason,
        usage: {
            input_tokens: openAiResponse?.usage?.prompt_tokens || 0,
            output_tokens: openAiResponse?.usage?.completion_tokens || 0
        }
    };
}

export default {
    convertAnthropicToOpenAIChat,
    convertOpenAIChatToAnthropic
};
