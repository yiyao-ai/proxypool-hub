/**
 * Kilo Streamer
 * Streams OpenAI Chat Completions SSE and converts to Anthropic SSE events
 */

import { generateMessageId, toAnthropicToolId } from './format-converter.js';

export async function* streamOpenAIChat(response, model) {
    const messageId = generateMessageId();
    let hasEmittedStart = false;
    let blockIndex = 0;
    let currentBlockType = null;
    let currentToolCallId = null;
    let currentToolName = null;
    let pendingToolArgs = new Map();
    let stopReason = 'end_turn';
    let usage = { input_tokens: 0, output_tokens: 0 };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const emitMessageStart = () => ({
        event: 'message_start',
        data: {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        }
    });

    const emitContentBlockStart = (contentBlock) => ({
        event: 'content_block_start',
        data: {
            type: 'content_block_start',
            index: blockIndex,
            content_block: contentBlock
        }
    });

    const emitContentBlockDelta = (delta) => ({
        event: 'content_block_delta',
        data: {
            type: 'content_block_delta',
            index: blockIndex,
            delta
        }
    });

    const emitContentBlockStop = () => ({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: blockIndex }
    });

    const startTextBlock = () => {
        currentBlockType = 'text';
        currentToolCallId = null;
        currentToolName = null;
        return emitContentBlockStart({ type: 'text', text: '' });
    };

    const startThinkingBlock = () => {
        currentBlockType = 'thinking';
        currentToolCallId = null;
        currentToolName = null;
        return emitContentBlockStart({ type: 'thinking', thinking: '' });
    };

    const startToolBlock = (toolCall) => {
        currentBlockType = 'tool_use';
        const rawId = toolCall.id || `call_${Math.random().toString(36).slice(2)}`;
        currentToolCallId = toAnthropicToolId(rawId);
        currentToolName = toolCall.function?.name || 'tool';
        stopReason = 'tool_use';
        return emitContentBlockStart({
            type: 'tool_use',
            id: currentToolCallId,
            name: currentToolName,
            input: {}
        });
    };

    const handleDelta = (delta) => {
        const events = [];

        // Handle reasoning/thinking content (from models like MiniMax M2.5)
        const reasoningContent = delta.reasoning || delta.reasoning_content;
        if (reasoningContent) {
            if (!hasEmittedStart) {
                hasEmittedStart = true;
                events.push(emitMessageStart());
                events.push(startThinkingBlock());
            } else if (currentBlockType !== 'thinking') {
                if (currentBlockType === 'thinking') {
                    events.push(emitContentBlockDelta({ type: 'signature_delta', signature: 'kilo-reasoning' }));
                }
                events.push(emitContentBlockStop());
                blockIndex++;
                events.push(startThinkingBlock());
            }

            events.push(emitContentBlockDelta({ type: 'thinking_delta', thinking: reasoningContent }));
        }

        const shouldStartText = (delta.content !== undefined && delta.content !== null) && (
            delta.content.length > 0 || (!hasEmittedStart && !reasoningContent)
        );

        if (shouldStartText) {
            if (!hasEmittedStart) {
                hasEmittedStart = true;
                events.push(emitMessageStart());
                events.push(startTextBlock());
            } else if (currentBlockType !== 'text') {
                if (currentBlockType === 'thinking') {
                    events.push(emitContentBlockDelta({ type: 'signature_delta', signature: 'kilo-reasoning' }));
                }
                events.push(emitContentBlockStop());
                blockIndex++;
                events.push(startTextBlock());
            }

            if (delta.content.length > 0) {
                events.push(emitContentBlockDelta({ type: 'text_delta', text: delta.content }));
            }
        }

        if (Array.isArray(delta.tool_calls)) {
            for (const toolCall of delta.tool_calls) {
                if (!hasEmittedStart) {
                    hasEmittedStart = true;
                    events.push(emitMessageStart());
                }

                const toolId = toolCall.id ? toAnthropicToolId(toolCall.id) : currentToolCallId;

                if (currentBlockType !== 'tool_use' || currentToolCallId !== toolId) {
                    if (currentBlockType) {
                        if (currentBlockType === 'thinking') {
                            events.push(emitContentBlockDelta({ type: 'signature_delta', signature: 'kilo-reasoning' }));
                        }
                        events.push(emitContentBlockStop());
                        blockIndex++;
                    }
                    events.push(startToolBlock(toolCall));
                }

                const argsDelta = toolCall.function?.arguments || '';
                if (argsDelta) {
                    const callIdForArgs = toolCall.id || currentToolCallId;
                    const prev = pendingToolArgs.get(callIdForArgs) || '';
                    pendingToolArgs.set(callIdForArgs, prev + argsDelta);
                    events.push(emitContentBlockDelta({
                        type: 'input_json_delta',
                        partial_json: argsDelta
                    }));
                }
            }
        }

        return events;
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonText = line.slice(5).trim();
            if (!jsonText) continue;
            if (jsonText === '[DONE]') continue;

            try {
                const chunk = JSON.parse(jsonText);

                if (chunk.usage) {
                    usage = {
                        input_tokens: chunk.usage.prompt_tokens || 0,
                        output_tokens: chunk.usage.completion_tokens || 0
                    };
                }

                const choice = chunk.choices?.[0];
                if (!choice) continue;

                const events = handleDelta(choice.delta || {});
                for (const evt of events) {
                    yield evt;
                }

                if (choice.finish_reason) {
                    stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn';
                }
            } catch (err) {
                // ignore malformed chunks
            }
        }
    }

    if (!hasEmittedStart) {
        hasEmittedStart = true;
        yield emitMessageStart();
        yield emitContentBlockStart({ type: 'text', text: '' });
        yield emitContentBlockDelta({ type: 'text_delta', text: '' });
        yield emitContentBlockStop();
    } else if (currentBlockType) {
        if (currentBlockType === 'thinking') {
            yield emitContentBlockDelta({ type: 'signature_delta', signature: 'kilo-reasoning' });
        }
        yield emitContentBlockStop();
    }

    yield {
        event: 'message_delta',
        data: {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage
        }
    };

    yield {
        event: 'message_stop',
        data: { type: 'message_stop' }
    };
}

export default {
    streamOpenAIChat
};
