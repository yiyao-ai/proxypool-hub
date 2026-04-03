import { extractSystemPrompt, convertAnthropicMessagesToResponsesInput } from '../normalizers/anthropic-messages.js';
import { attachRequestEcho, buildRequestEcho } from '../normalizers/request-echo.js';
import { normalizeAnthropicResponsesRequestOptions } from '../normalizers/responses-request.js';
import {
    convertAnthropicToolChoiceToOpenAIResponses,
    convertAnthropicToolsToOpenAIResponses
} from '../normalizers/tools.js';

export const SOURCE_PROTOCOL = 'anthropic-messages';
export const TARGET_PROTOCOL = 'openai-responses';

export function translateAnthropicToOpenAIResponsesRequest(anthropicRequest, context = {}) {
    const instructions = extractSystemPrompt(anthropicRequest.system);
    const { normalized: requestOptions, requestEcho } = normalizeAnthropicResponsesRequestOptions(
        anthropicRequest,
        {
            parallelToolCalls: context.parallelToolCalls,
            store: context.store
        }
    );
    const {
        canonicalTools,
        tools,
        unsupportedTools
    } = convertAnthropicToolsToOpenAIResponses(anthropicRequest.tools, {
        unsupportedHostedToolsAction: 'omit'
    });
    const {
        value: toolChoice,
        meta: toolChoiceMeta
    } = convertAnthropicToolChoiceToOpenAIResponses(
        anthropicRequest.tool_choice,
        canonicalTools,
        { fallbackValue: 'auto' }
    );

    const request = {
        model: anthropicRequest.model || context.defaultModel || 'gpt-5.2-codex',
        input: convertAnthropicMessagesToResponsesInput(anthropicRequest.messages || []),
        tools,
        tool_choice: toolChoice,
        ...requestOptions,
        stream: context.stream ?? anthropicRequest.stream ?? true,
        include: [],
        instructions: instructions || ''
    };

    attachRequestEcho(request, buildRequestEcho({
        model: request.model,
        instructions: request.instructions,
        tool_choice: request.tool_choice,
        tools: request.tools
    }, requestEcho));

    if (unsupportedTools.length > 0 || toolChoiceMeta) {
        Object.defineProperty(request, '__translatorMeta', {
            value: {
                ...(request.__translatorMeta || {}),
                unsupportedTools,
                toolChoiceMeta
            },
            enumerable: false,
            configurable: true
        });
    }

    return request;
}

export default {
    SOURCE_PROTOCOL,
    TARGET_PROTOCOL,
    translateAnthropicToOpenAIResponsesRequest
};
