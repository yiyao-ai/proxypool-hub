/**
 * Shared SSE emitter for OpenAI Responses API format.
 * Used by both responses-route.js and codex-route.js to simulate
 * streaming events when routing through API key providers.
 *
 * Emits the full event sequence that Codex CLI expects:
 *   response.created → output_item.added → content_part.added →
 *   output_text.delta (chunks) → output_text.done → content_part.done →
 *   output_item.done → response.completed
 */

/**
 * Send a complete Responses API SSE event sequence on an Express response.
 * @param {object} res - Express response object
 * @param {object} responsesFormat - Completed response in Responses API format
 */
export function sendResponsesSSE(res, responsesFormat) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // 1. response.created — initial response object (status: in_progress)
    const inProgress = { ...responsesFormat, status: 'in_progress', output: [] };
    sse('response.created', { type: 'response.created', response: inProgress });
    sse('response.in_progress', { type: 'response.in_progress', response: inProgress });

    const emitOutputItemLifecycle = (item, outputIndex, interimItem = item) => {
        sse('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outputIndex,
            item: interimItem
        });
        sse('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: outputIndex,
            item: item
        });
    };

    let outputIndex = 0;
    for (const item of responsesFormat.output || []) {
        if (item.type === 'message') {
            // response.output_item.added
            const msgItem = { ...item, status: 'in_progress', content: [] };
            sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: msgItem });

            // For each content part
            if (item.content) {
                for (let ci = 0; ci < item.content.length; ci++) {
                    const part = item.content[ci];

                    // response.content_part.added
                    sse('response.content_part.added', {
                        type: 'response.content_part.added',
                        item_id: item.id,
                        output_index: outputIndex,
                        content_index: ci,
                        part: { type: 'output_text', text: '' }
                    });

                    // response.output_text.delta — send in chunks
                    const text = part.text || '';
                    const CHUNK_SIZE = 40;
                    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
                        sse('response.output_text.delta', {
                            type: 'response.output_text.delta',
                            item_id: item.id,
                            output_index: outputIndex,
                            content_index: ci,
                            delta: text.slice(i, i + CHUNK_SIZE)
                        });
                    }

                    // response.output_text.done
                    sse('response.output_text.done', {
                        type: 'response.output_text.done',
                        item_id: item.id,
                        output_index: outputIndex,
                        content_index: ci,
                        text: text
                    });

                    // response.content_part.done
                    sse('response.content_part.done', {
                        type: 'response.content_part.done',
                        item_id: item.id,
                        output_index: outputIndex,
                        content_index: ci,
                        part: part
                    });
                }
            }

            // response.output_item.done
            sse('response.output_item.done', {
                type: 'response.output_item.done',
                output_index: outputIndex,
                item: item
            });

        } else if (item.type === 'function_call') {
            // response.output_item.added
            const fcItem = { ...item, status: item.status || 'in_progress', arguments: '' };
            sse('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: outputIndex,
                item: fcItem
            });

            // response.function_call_arguments.delta
            const args = item.arguments || '{}';
            sse('response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta',
                output_index: outputIndex,
                item_id: item.id,
                call_id: item.call_id,
                name: item.name,
                delta: args
            });

            // response.function_call_arguments.done
            sse('response.function_call_arguments.done', {
                type: 'response.function_call_arguments.done',
                output_index: outputIndex,
                item_id: item.id,
                call_id: item.call_id,
                name: item.name,
                arguments: args
            });

            // response.output_item.done
            sse('response.output_item.done', {
                type: 'response.output_item.done',
                output_index: outputIndex,
                item: item
            });
        } else if (item.type === 'custom_tool_call') {
            const customItem = { ...item, status: item.status || 'in_progress', input: '' };
            sse('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: outputIndex,
                item: customItem
            });

            const input = item.input || '';
            sse('response.custom_tool_call_input.delta', {
                type: 'response.custom_tool_call_input.delta',
                output_index: outputIndex,
                item_id: item.id,
                call_id: item.call_id,
                name: item.name,
                delta: input
            });
            sse('response.custom_tool_call_input.done', {
                type: 'response.custom_tool_call_input.done',
                output_index: outputIndex,
                item_id: item.id,
                call_id: item.call_id,
                name: item.name,
                input: input
            });

            sse('response.output_item.done', {
                type: 'response.output_item.done',
                output_index: outputIndex,
                item: item
            });
        } else if (
            item.type === 'apply_patch_call' ||
            item.type === 'shell_call' ||
            item.type === 'local_shell_call' ||
            item.type === 'mcp_call' ||
            item.type === 'mcp_approval_request'
        ) {
            emitOutputItemLifecycle(item, outputIndex, { ...item, status: 'in_progress' });
        }
        outputIndex++;
    }

    // Final: response.completed
    sse('response.completed', { type: 'response.completed', response: responsesFormat });
    res.end();
}
