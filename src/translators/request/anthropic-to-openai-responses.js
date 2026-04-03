import { extractSystemPrompt, convertAnthropicMessagesToResponsesInput } from '../normalizers/anthropic-messages.js';
import { sanitizeToolSchema } from '../normalizers/schemas.js';
import { normalizeAnthropicResponsesRequestOptions } from '../normalizers/responses-request.js';

export const SOURCE_PROTOCOL = 'anthropic-messages';
export const TARGET_PROTOCOL = 'openai-responses';

function convertAnthropicToolsToOpenAI(tools) {
    if (!Array.isArray(tools)) {
        return [];
    }

    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: sanitizeToolSchema(tool.input_schema || { type: 'object' })
    }));
}

function convertAnthropicToolChoice(toolChoice) {
    if (!toolChoice) {
        return 'auto';
    }

    if (typeof toolChoice === 'string') {
        return toolChoice;
    }

    if (toolChoice.type === 'auto') {
        return 'auto';
    }

    if (toolChoice.type === 'any') {
        return 'required';
    }

    if (toolChoice.type === 'none') {
        return 'none';
    }

    if (toolChoice.type === 'tool' && toolChoice.name) {
        return {
            type: 'function',
            function: { name: toolChoice.name }
        };
    }

    return 'auto';
}

export function translateAnthropicToOpenAIResponsesRequest(anthropicRequest, context = {}) {
    const instructions = extractSystemPrompt(anthropicRequest.system);
    const { normalized: requestOptions, requestEcho } = normalizeAnthropicResponsesRequestOptions(
        anthropicRequest,
        {
            parallelToolCalls: context.parallelToolCalls,
            store: context.store
        }
    );

    const request = {
        model: anthropicRequest.model || context.defaultModel || 'gpt-5.2-codex',
        input: convertAnthropicMessagesToResponsesInput(anthropicRequest.messages || []),
        tools: convertAnthropicToolsToOpenAI(anthropicRequest.tools),
        tool_choice: convertAnthropicToolChoice(anthropicRequest.tool_choice),
        ...requestOptions,
        stream: context.stream ?? anthropicRequest.stream ?? true,
        include: [],
        instructions: instructions || ''
    };

    Object.defineProperty(request, '__translatorMeta', {
        value: {
            requestEcho: {
                model: request.model,
                instructions: request.instructions,
                tool_choice: request.tool_choice,
                tools: request.tools,
                ...requestEcho
            }
        },
        enumerable: false,
        configurable: true
    });

    return request;
}

export default {
    SOURCE_PROTOCOL,
    TARGET_PROTOCOL,
    translateAnthropicToOpenAIResponsesRequest
};
