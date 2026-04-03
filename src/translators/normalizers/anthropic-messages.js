import { cleanCacheControl } from './thinking.js';
import { convertAnthropicUserContent } from './multimodal.js';
import {
    processAnthropicAssistantContent,
    restoreToolUseSignature,
    cacheToolUseSignature,
    cacheReasoningSignature,
    SIGNATURE_CONSTANTS
} from './thinking.js';
import { toOpenAIToolId } from './tool-ids.js';

const { MIN_SIGNATURE_LENGTH } = SIGNATURE_CONSTANTS;

export function extractSystemPrompt(system) {
    if (!system) return undefined;

    if (typeof system === 'string') {
        return system;
    }

    if (Array.isArray(system)) {
        const textParts = system
            .filter(block => block?.type === 'text')
            .map(block => block.text);
        return textParts.join('\n\n') || undefined;
    }

    return undefined;
}

export function convertAnthropicAssistantContent(content) {
    const textParts = [];
    const toolCalls = [];

    if (typeof content === 'string') {
        textParts.push(content);
        return { textParts, toolCalls };
    }

    if (!Array.isArray(content)) {
        return { textParts, toolCalls };
    }

    const processedContent = processAnthropicAssistantContent(content);

    for (const block of processedContent) {
        if (block?.type === 'text') {
            textParts.push(block.text);
            continue;
        }

        if (block?.type === 'thinking') {
            if (block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) {
                cacheReasoningSignature(block.signature, 'openai');
            }
            continue;
        }

        if (block?.type === 'tool_use') {
            let thoughtSignature = block.thoughtSignature;
            if (!thoughtSignature && block.id) {
                thoughtSignature = restoreToolUseSignature(block.id);
            }

            if (thoughtSignature && thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                cacheToolUseSignature(block.id, thoughtSignature);
            }

            const openAIId = toOpenAIToolId(block.id);
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

    return { textParts, toolCalls };
}

export function convertAnthropicMessagesToResponsesInput(messages) {
    if (!Array.isArray(messages)) return [];

    const cleanedMessages = cleanCacheControl(messages);
    const input = [];

    for (const message of cleanedMessages) {
        if (message?.role === 'user') {
            const { textParts, toolResults, imageParts, fileParts } = convertAnthropicUserContent(message.content);

            if (textParts.length > 0 || imageParts.length > 0 || fileParts.length > 0) {
                let content;
                if (imageParts.length > 0 || fileParts.length > 0) {
                    content = [
                        ...textParts.map(text => ({ type: 'input_text', text })),
                        ...imageParts,
                        ...fileParts
                    ];
                } else {
                    content = textParts.length === 1
                        ? textParts[0]
                        : textParts.map(text => ({ type: 'input_text', text }));
                }

                input.push({
                    type: 'message',
                    role: 'user',
                    content
                });
            }

            input.push(...toolResults);
            continue;
        }

        if (message?.role === 'assistant') {
            const { textParts, toolCalls } = convertAnthropicAssistantContent(message.content);

            if (textParts.length > 0) {
                input.push({
                    type: 'message',
                    role: 'assistant',
                    content: textParts.length === 1
                        ? textParts[0]
                        : textParts.map(text => ({ type: 'output_text', text }))
                });
            }

            input.push(...toolCalls);
        }
    }

    return input;
}

export default {
    extractSystemPrompt,
    convertAnthropicAssistantContent,
    convertAnthropicMessagesToResponsesInput
};
