/**
 * Direct API Client
 * Makes direct HTTP calls to ChatGPT's backend API
 */

import { mergeRequestEchoIntoContext } from './translators/normalizers/request-echo.js';
import { translateRequest, translateResponse } from './translators/registry.js';
import { executeChatGPTResponsesRequest, parseResetTime } from './executors/chatgpt-responses-executor.js';

/**
 * Send a streaming request to ChatGPT API
 */
export async function* sendMessageStream(anthropicRequest, accessToken, accountId, accountRotator = null, currentEmail = null) {
    const modelId = anthropicRequest.model;
    const request = translateRequest('anthropic-messages', 'openai-responses', anthropicRequest, {
        capabilityProfile: 'chatgpt-backend',
        stream: true
    });
    const response = await executeChatGPTResponsesRequest({
        request,
        accessToken,
        accountId,
        modelId,
        accountRotator,
        currentEmail
    });

    yield* translateResponse('openai-responses', 'anthropic-messages', response, mergeRequestEchoIntoContext({
        mode: 'stream',
        model: anthropicRequest.model
    }, request));
}

export async function openMessageStream(anthropicRequest, accessToken, accountId, accountRotator = null, currentEmail = null) {
    const modelId = anthropicRequest.model;
    const request = translateRequest('anthropic-messages', 'openai-responses', anthropicRequest, {
        capabilityProfile: 'chatgpt-backend',
        stream: true
    });

    return executeChatGPTResponsesRequest({
        request,
        accessToken,
        accountId,
        modelId,
        accountRotator,
        currentEmail
    });
}

/**
 * Send a non-streaming request to ChatGPT API
 */
export async function sendMessage(anthropicRequest, accessToken, accountId) {
    const request = translateRequest('anthropic-messages', 'openai-responses', anthropicRequest, {
        capabilityProfile: 'chatgpt-backend',
        stream: false
    });
    const response = await executeChatGPTResponsesRequest({
        request,
        accessToken,
        accountId,
        modelId: anthropicRequest.model
    });
    const apiResponse = await translateResponse('openai-responses', 'anthropic-messages', response, {
        mode: 'parse'
    });

    return translateResponse('openai-responses', 'anthropic-messages', apiResponse, mergeRequestEchoIntoContext({
        model: anthropicRequest.model,
    }, request));
}

export { parseResetTime };

export default {
    sendMessageStream,
    openMessageStream,
    sendMessage,
    parseResetTime
};
