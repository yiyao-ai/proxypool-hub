import { cacheToolUseSignature, restoreToolUseSignature, cleanCacheControl, SIGNATURE_CONSTANTS } from '../normalizers/thinking.js';
import { sanitizeGeminiToolSchema } from '../normalizers/gemini-schema.js';
import { toAnthropicToolId } from '../normalizers/tool-ids.js';

const { MIN_SIGNATURE_LENGTH } = SIGNATURE_CONSTANTS;

function extractSystemInstruction(system) {
    if (!system) return null;

    const text = typeof system === 'string'
        ? system
        : Array.isArray(system)
            ? system.filter(block => block?.type === 'text').map(block => block.text).join('\n')
            : '';

    return text ? { parts: [{ text }] } : null;
}

function anthropicContentArrayToGeminiParts(content) {
    if (!Array.isArray(content)) return [];

    const parts = [];
    for (const item of content) {
        if (item?.type === 'text') {
            parts.push({ text: item.text || '' });
            continue;
        }
        if (item?.type === 'image') {
            const source = item.source || {};
            if (source.type === 'base64' && source.data) {
                parts.push({
                    inlineData: {
                        mimeType: source.media_type || 'image/jpeg',
                        data: source.data
                    }
                });
            } else if (source.type === 'url' && source.url) {
                parts.push({
                    fileData: {
                        mimeType: source.media_type || 'image/jpeg',
                        fileUri: source.url
                    }
                });
            }
        }
        if (item?.type === 'document' || item?.type === 'file') {
            const source = item.source || {};
            if (source.type === 'base64' && source.data) {
                parts.push({
                    inlineData: {
                        mimeType: source.media_type || 'application/octet-stream',
                        data: source.data
                    }
                });
            } else if (source.type === 'url' && source.url) {
                parts.push({
                    fileData: {
                        mimeType: source.media_type || 'application/octet-stream',
                        fileUri: source.url
                    }
                });
            } else if (typeof item.file_data === 'string' && item.file_data.startsWith('data:')) {
                const trimmed = item.file_data.slice(5);
                const [header, data = ''] = trimmed.split(';base64,');
                if (data) {
                    parts.push({
                        inlineData: {
                            mimeType: item.media_type || header || 'application/octet-stream',
                            data
                        }
                    });
                }
            } else if (typeof item.file_url === 'string' && item.file_url.length > 0) {
                parts.push({
                    fileData: {
                        mimeType: item.media_type || 'application/octet-stream',
                        fileUri: item.file_url
                    }
                });
            }
        }
    }

    return parts;
}

function hasGeminiVisionParts(parts) {
    return Array.isArray(parts) && parts.some(part => part?.inlineData || part?.fileData);
}

function convertAnthropicToolsToGemini(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return null;
    return [{
        functionDeclarations: tools.map(tool => ({
            name: tool.name,
            description: tool.description || '',
            parameters: sanitizeGeminiToolSchema(tool.input_schema || { type: 'object', properties: {} })
        }))
    }];
}

function summarizeAnthropicToolsForGemini(tools) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return { count: 0, names: [], firstSchemaPreview: '' };
    }

    const names = tools.slice(0, 5).map(tool => tool?.name || 'unknown');
    const firstSchema = sanitizeGeminiToolSchema(tools[0]?.input_schema || { type: 'object', properties: {} });
    return {
        count: tools.length,
        names,
        firstSchemaPreview: JSON.stringify(firstSchema)
    };
}

