/**
 * Format Converter
 * Converts between Anthropic Messages API and OpenAI Responses API format
 */

import crypto from 'crypto';
import { cleanCacheControl, processAssistantContent, hasUnsignedThinkingBlocks } from './thinking-utils.js';
import { getCachedSignature, cacheSignature, cacheThinkingSignature, SIGNATURE_CONSTANTS } from './signature-cache.js';

const { MIN_SIGNATURE_LENGTH } = SIGNATURE_CONSTANTS;

/**
 * Convert Anthropic tool ID to OpenAI fc_ format
 * Deterministic: strips toolu_/call_ prefix, adds fc_ prefix
 * @param {string} anthropicId - Original Anthropic tool ID (e.g., toolu_abc123)
 * @returns {string} OpenAI fc_ format ID (e.g., fc_abc123)
 */
function toOpenAIToolId(anthropicId) {
    if (!anthropicId) return `fc_${crypto.randomBytes(12).toString('hex')}`;
    if (anthropicId.startsWith('fc_')) return anthropicId;

    // Strip known prefixes and add fc_ prefix
    const baseId = anthropicId.replace(/^(call_|toolu_)/, '');
    return `fc_${baseId}`;
}

/**
 * Convert OpenAI fc_ ID back to Anthropic toolu_ format
 * Deterministic: strips fc_ prefix, adds toolu_ prefix
 * This is the inverse of toOpenAIToolId
 * @param {string} openAIId - OpenAI fc_ format ID (e.g., fc_abc123)
 * @returns {string} Anthropic toolu_ format ID (e.g., toolu_abc123)
 */
function toAnthropicToolId(openAIId) {
    if (!openAIId) return `toolu_${crypto.randomBytes(12).toString('hex')}`;
    if (openAIId.startsWith('toolu_')) return openAIId;

    // Strip fc_ prefix and add toolu_ prefix
    const baseId = openAIId.replace(/^fc_/, '');
    return `toolu_${baseId}`;
}

function extractSystemPrompt(system) {
    if (!system) {
        return undefined;
    }
    
    if (typeof system === 'string') {
        return system;
    }
    
    if (Array.isArray(system)) {
        const textParts = system
            .filter(block => block.type === 'text')
            .map(block => block.text);
        return textParts.join('\n\n') || undefined;
    }
    
    return undefined;
}

/**
 * Convert Anthropic Messages API request to OpenAI Responses API format
 */
export function convertAnthropicToResponsesAPI(anthropicRequest) {
    const { model, messages, system, tools, tool_choice } = anthropicRequest;

    // [CRITICAL] Clean cache_control from all messages FIRST
    // Claude Code CLI sends cache_control fields that the API rejects
    const cleanedMessages = cleanCacheControl(messages || []);

    const instructions = extractSystemPrompt(system);

    const request = {
        model: model || 'gpt-5.2-codex',
        input: convertMessagesToInput(cleanedMessages),
        tools: tools ? convertAnthropicToolsToOpenAI(tools) : [],
        tool_choice: tool_choice || 'auto',
        parallel_tool_calls: true,
        store: false,
        stream: true,
        include: []
    };
    
    if (instructions) {
        request.instructions = instructions;
    } else {
        request.instructions = '';
    }

    return request;
}

/**
 * Convert Anthropic messages to OpenAI Responses API input format
 */
function convertMessagesToInput(messages) {
    if (!Array.isArray(messages)) {
        return [];
    }

    const input = [];

    for (const msg of messages) {
        if (msg.role === 'user') {
            const { textParts, toolResults, imageParts } = convertUserContent(msg.content);
            
            if (textParts.length > 0 || (imageParts && imageParts.length > 0)) {
                // API accepts: string OR array of {type: 'input_text', text: '...'}
                // Or for multimodal: array of blocks
                let content;
                if (imageParts && imageParts.length > 0) {
                    content = [
                        ...textParts.map(text => ({ type: 'input_text', text })),
                        ...imageParts
                    ];
                } else {
                    content = textParts.length === 1 
                        ? textParts[0]  // Use string for single text
                        : textParts.map(text => ({ type: 'input_text', text }));
                }

                input.push({
                    type: 'message',
                    role: 'user',
                    content
                });
            }
            
            for (const result of toolResults) {
                input.push(result);
            }
        } else if (msg.role === 'assistant') {
            // Process assistant content: restore signatures, reorder, sanitize
            let msgContent = msg.content;
            if (Array.isArray(msgContent)) {
                msgContent = processAssistantContent(msgContent);
            }
            
            const { textParts, toolCalls } = convertAssistantContentToOpenAI(msgContent);
            
            if (textParts.length > 0) {
                // API accepts: string OR array of {type: 'output_text', text: '...'}
                const content = textParts.length === 1 
                    ? textParts[0]  // Use string for single text
                    : textParts.map(text => ({ type: 'output_text', text }));
                input.push({
                    type: 'message',
                    role: 'assistant',
                    content
                });
            }
            
            for (const call of toolCalls) {
                input.push(call);
            }
        }
    }

    return input;
}

