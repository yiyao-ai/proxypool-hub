/**
 * DeepSeek Provider
 * Forwards requests to DeepSeek's OpenAI-compatible and Anthropic-compatible APIs.
 *
 * OpenAI-compatible base:
 *   https://api.deepseek.com
 *
 * Anthropic-compatible base:
 *   https://api.deepseek.com/anthropic
 */

import { OpenAIProvider } from './openai.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const ANTHROPIC_API_VERSION = '2023-06-01';

function trimTrailingSlash(value = '') {
    return String(value || '').replace(/\/+$/, '');
}

export class DeepSeekProvider extends OpenAIProvider {
    constructor(config) {
        super({
            ...config,
            baseUrl: config.baseUrl || DEFAULT_BASE_URL,
        });
        this.type = 'deepseek';
        // DeepSeek currently rides the existing chat-completions fallback for
        // Codex/Responses traffic; it must not be treated as a native
        // OpenAI Responses provider.
        this.sendResponsesRequest = undefined;
    }

    _buildAnthropicBaseUrl() {
        return `${trimTrailingSlash(this.baseUrl)}/anthropic`;
    }

    async validateKey() {
        try {
            const response = await fetch(`${trimTrailingSlash(this.baseUrl)}/models`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                }
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    async sendAnthropicRequest(body) {
        const response = await fetch(`${this._buildAnthropicBaseUrl()}/v1/messages`, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return response;
    }

    estimateCost(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);
    }

    static get pricing() {
        return getDefaultPricing('deepseek');
    }
}

export default DeepSeekProvider;
