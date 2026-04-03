import { sanitizeToolSchema } from './schemas.js';

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function canonicalizeAnthropicTool(tool) {
    if (!isPlainObject(tool)) {
        return {
            kind: 'unknown',
            name: '',
            original: tool
        };
    }

    if (typeof tool.type === 'string' && tool.type.length > 0) {
        return {
            kind: 'hosted',
            name: typeof tool.name === 'string' ? tool.name : tool.type,
            hostedType: tool.type,
            original: tool
        };
    }

    return {
        kind: 'function',
        name: tool.name || '',
        description: tool.description || '',
        parameters: sanitizeToolSchema(tool.input_schema || { type: 'object', properties: {} }),
        original: tool
    };
}

export function canonicalizeAnthropicTools(tools) {
    if (!Array.isArray(tools)) {
        return [];
    }

    return tools.map(canonicalizeAnthropicTool);
}

export function convertAnthropicToolsToOpenAIResponses(tools, options = {}) {
    const canonicalTools = canonicalizeAnthropicTools(tools);
    const convertedTools = [];
    const unsupportedTools = [];

    for (const tool of canonicalTools) {
        if (tool.kind === 'function') {
            convertedTools.push({
                type: 'function',
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
            });
            continue;
        }

        unsupportedTools.push({
            kind: tool.kind,
            name: tool.name,
            hostedType: tool.hostedType || null,
            action: options.unsupportedHostedToolsAction || 'omit',
            target: 'openai-responses'
        });
    }

    return {
        canonicalTools,
        tools: convertedTools,
        unsupportedTools
    };
}

export function convertAnthropicToolChoiceToOpenAIResponses(toolChoice, canonicalTools = [], options = {}) {
    const functionToolNames = new Set(
        canonicalTools
            .filter(tool => tool.kind === 'function' && typeof tool.name === 'string' && tool.name.length > 0)
            .map(tool => tool.name)
    );

    const hostedToolNames = new Set(
        canonicalTools
            .filter(tool => tool.kind === 'hosted' && typeof tool.name === 'string' && tool.name.length > 0)
            .map(tool => tool.name)
    );

    const downgrade = (value, reason, extra = {}) => ({
        value,
        meta: {
            downgraded: true,
            reason,
            target: 'openai-responses',
            ...extra
        }
    });

    if (!toolChoice) {
        return { value: 'auto', meta: null };
    }

    if (typeof toolChoice === 'string') {
        return { value: toolChoice, meta: null };
    }

    if (toolChoice.type === 'auto') {
        return { value: 'auto', meta: null };
    }

    if (toolChoice.type === 'any') {
        if (functionToolNames.size === 0 && hostedToolNames.size > 0) {
            return downgrade('auto', 'no_supported_tools_for_required_choice', {
                requested: 'any'
            });
        }
        return { value: 'required', meta: null };
    }

    if (toolChoice.type === 'none') {
        return { value: 'none', meta: null };
    }

    if (toolChoice.type === 'tool' && toolChoice.name) {
        if (functionToolNames.has(toolChoice.name)) {
            return {
                value: {
                    type: 'function',
                    function: { name: toolChoice.name }
                },
                meta: null
            };
        }

        if (hostedToolNames.has(toolChoice.name)) {
            return downgrade('auto', 'target_does_not_support_hosted_tool_choice', {
                requestedTool: toolChoice.name
            });
        }

        return {
            value: {
                type: 'function',
                function: { name: toolChoice.name }
            },
            meta: null
        };
    }

    if (options.fallbackValue !== undefined) {
        return downgrade(options.fallbackValue, 'unsupported_tool_choice_shape');
    }

    return { value: 'auto', meta: null };
}

export default {
    canonicalizeAnthropicTool,
    canonicalizeAnthropicTools,
    convertAnthropicToolChoiceToOpenAIResponses,
    convertAnthropicToolsToOpenAIResponses
};