/**
 * Convert user content, separating text and tool results
 */
function convertUserContent(content) {
    const textParts = [];
    const toolResults = [];
    const imageParts = [];
    
    if (typeof content === 'string') {
        textParts.push(content);
    } else if (Array.isArray(content)) {
        for (const block of content) {
            if (block.type === 'text') {
                textParts.push(block.text);
            } else if (block.type === 'image') {
                // Convert Anthropic image to Codex input_image
                if (block.source && block.source.type === 'base64') {
                    imageParts.push({
                        type: 'input_image',
                        data: block.source.data
                    });
                }
            } else if (block.type === 'tool_result') {
                const outputContent = typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content)
                        ? block.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
                        : JSON.stringify(block.content);

                // Convert to OpenAI fc_ format
                const callId = toOpenAIToolId(block.tool_use_id);

                toolResults.push({
                    type: 'function_call_output',
                    call_id: callId,
                    output: block.is_error ? `Error: ${outputContent}` : outputContent
                });
            }
        }
    }
    
    return { textParts, toolResults };
}

/**
 * Convert Anthropic assistant content to OpenAI format
 */
function convertAssistantContentToOpenAI(content) {
    const textParts = [];
    const toolCalls = [];
    
    if (typeof content === 'string') {
        textParts.push(content);
    } else if (Array.isArray(content)) {
        for (const block of content) {
            if (block.type === 'text') {
                textParts.push(block.text);
            } else if (block.type === 'thinking') {
                // Handle thinking blocks - they may have signatures we need to cache
                if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
                    cacheThinkingSignature(block.signature, 'openai');
                }
                // For now, we don't include thinking in the output
                // The API will regenerate thinking as needed
            } else if (block.type === 'tool_use') {
                // Convert to OpenAI fc_ format while preserving mapping
                const openAIId = toOpenAIToolId(block.id);

                // Restore thoughtSignature from cache if missing (Claude Code strips it)
                let thoughtSignature = block.thoughtSignature;
                if (!thoughtSignature && block.id) {
                    thoughtSignature = getCachedSignature(block.id);
                    if (thoughtSignature) {
                        console.log(`[FormatConverter] Restored signature from cache for tool: ${block.id}`);
                    }
                }

                // Cache the signature for future restoration (keyed by original ID)
                if (thoughtSignature && thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                    cacheSignature(block.id, thoughtSignature);
                }

                toolCalls.push({
                    type: 'function_call',
                    id: openAIId,
                    call_id: openAIId,
                    name: block.name,
                    arguments: typeof block.input === 'string'
                        ? block.input
                        : JSON.stringify(block.input)
                });
            }
        }
    }
    
    return { textParts, toolCalls };
}

/**
 * Convert Anthropic tools to OpenAI function format
 */
function convertAnthropicToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) {
        return [];
    }

    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: sanitizeSchema(tool.input_schema || { type: 'object' })
    }));
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

/**
 * Convert OpenAI Responses API output to Anthropic content blocks
 */
export function convertOutputToAnthropic(output) {
    if (!Array.isArray(output)) {
        return [{ type: 'text', text: '' }];
    }

    const content = [];
    
    for (const item of output) {
        if (item.type === 'message') {
            for (const part of item.content || []) {
                if (part.type === 'output_text') {
                    content.push({ type: 'text', text: part.text });
                }
            }
        } else if (item.type === 'function_call') {
            let input = {};
            try {
                input = typeof item.arguments === 'string'
                    ? JSON.parse(item.arguments)
                    : item.arguments || {};
            } catch (e) {
                input = {};
            }

            // Convert OpenAI fc_ ID back to original Anthropic ID
            const openAIId = item.call_id || item.id;
            const toolId = toAnthropicToolId(openAIId);

            const toolUseBlock = {
                type: 'tool_use',
                id: toolId,
                name: item.name,
                input: input
            };

            // Cache signature if present (keyed by original Anthropic ID)
            if (item.signature && item.signature.length >= MIN_SIGNATURE_LENGTH) {
                toolUseBlock.thoughtSignature = item.signature;
                cacheSignature(toolId, item.signature);
            }

            content.push(toolUseBlock);
        } else if (item.type === 'reasoning') {
            const signature = item.signature || '';
            
            // Cache thinking signature
            if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                cacheThinkingSignature(signature, 'openai');
            }
            
            content.push({
                type: 'thinking',
                thinking: item.text || item.content || '',
                signature: signature
            });
        }
    }

    return content.length > 0 ? content : [{ type: 'text', text: '' }];
}

/**
 * Generate Anthropic message ID
 */
export function generateMessageId() {
    return `msg_${crypto.randomBytes(16).toString('hex')}`;
}

export {
    toOpenAIToolId,
    toAnthropicToolId
};

export default {
    convertAnthropicToResponsesAPI,
    convertOutputToAnthropic,
    generateMessageId,
    toOpenAIToolId,
    toAnthropicToolId
};
