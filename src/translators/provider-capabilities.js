import { resolveAnthropicOpenAIResponsesCapabilities, resolveAnthropicGeminiCapabilities } from './capability-registry.js';

function isVertexGeminiModel(model) {
    return /^gemini-/i.test(model || '');
}

export function resolveAnthropicProviderCapabilities(provider, context = {}) {
    const requestedModel = context.requestedModel || '';
    const appId = context.appId || 'unknown';
    const hasTools = Array.isArray(context.tools) && context.tools.length > 0;

    if (!provider?.type) {
        return {
            supportsAnthropicBridge: false,
            supportsHostedTools: false,
            supportsInputImage: false,
            supportsInputFile: false,
            supportsStructuredToolResult: false,
            preferredForAnthropicRouting: false,
            providerKind: 'unknown'
        };
    }

    if (provider.type === 'anthropic') {
        return {
            supportsAnthropicBridge: true,
            supportsHostedTools: true,
            supportsInputImage: true,
            supportsInputFile: true,
            supportsStructuredToolResult: true,
            preferredForAnthropicRouting: true,
            providerKind: 'anthropic'
        };
    }

    if (provider.type === 'openai' || provider.type === 'azure-openai' || provider.type === 'deepseek') {
        const capabilities = resolveAnthropicOpenAIResponsesCapabilities({
            provider: provider.type === 'deepseek' ? 'openai' : provider.type,
            appId,
            hasTools
        });

        return {
            supportsAnthropicBridge: typeof provider.sendAnthropicRequest === 'function',
            supportsHostedTools: false,
            supportsInputImage: capabilities.supportsInputImage,
            supportsInputFile: capabilities.supportsInputFile,
            supportsStructuredToolResult: capabilities.supportsStructuredToolResult,
            preferredForAnthropicRouting: true,
            providerKind: 'openai-responses'
        };
    }

    if (provider.type === 'gemini') {
        const capabilities = resolveAnthropicGeminiCapabilities({
            provider: 'gemini',
            appId,
            hasTools
        });

        return {
            supportsAnthropicBridge: typeof provider.sendAnthropicRequest === 'function',
            supportsHostedTools: false,
            supportsInputImage: capabilities.supportsInputImage,
            supportsInputFile: capabilities.supportsInputFile,
            supportsStructuredToolResult: capabilities.supportsStructuredToolResult,
            preferredForAnthropicRouting: true,
            providerKind: 'gemini'
        };
    }

    if (provider.type === 'vertex-ai') {
        const isGemini = isVertexGeminiModel(requestedModel);
        const geminiCapabilities = resolveAnthropicGeminiCapabilities({
            provider: 'gemini',
            appId,
            hasTools
        });

        return {
            supportsAnthropicBridge: typeof provider.sendAnthropicRequest === 'function',
            supportsHostedTools: !isGemini,
            supportsInputImage: true,
            supportsInputFile: true,
            supportsStructuredToolResult: isGemini ? geminiCapabilities.supportsStructuredToolResult : true,
            preferredForAnthropicRouting: true,
            providerKind: isGemini ? 'vertex-gemini' : 'vertex-claude'
        };
    }

    return {
        supportsAnthropicBridge: typeof provider.sendAnthropicRequest === 'function',
        supportsHostedTools: false,
        supportsInputImage: false,
        supportsInputFile: false,
        supportsStructuredToolResult: false,
        preferredForAnthropicRouting: false,
        providerKind: provider.type
    };
}

export function scoreAnthropicProviderForRequest(provider, features, context = {}) {
    const capabilities = resolveAnthropicProviderCapabilities(provider, context);
    let score = 0;

    if (!capabilities.supportsAnthropicBridge) {
        score -= 1000;
    }
    if (capabilities.preferredForAnthropicRouting) {
        score += 10;
    }
    if (features.hasHostedTools && capabilities.supportsHostedTools) {
        score += 100;
    }
    if (features.hasHostedTools && !capabilities.supportsHostedTools) {
        score -= 100;
    }
    if (features.hasImageInput && capabilities.supportsInputImage) {
        score += 20;
    }
    if (features.hasImageInput && !capabilities.supportsInputImage) {
        score -= 20;
    }
    if (features.hasFileInput && capabilities.supportsInputFile) {
        score += 20;
    }
    if (features.hasFileInput && !capabilities.supportsInputFile) {
        score -= 20;
    }
    if (features.hasStructuredToolResult && capabilities.supportsStructuredToolResult) {
        score += 15;
    }
    if (features.hasStructuredToolResult && !capabilities.supportsStructuredToolResult) {
        score -= 15;
    }

    score -= provider?.totalRequests || 0;

    return {
        score,
        capabilities
    };
}

export function rankAnthropicProvidersForRequest(providers = [], body = {}, context = {}) {
    const features = context.features;
    const ranked = providers.map(provider => {
        const { score, capabilities } = scoreAnthropicProviderForRequest(provider, features, context);
        return {
            provider,
            score,
            capabilities
        };
    });

    ranked.sort((left, right) => right.score - left.score);
    return ranked;
}

export default {
    rankAnthropicProvidersForRequest,
    resolveAnthropicProviderCapabilities,
    scoreAnthropicProviderForRequest
};