export function translateAnthropicToGeminiRequest(body, context = {}) {
    const messages = cleanCacheControl(body.messages || []);
    const contents = [];
    const toolNamesById = new Map();
    const toolEncodingById = new Map();

    for (const msg of messages) {
        const role = msg.role === 'assistant' ? 'model' : 'user';
        const content = msg.content;

        if (typeof content === 'string') {
            contents.push({ role, parts: [{ text: content }] });
            continue;
        }

        if (!Array.isArray(content)) {
            continue;
        }

        const parts = [];
        for (const block of content) {
            if (block?.type === 'text') {
                parts.push({ text: block.text || '' });
                continue;
            }

            if (block?.type === 'tool_use') {
                let thoughtSignature = block.thoughtSignature;
                if (!thoughtSignature && block.id) {
                    thoughtSignature = restoreToolUseSignature(block.id);
                }
                if (thoughtSignature && thoughtSignature.length >= MIN_SIGNATURE_LENGTH && block.id) {
                    cacheToolUseSignature(block.id, thoughtSignature);
                }

                if (block.id && block.name) {
                    toolNamesById.set(block.id, block.name);
                }

                const shouldForceStructured = context.forceStructuredToolCalls === true;
                const shouldUseStructured = shouldForceStructured || (
                    context.enableStructuredToolCalls !== false &&
                    thoughtSignature &&
                    thoughtSignature.length >= MIN_SIGNATURE_LENGTH
                );

                if (shouldUseStructured) {
                    if (block.id) toolEncodingById.set(block.id, 'structured');
                    const structuredPart = {
                        functionCall: {
                            name: block.name,
                            args: block.input || {}
                        }
                    };
                    if (thoughtSignature && thoughtSignature.length >= MIN_SIGNATURE_LENGTH) {
                        structuredPart.thoughtSignature = thoughtSignature;
                    }
                    parts.push(structuredPart);
                } else {
                    if (block.id) toolEncodingById.set(block.id, 'text');
                    parts.push({
                        text: `[Called function: ${block.name}(${JSON.stringify(block.input || {})})]`
                    });
                }
                continue;
            }

            if (block?.type === 'tool_result') {
                const responseText = typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content)
                        ? block.content
                            .filter(item => item?.type === 'text')
                            .map(item => item.text || '')
                            .join('\n')
                        : JSON.stringify(block.content ?? '');
                const responseParts = Array.isArray(block.content)
                    ? anthropicContentArrayToGeminiParts(block.content)
                    : [];
                const functionName = toolNamesById.get(block.tool_use_id) || block.tool_use_id || 'tool_result';
                const encoding = toolEncodingById.get(block.tool_use_id) || 'text';
                const hasVisionParts = hasGeminiVisionParts(responseParts);

                if (context.enableStructuredToolCalls !== false && encoding === 'structured' && !hasVisionParts) {
                    parts.push({
                        functionResponse: {
                            name: functionName,
                            response: {
                                tool_use_id: block.tool_use_id,
                                content: responseParts.length > 0
                                    ? responseParts
                                    : (block.is_error ? `Error: ${responseText}` : responseText)
                            }
                        }
                    });
                } else {
                    if (hasVisionParts && typeof context.onMultimodalToolResultDowngrade === 'function') {
                        context.onMultimodalToolResultDowngrade({
                            functionName,
                            toolUseId: block.tool_use_id || 'unknown'
                        });
                    }

                    if (responseParts.length > 0) {
                        if (responseText) {
                            parts.push({
                                text: `[Function ${functionName} returned${block.is_error ? ' with error' : ''}: ${block.is_error ? `Error: ${responseText}` : responseText}]`
                            });
                        }
                        parts.push(...responseParts);
                    } else {
                        parts.push({
                            text: `[Function ${functionName} returned: ${block.is_error ? `Error: ${responseText}` : responseText}]`
                        });
                    }
                }
                continue;
            }

            if (block?.type === 'image') {
                parts.push(...anthropicContentArrayToGeminiParts([block]));
                continue;
            }

            if (block?.type === 'document' || block?.type === 'file') {
                parts.push(...anthropicContentArrayToGeminiParts([block]));
            }
        }

        if (parts.length > 0) {
            contents.push({ role, parts });
        }
    }

    const merged = [];
    for (const entry of contents) {
        if (merged.length > 0 && merged[merged.length - 1].role === entry.role) {
            merged[merged.length - 1].parts.push(...entry.parts);
        } else {
            merged.push({ ...entry, parts: [...entry.parts] });
        }
    }

    const request = {
        contents: merged,
        generationConfig: {
            maxOutputTokens: body.max_tokens || 8192,
            temperature: body.temperature,
            topP: body.top_p
        }
    };

    const systemInstruction = extractSystemInstruction(body.system);
    if (systemInstruction) request.systemInstruction = systemInstruction;

    const tools = convertAnthropicToolsToGemini(body.tools);
    if (tools) request.tools = tools;

    if (context.disableThinkingBudget === true) {
        request.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    return request;
}

export {
    anthropicContentArrayToGeminiParts,
    hasGeminiVisionParts,
    convertAnthropicToolsToGemini,
    summarizeAnthropicToolsForGemini
};

export default {
    translateAnthropicToGeminiRequest,
    anthropicContentArrayToGeminiParts,
    hasGeminiVisionParts,
    convertAnthropicToolsToGemini,
    summarizeAnthropicToolsForGemini
};
