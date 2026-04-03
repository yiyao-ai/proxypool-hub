import { canonicalizeAnthropicTools } from './normalizers/tools.js';

function iterateAnthropicContentBlocks(messages = []) {
    const blocks = [];

    for (const message of Array.isArray(messages) ? messages : []) {
        const content = Array.isArray(message?.content) ? message.content : [];
        for (const block of content) {
            blocks.push(block);
        }
    }

    return blocks;
}

export function analyzeAnthropicRequestFeatures(body = {}) {
    const blocks = iterateAnthropicContentBlocks(body.messages);
    const canonicalTools = canonicalizeAnthropicTools(body.tools);

    const hasImageInput = blocks.some(block => block?.type === 'image');
    const hasFileInput = blocks.some(block => block?.type === 'document' || block?.type === 'file');
    const hasStructuredToolResult = blocks.some(block => {
        if (block?.type !== 'tool_result') return false;
        return Array.isArray(block.content)
            && block.content.some(item => item?.type === 'image' || item?.type === 'document' || item?.type === 'file');
    });
    const hostedToolNames = canonicalTools
        .filter(tool => tool.kind === 'hosted')
        .map(tool => tool.name || tool.hostedType || '')
        .filter(Boolean);

    return {
        hasImageInput,
        hasFileInput,
        hasStructuredToolResult,
        hasHostedTools: hostedToolNames.length > 0,
        hostedToolNames,
        canonicalTools
    };
}

export default {
    analyzeAnthropicRequestFeatures
};
