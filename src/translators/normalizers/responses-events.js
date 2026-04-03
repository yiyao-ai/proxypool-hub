import { normalizeOpenAIResponsesUsage } from './usage.js';
import { inferAnthropicStopReasonFromResponsesOutput } from './stop-reasons.js';

export function parseResponsesSSEEventLine(line) {
    if (typeof line !== 'string' || !line.startsWith('data:')) {
        return null;
    }

    const jsonText = line.slice(5).trim();
    if (!jsonText) {
        return null;
    }

    try {
        return JSON.parse(jsonText);
    } catch {
        return null;
    }
}

export function normalizeResponsesEventUsage(event) {
    if (event?.type === 'response.completed' && event.response?.usage) {
        return normalizeOpenAIResponsesUsage(event.response.usage);
    }

    if (event?.usage) {
        return normalizeOpenAIResponsesUsage(event.usage);
    }

    if (event?.response?.usage) {
        return normalizeOpenAIResponsesUsage(event.response.usage);
    }

    return null;
}

export function getCompletedResponseFromEvent(event) {
    return event?.type === 'response.completed'
        ? event.response || null
        : null;
}

export function inferAnthropicStopReasonFromResponsesResponse(response) {
    if (!response || typeof response !== 'object') {
        return 'end_turn';
    }

    if (Array.isArray(response.output)) {
        return inferAnthropicStopReasonFromResponsesOutput(response.output);
    }

    return 'end_turn';
}

export function getResponsesReasoningDelta(event) {
    if (!event || typeof event !== 'object') {
        return '';
    }

    if (event.type === 'response.reasoning.delta' || event.type === 'response.thinking.delta') {
        return event.delta || event.thinking || '';
    }

    return '';
}

export function getResponsesTextDelta(event) {
    if (!event || typeof event !== 'object') {
        return '';
    }

    if (event.type === 'response.output_text.delta') {
        return event.delta || '';
    }

    return '';
}

export function getResponsesFunctionArgumentsDelta(event) {
    if (!event || typeof event !== 'object') {
        return '';
    }

    if (event.type === 'response.function_call_arguments.delta') {
        return event.delta || '';
    }

    return '';
}

export default {
    parseResponsesSSEEventLine,
    normalizeResponsesEventUsage,
    getCompletedResponseFromEvent,
    inferAnthropicStopReasonFromResponsesResponse,
    getResponsesReasoningDelta,
    getResponsesTextDelta,
    getResponsesFunctionArgumentsDelta
};
