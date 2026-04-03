import { translateAnthropicToOpenAIResponsesRequest, SOURCE_PROTOCOL as REQUEST_SOURCE_PROTOCOL, TARGET_PROTOCOL as REQUEST_TARGET_PROTOCOL } from './request/anthropic-to-openai-responses.js';
import { translateOpenAIResponsesToAnthropicMessage, SOURCE_PROTOCOL as RESPONSE_SOURCE_PROTOCOL, TARGET_PROTOCOL as RESPONSE_TARGET_PROTOCOL } from './response/openai-responses-to-anthropic.js';
import { streamOpenAIResponsesAsAnthropicEvents, parseOpenAIResponsesSSE } from './response/openai-responses-sse-to-anthropic-sse.js';

const requestTranslators = new Map();
const responseTranslators = new Map();
const capabilityProfiles = new Map();

function getKey(from, to, mode = 'default') {
    return `${from}->${to}#${mode}`;
}

function normalizeCapabilityProfile(profile = {}) {
    return {
        structuredToolCallMode: profile.structuredToolCallMode || 'signature',
        disableThinkingBudgetAppsWithTools: Array.isArray(profile.disableThinkingBudgetAppsWithTools)
            ? [...profile.disableThinkingBudgetAppsWithTools]
            : []
    };
}

export function registerRequestTranslator(from, to, fn) {
    requestTranslators.set(getKey(from, to), fn);
}

export function registerResponseTranslator(from, to, mode, fn) {
    responseTranslators.set(getKey(from, to, mode), fn);
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
        disableThinkingBudget: hasTools && profile.disableThinkingBudgetAppsWithTools.includes(appId),
        disableThinkingBudgetAppsWithTools: [...profile.disableThinkingBudgetAppsWithTools]
    };
}

export function resolveAnthropicGeminiCapabilities(context = {}) {
    return resolveCapabilityProfile('anthropic-messages', 'gemini', context);
}

export function translateRequest(from, to, payload, context = {}) {
    const translator = requestTranslators.get(getKey(from, to));
    if (!translator) {
        throw new Error(`No request translator registered for ${from} -> ${to}`);
    }
    return translator(payload, context);
}

export function translateResponse(from, to, payload, context = {}) {
    const mode = context.mode || 'default';
    const translator = responseTranslators.get(getKey(from, to, mode));
    if (!translator) {
        throw new Error(`No response translator registered for ${from} -> ${to} (${mode})`);
    }
    return translator(payload, context);
}

registerRequestTranslator(
    REQUEST_SOURCE_PROTOCOL,
    REQUEST_TARGET_PROTOCOL,
    translateAnthropicToOpenAIResponsesRequest
);

registerResponseTranslator(
    RESPONSE_SOURCE_PROTOCOL,
    RESPONSE_TARGET_PROTOCOL,
    'default',
    translateOpenAIResponsesToAnthropicMessage
);

registerResponseTranslator(
    RESPONSE_SOURCE_PROTOCOL,
    RESPONSE_TARGET_PROTOCOL,
    'stream',
    (payload, context) => streamOpenAIResponsesAsAnthropicEvents(payload, context.model)
);

registerResponseTranslator(
    RESPONSE_SOURCE_PROTOCOL,
    RESPONSE_TARGET_PROTOCOL,
    'parse',
    parseOpenAIResponsesSSE
);

registerCapabilityProfile('anthropic-messages', 'gemini', 'default', {
    structuredToolCallMode: 'signature'
});

registerCapabilityProfile('anthropic-messages', 'gemini', 'gemini', {
    structuredToolCallMode: 'force',
    disableThinkingBudgetAppsWithTools: ['claude-code']
});

export default {
    registerCapabilityProfile,
    registerRequestTranslator,
    registerResponseTranslator,
    resolveAnthropicGeminiCapabilities,
    resolveCapabilityProfile,
    translateRequest,
    translateResponse
};
