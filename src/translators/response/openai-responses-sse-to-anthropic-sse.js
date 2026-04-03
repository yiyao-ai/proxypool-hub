import { toAnthropicToolId } from '../normalizers/tool-ids.js';
import { cacheReasoningSignature, cacheToolUseSignature, SIGNATURE_CONSTANTS } from '../normalizers/thinking.js';
import { normalizeOpenAIResponsesUsage } from '../normalizers/usage.js';
import {
    getCompletedResponseFromEvent,
    getResponsesFunctionArgumentsDelta,
    getResponsesReasoningDelta,
    getResponsesTextDelta,
    inferAnthropicStopReasonFromResponsesResponse,
    normalizeResponsesEventUsage,
    parseResponsesSSEEventLine
} from '../normalizers/responses-events.js';
import { generateMessageId } from './openai-responses-to-anthropic.js';
import {
    buildAnthropicMessageStart,
    buildContentBlockStart,
    buildContentBlockDelta,
    buildContentBlockStop,
    buildMessageDelta,
    buildMessageStop
} from '../shared/sse.js';

const { MIN_SIGNATURE_LENGTH } = SIGNATURE_CONSTANTS;

export async function* streamOpenAIResponsesAsAnthropicEvents(response, model) {
    const messageId = generateMessageId();
    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType = null;
    let currentBlockId = null;
    let currentThinkingSignature = '';
    let stopReason = 'end_turn';
    let usage = normalizeOpenAIResponsesUsage();
    let completedResponse = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const closeCurrentBlock = function* () {
        if (currentBlockType === 'thinking' && currentThinkingSignature) {
            yield buildContentBlockDelta({
                index: blockIndex,
                delta: { type: 'signature_delta', signature: currentThinkingSignature }
            });
            currentThinkingSignature = '';
        }

        yield buildContentBlockStop({ index: blockIndex });
        blockIndex++;
        currentBlockType = null;
        currentBlockId = null;
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const event = parseResponsesSSEEventLine(line);
            if (!event) continue;
                const eventType = event.type;

                const eventUsage = normalizeResponsesEventUsage(event);
                if (eventUsage) {
                    usage = eventUsage;
                }

                const maybeCompletedResponse = getCompletedResponseFromEvent(event);
                if (maybeCompletedResponse) {
                    completedResponse = maybeCompletedResponse;
                    if (maybeCompletedResponse.status === 'incomplete') {
                        stopReason = 'max_tokens';
                    } else if (Array.isArray(maybeCompletedResponse.output)) {
                        stopReason = inferAnthropicStopReasonFromResponsesResponse(maybeCompletedResponse);
                    }
                }

                if (eventType === 'response.output_item.added') {
                    const item = event.item;

                    if (!hasEmittedStart) {
                        hasEmittedStart = true;
                        yield buildAnthropicMessageStart({ messageId, model });
                    }

                    if (currentBlockType !== null) {
                        yield* closeCurrentBlock();
                    }

                    if (item?.type === 'message') {
                        currentBlockType = 'text';
                        currentBlockId = item.id;
                        yield buildContentBlockStart({
                            index: blockIndex,
                            contentBlock: { type: 'text', text: '' }
                        });
                        continue;
                    }

                    if (item?.type === 'function_call') {
                        currentBlockType = 'tool_use';
                        currentBlockId = toAnthropicToolId(item.call_id || item.id);
                        stopReason = 'tool_use';

                        yield buildContentBlockStart({
                            index: blockIndex,
                            contentBlock: {
                                type: 'tool_use',
                                id: currentBlockId,
                                name: item.name,
                                input: {}
                            }
                        });
                        continue;
                    }

                    if (item?.type === 'reasoning') {
                        currentBlockType = 'thinking';
                        currentBlockId = item.id;
                        currentThinkingSignature = '';

                        yield buildContentBlockStart({
                            index: blockIndex,
                            contentBlock: { type: 'thinking', thinking: '' }
                        });
                    }
                }

                const textDelta = getResponsesTextDelta(event);
                if (textDelta) {
                    if (currentBlockType === 'thinking') {
                        yield buildContentBlockDelta({
                            index: blockIndex,
                            delta: { type: 'thinking_delta', thinking: textDelta }
                        });
                    } else if (currentBlockType === 'text') {
                        yield buildContentBlockDelta({
                            index: blockIndex,
                            delta: { type: 'text_delta', text: textDelta }
                        });
                    }
                }

                const reasoningDelta = getResponsesReasoningDelta(event);
                if (reasoningDelta && currentBlockType === 'thinking') {
                    if (event.signature && event.signature.length >= MIN_SIGNATURE_LENGTH) {
                        currentThinkingSignature = event.signature;
                        cacheReasoningSignature(event.signature, 'openai');
                    }

                    yield buildContentBlockDelta({
                        index: blockIndex,
                        delta: { type: 'thinking_delta', thinking: reasoningDelta }
                    });
                }

                const argumentsDelta = getResponsesFunctionArgumentsDelta(event);
                if (argumentsDelta && currentBlockType === 'tool_use') {
                    yield buildContentBlockDelta({
                        index: blockIndex,
                        delta: { type: 'input_json_delta', partial_json: argumentsDelta }
                    });
                }

                if (eventType === 'response.function_call_arguments.done') {
                    if (event.signature && currentBlockId) {
                        cacheToolUseSignature(currentBlockId, event.signature);
                    }
                }

                if (eventType === 'response.output_item.done') {
                    const item = event.item;
                    if (item?.type === 'reasoning' && item.signature && item.signature.length >= MIN_SIGNATURE_LENGTH) {
                        currentThinkingSignature = item.signature;
                        cacheReasoningSignature(item.signature, 'openai');
                    }
                    if (item?.type === 'function_call' && item.signature && currentBlockId) {
                        cacheToolUseSignature(currentBlockId, item.signature);
                    }
                }
        }
    }

    if (!hasEmittedStart) {
        yield buildAnthropicMessageStart({ messageId, model });
        yield buildContentBlockStart({
            index: 0,
            contentBlock: { type: 'text', text: '' }
        });
        yield buildContentBlockDelta({
            index: 0,
            delta: { type: 'text_delta', text: '' }
        });
        yield buildContentBlockStop({ index: 0 });
    } else if (currentBlockType !== null) {
        yield* closeCurrentBlock();
    }

    if (completedResponse && Array.isArray(completedResponse.output) && stopReason !== 'max_tokens') {
        stopReason = inferAnthropicStopReasonFromResponsesResponse(completedResponse);
    }

    yield buildMessageDelta({ stopReason, usage });
    yield buildMessageStop();
}

export async function parseOpenAIResponsesSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResponse = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            const event = parseResponsesSSEEventLine(line);
            if (!event) continue;

            const completedResponse = getCompletedResponseFromEvent(event);
            if (completedResponse) {
                finalResponse = completedResponse;
            }
        }
    }

    return finalResponse;
}

export default {
    streamOpenAIResponsesAsAnthropicEvents,
    parseOpenAIResponsesSSE
};
