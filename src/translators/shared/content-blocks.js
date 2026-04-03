import { toAnthropicToolId } from '../normalizers/tool-ids.js';
import { cacheReasoningSignature, cacheToolUseSignature, SIGNATURE_CONSTANTS } from '../normalizers/thinking.js';

const { MIN_SIGNATURE_LENGTH } = SIGNATURE_CONSTANTS;

function parseDataUrl(value, defaultMediaType = 'application/octet-stream') {
    if (typeof value !== 'string' || !value.startsWith('data:')) {
        return null;
    }

    const trimmed = value.slice(5);
    const [header, data = ''] = trimmed.split(';base64,');
    if (!data) {
        return null;
    }

    return {
        mediaType: header || defaultMediaType,
        data
    };
}

function convertResponsesContentPartToAnthropic(part) {
    if (!part || typeof part !== 'object') {
        return null;
    }

    if (part.type === 'output_text') {
        return { type: 'text', text: part.text || '' };
    }

    if (part.type === 'input_file') {
        if (typeof part.file_data === 'string' && part.file_data.length > 0) {
            const parsed = parseDataUrl(part.file_data);
            if (parsed) {
                return {
                    type: 'document',
                    title: part.filename,
                    source: {
                        type: 'base64',
                        media_type: part.media_type || parsed.mediaType,
                        data: parsed.data
                    }
                };
            }
        }

        if (typeof part.file_url === 'string' && part.file_url.length > 0) {
            return {
                type: 'document',
                title: part.filename,
                source: {
                    type: 'url',
                    media_type: part.media_type || 'application/octet-stream',
                    url: part.file_url
                }
            };
        }

        if (typeof part.file_id === 'string' && part.file_id.length > 0) {
            return {
                type: 'document',
                title: part.filename,
                source: {
                    type: 'file',
                    media_type: part.media_type || 'application/octet-stream',
                    file_id: part.file_id
                }
            };
        }

        return {
            type: 'text',
            text: part.filename
                ? `[document: ${part.filename}]`
                : '[document]'
        };
    }

    return null;
}

export function convertResponsesOutputToAnthropicContent(output) {
    if (!Array.isArray(output)) {
        return [{ type: 'text', text: '' }];
    }

    const content = [];

    for (const item of output) {
        if (item?.type === 'message') {
            for (const part of item.content || []) {
                const anthropicPart = convertResponsesContentPartToAnthropic(part);
                if (anthropicPart) {
                    content.push(anthropicPart);
                }
            }
            continue;
        }

        if (item?.type === 'function_call') {
            let input = {};

            try {
                input = typeof item.arguments === 'string'
                    ? JSON.parse(item.arguments)
                    : item.arguments || {};
            } catch {
                input = {};
            }

            const toolId = toAnthropicToolId(item.call_id || item.id);
            const toolUseBlock = {
                type: 'tool_use',
                id: toolId,
                name: item.name,
                input
            };

            if (item.signature && item.signature.length >= MIN_SIGNATURE_LENGTH) {
                toolUseBlock.thoughtSignature = item.signature;
                cacheToolUseSignature(toolId, item.signature);
            }

            content.push(toolUseBlock);
            continue;
        }

        if (item?.type === 'reasoning') {
            const signature = item.signature || '';
            if (signature && signature.length >= MIN_SIGNATURE_LENGTH) {
                cacheReasoningSignature(signature, 'openai');
            }

            content.push({
                type: 'thinking',
                thinking: item.text || item.content || '',
                signature
            });
        }
    }

    return content.length > 0 ? content : [{ type: 'text', text: '' }];
}

export default {
    convertResponsesContentPartToAnthropic,
    convertResponsesOutputToAnthropicContent
};
