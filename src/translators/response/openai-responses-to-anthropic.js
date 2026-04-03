import crypto from 'crypto';
import { resolveResponseModel } from '../normalizers/request-echo.js';
import { convertResponsesOutputToAnthropicContent } from '../shared/content-blocks.js';
import { normalizeOpenAIResponsesUsage } from '../normalizers/usage.js';
import { inferAnthropicStopReasonFromResponsesResponse } from '../normalizers/responses-events.js';

export const SOURCE_PROTOCOL = 'openai-responses';
export const TARGET_PROTOCOL = 'anthropic-messages';

export function generateMessageId() {
    return `msg_${crypto.randomBytes(16).toString('hex')}`;
}

export function translateOpenAIResponsesToAnthropicMessage(apiResponse, context = {}) {
    const responseModel = resolveResponseModel(apiResponse, context);
    const usage = normalizeOpenAIResponsesUsage(apiResponse?.usage);
    const stopReason = apiResponse?.status === 'incomplete'
        ? 'max_tokens'
        : inferAnthropicStopReasonFromResponsesResponse(apiResponse);

    if (!apiResponse) {
        return {
            id: generateMessageId(),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            model: responseModel,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: normalizeOpenAIResponsesUsage()
        };
    }

    return {
        id: generateMessageId(),
        type: 'message',
        role: 'assistant',
        content: convertResponsesOutputToAnthropicContent(apiResponse.output),
        model: responseModel,
        stop_reason: stopReason,
        stop_sequence: null,
        usage
    };
}

export function convertOutputToAnthropic(output) {
    return convertResponsesOutputToAnthropicContent(output);
}

export default {
    SOURCE_PROTOCOL,
    TARGET_PROTOCOL,
    generateMessageId,
    convertOutputToAnthropic,
    translateOpenAIResponsesToAnthropicMessage
};
