const capabilityProfiles = new Map();

function getKey(from, to, mode = 'default') {
    return `${from}->${to}#${mode}`;
}

function normalizeCapabilityProfile(profile = {}) {
    return {
        structuredToolCallMode: profile.structuredToolCallMode || 'signature',
        supportsHostedTools: profile.supportsHostedTools === true,
        supportsInputFile: profile.supportsInputFile !== false,
        supportsInputImage: profile.supportsInputImage !== false,
        supportsStructuredToolResult: profile.supportsStructuredToolResult !== false,
        responsesMaxTokensField: profile.responsesMaxTokensField === undefined
            ? 'max_completion_tokens'
            : profile.responsesMaxTokensField,
        supportsResponsesReasoning: profile.supportsResponsesReasoning !== false,
        supportsResponsesTemperature: profile.supportsResponsesTemperature !== false,
        supportsResponsesTopP: profile.supportsResponsesTopP !== false,
        supportsResponsesStop: profile.supportsResponsesStop !== false,
        supportsResponsesMetadata: profile.supportsResponsesMetadata !== false,
        supportsResponsesUser: profile.supportsResponsesUser !== false,
        responsesInlineImageEncoding: profile.responsesInlineImageEncoding || 'data-field',
        disableThinkingBudgetAppsWithTools: Array.isArray(profile.disableThinkingBudgetAppsWithTools)
            ? [...profile.disableThinkingBudgetAppsWithTools]
            : []
    };
}

export function registerCapabilityProfile(from, to, profileId, profile) {
    capabilityProfiles.set(getKey(from, to, profileId), normalizeCapabilityProfile(profile));
}

export function resolveCapabilityProfile(from, to, context = {}) {
    const profileId = context.capabilityProfile || context.provider || 'default';
    const profile = capabilityProfiles.get(getKey(from, to, profileId))
        || capabilityProfiles.get(getKey(from, to, 'default'))
        || normalizeCapabilityProfile();

    const hasTools = context.hasTools === true;
    const appId = context.appId || context._proxypoolAppId || 'unknown';

    return {
        profileId,
        structuredToolCallMode: profile.structuredToolCallMode,
        supportsHostedTools: profile.supportsHostedTools,
        supportsInputFile: profile.supportsInputFile,
        supportsInputImage: profile.supportsInputImage,
        supportsStructuredToolResult: profile.supportsStructuredToolResult,
        responsesMaxTokensField: profile.responsesMaxTokensField,
        supportsResponsesReasoning: profile.supportsResponsesReasoning,
        supportsResponsesTemperature: profile.supportsResponsesTemperature,
        supportsResponsesTopP: profile.supportsResponsesTopP,
        supportsResponsesStop: profile.supportsResponsesStop,
        supportsResponsesMetadata: profile.supportsResponsesMetadata,
        supportsResponsesUser: profile.supportsResponsesUser,
        responsesInlineImageEncoding: profile.responsesInlineImageEncoding,
        disableThinkingBudget: hasTools && profile.disableThinkingBudgetAppsWithTools.includes(appId),
        disableThinkingBudgetAppsWithTools: [...profile.disableThinkingBudgetAppsWithTools]
    };
}

export function resolveAnthropicGeminiCapabilities(context = {}) {
    return resolveCapabilityProfile('anthropic-messages', 'gemini', context);
}

export function resolveAnthropicOpenAIResponsesCapabilities(context = {}) {
    return resolveCapabilityProfile('anthropic-messages', 'openai-responses', context);
}

registerCapabilityProfile('anthropic-messages', 'gemini', 'default', {
    structuredToolCallMode: 'signature',
    supportsHostedTools: false,
    supportsInputFile: true,
    supportsInputImage: true,
    supportsStructuredToolResult: true
});

registerCapabilityProfile('anthropic-messages', 'gemini', 'gemini', {
    structuredToolCallMode: 'force',
    supportsHostedTools: false,
    supportsInputFile: true,
    supportsInputImage: true,
    supportsStructuredToolResult: true,
    disableThinkingBudgetAppsWithTools: ['claude-code']
});

registerCapabilityProfile('anthropic-messages', 'openai-responses', 'default', {
    supportsHostedTools: false,
    supportsInputFile: true,
    supportsInputImage: true,
    supportsStructuredToolResult: true,
    responsesMaxTokensField: 'max_completion_tokens'
});

registerCapabilityProfile('anthropic-messages', 'openai-responses', 'chatgpt-backend', {
    supportsHostedTools: false,
    supportsInputFile: true,
    supportsInputImage: true,
    supportsStructuredToolResult: true,
    responsesMaxTokensField: null,
    supportsResponsesReasoning: false,
    supportsResponsesTemperature: false,
    supportsResponsesTopP: false,
    supportsResponsesStop: false,
    supportsResponsesMetadata: false,
    supportsResponsesUser: false,
    responsesInlineImageEncoding: 'data-url'
});

export default {
    registerCapabilityProfile,
    resolveAnthropicGeminiCapabilities,
    resolveAnthropicOpenAIResponsesCapabilities,
    resolveCapabilityProfile
};
