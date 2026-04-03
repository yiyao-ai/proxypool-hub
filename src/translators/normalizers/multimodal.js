import { toOpenAIToolId } from './tool-ids.js';

function buildDataUrl(mediaType, data) {
    if (!data) {
        return '';
    }

    return `data:${mediaType || 'application/octet-stream'};base64,${data}`;
}

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

export function convertAnthropicBlockToResponsesInput(block) {
    if (!block || typeof block !== 'object') return null;

    if (block.type === 'text') {
        return { type: 'input_text', text: block.text || '' };
    }

    if (block.type === 'image') {
        if (block.source?.type === 'base64' && block.source.data) {
            return {
                type: 'input_image',
                data: block.source.data,
                media_type: block.source.media_type || 'image/jpeg'
            };
        }

        if (block.source?.type === 'url' && block.source.url) {
            return {
                type: 'input_image',
                image_url: block.source.url,
                media_type: block.source.media_type || 'image/jpeg'
            };
        }
    }

    if (block.type === 'document' || block.type === 'file') {
        if (block.source?.type === 'base64' && block.source.data) {
            return {
                type: 'input_file',
                file_data: buildDataUrl(block.source.media_type, block.source.data),
                filename: block.title || block.filename || undefined,
                media_type: block.source.media_type || 'application/octet-stream'
            };
        }

        if (block.source?.type === 'url' && block.source.url) {
            return {
                type: 'input_file',
                file_url: block.source.url,
                filename: block.title || block.filename || undefined,
                media_type: block.source.media_type || 'application/octet-stream'
            };
        }

        if (block.source?.type === 'file' && block.source.file_id) {
            return {
                type: 'input_file',
                file_id: block.source.file_id,
                filename: block.title || block.filename || undefined,
                media_type: block.source.media_type || 'application/octet-stream'
            };
        }

        if (typeof block.file_data === 'string' && block.file_data.length > 0) {
            return {
                type: 'input_file',
                file_data: block.file_data,
                filename: block.title || block.filename || undefined,
                media_type: block.media_type || parseDataUrl(block.file_data)?.mediaType || 'application/octet-stream'
            };
        }

        if (typeof block.file_url === 'string' && block.file_url.length > 0) {
            return {
                type: 'input_file',
                file_url: block.file_url,
                filename: block.title || block.filename || undefined,
                media_type: block.media_type || 'application/octet-stream'
            };
        }

        if (typeof block.file_id === 'string' && block.file_id.length > 0) {
            return {
                type: 'input_file',
                file_id: block.file_id,
                filename: block.title || block.filename || undefined,
                media_type: block.media_type || 'application/octet-stream'
            };
        }
    }

    return null;
}

export function normalizeAnthropicToolResultOutput(block) {
    if (typeof block?.content === 'string') {
        return block.content;
    }

    if (Array.isArray(block?.content)) {
        const richContent = block.content
            .map(convertAnthropicBlockToResponsesInput)
            .filter(Boolean);

        if (richContent.length > 0) {
            return richContent;
        }

        return block.content
            .filter(item => item?.type === 'text')
            .map(item => item.text)
            .join('\n');
    }

    if (block?.content !== undefined) {
        return JSON.stringify(block.content);
    }

    return '';
}

export function convertAnthropicUserContent(content) {
    const textParts = [];
    const toolResults = [];
    const imageParts = [];
    const fileParts = [];

    if (typeof content === 'string') {
        textParts.push(content);
        return { textParts, toolResults, imageParts, fileParts };
    }

    if (!Array.isArray(content)) {
        return { textParts, toolResults, imageParts, fileParts };
    }

    for (const block of content) {
        if (block?.type === 'text') {
            textParts.push(block.text);
            continue;
        }

        if (block?.type === 'image') {
            const imageInput = convertAnthropicBlockToResponsesInput(block);
            if (imageInput) imageParts.push(imageInput);
            continue;
        }

        if (block?.type === 'document' || block?.type === 'file') {
            const fileInput = convertAnthropicBlockToResponsesInput(block);
            if (fileInput) fileParts.push(fileInput);
            continue;
        }

        if (block?.type === 'tool_result') {
            const output = normalizeAnthropicToolResultOutput(block);
            toolResults.push({
                type: 'function_call_output',
                call_id: toOpenAIToolId(block.tool_use_id),
                output: (block.is_error && typeof output === 'string')
                    ? `Error: ${output}`
                    : output
            });
        }
    }

    return { textParts, toolResults, imageParts, fileParts };
}

export default {
    convertAnthropicBlockToResponsesInput,
    normalizeAnthropicToolResultOutput,
    convertAnthropicUserContent
};
