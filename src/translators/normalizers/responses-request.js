function normalizeStopSequences(stopSequences) {
    if (!Array.isArray(stopSequences)) {
        return undefined;
    }

    const normalized = stopSequences
        .filter(stop => typeof stop === 'string' && stop.length > 0);

    if (normalized.length === 0) {
        return undefined;
    }

    return normalized.length === 1 ? normalized[0] : normalized;
}

function normalizeReasoningEffort(effort) {
    if (typeof effort !== 'string') {
        return undefined;
    }

    const normalized = effort.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }

    const allowed = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto']);
    return allowed.has(normalized) ? normalized : undefined;
}

function normalizeReasoningFromThinking(thinking, outputConfig = {}) {
    if (!thinking || typeof thinking !== 'object') {
        return undefined;
    }

    const thinkingType = typeof thinking.type === 'string'
        ? thinking.type.trim().toLowerCase()
        : '';

    if (!thinkingType) {
        return undefined;
    }

    if (thinkingType === 'disabled') {
        return { effort: 'none' };
    }

    if (thinkingType === 'adaptive' || thinkingType === 'auto') {
        const effort = normalizeReasoningEffort(outputConfig?.effort);
        return effort ? { effort } : { effort: 'auto' };
    }

    if (thinkingType !== 'enabled') {
        return undefined;
    }

    const budgetTokens = Number.isFinite(thinking.budget_tokens)
        ? thinking.budget_tokens
        : undefined;

    if (budgetTokens === undefined) {
        return { effort: 'auto' };
    }

    if (budgetTokens <= 0) {
        return { effort: 'none' };
    }

    if (budgetTokens <= 1024) {
        return { effort: 'minimal' };
    }

    if (budgetTokens <= 4096) {
        return { effort: 'low' };
    }

    if (budgetTokens <= 8192) {
        return { effort: 'medium' };
    }

    if (budgetTokens <= 16384) {
        return { effort: 'high' };
    }

    return { effort: 'xhigh' };
}

export function normalizeAnthropicReasoningConfig(anthropicRequest = {}) {
    if (anthropicRequest.reasoning && typeof anthropicRequest.reasoning === 'object') {
        const effort = normalizeReasoningEffort(anthropicRequest.reasoning.effort);
        if (effort) {
            return { effort };
        }
    }

    return normalizeReasoningFromThinking(
        anthropicRequest.thinking,
        anthropicRequest.output_config
    );
}

export function normalizeAnthropicResponsesRequestOptions(anthropicRequest = {}, options = {}) {
    const normalized = {};
    const requestEcho = {};

    const reasoning = normalizeAnthropicReasoningConfig(anthropicRequest);
    if (reasoning) {
        normalized.reasoning = reasoning;
        requestEcho.reasoning = reasoning;
    }

    if (Number.isFinite(anthropicRequest.max_tokens)) {
        normalized.max_output_tokens = anthropicRequest.max_tokens;
        requestEcho.max_output_tokens = anthropicRequest.max_tokens;
    }

    if (typeof anthropicRequest.temperature === 'number') {
        normalized.temperature = anthropicRequest.temperature;
        requestEcho.temperature = anthropicRequest.temperature;
    }

    if (typeof anthropicRequest.top_p === 'number') {
        normalized.top_p = anthropicRequest.top_p;
        requestEcho.top_p = anthropicRequest.top_p;
    }

    const stop = normalizeStopSequences(anthropicRequest.stop_sequences);
    if (stop !== undefined) {
        normalized.stop = stop;
        requestEcho.stop = stop;
    }

    if (anthropicRequest.metadata && typeof anthropicRequest.metadata === 'object' && !Array.isArray(anthropicRequest.metadata)) {
        normalized.metadata = anthropicRequest.metadata;
        requestEcho.metadata = anthropicRequest.metadata;
    }

    if (typeof anthropicRequest.user === 'string' && anthropicRequest.user.length > 0) {
        normalized.user = anthropicRequest.user;
        requestEcho.user = anthropicRequest.user;
    }

    const parallelToolCalls = options.parallelToolCalls ?? true;
    normalized.parallel_tool_calls = parallelToolCalls;
    requestEcho.parallel_tool_calls = parallelToolCalls;

    const store = options.store ?? false;
    normalized.store = store;
    requestEcho.store = store;

    return { normalized, requestEcho };
}

export default {
    normalizeAnthropicReasoningConfig,
    normalizeAnthropicResponsesRequestOptions
};
