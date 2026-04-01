/**
 * Anthropic Provider
 * Forwards requests to Anthropic API using API keys.
 */

import { BaseProvider } from './base.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

// Aliases for convenience
const MODEL_ALIASES = {
    'claude-sonnet-4-5': 'claude-sonnet-4-5-20250514',
    'claude-opus-4-5': 'claude-opus-4-5-20250514',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    'claude-opus-4-6': 'claude-opus-4-6-20250219',
    'claude-sonnet-4-6': 'claude-sonnet-4-6-20250219',
};

export class AnthropicProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'anthropic',
            baseUrl: config.baseUrl || DEFAULT_BASE_URL
        });
    }

    async sendRequest(body, { stream = false } = {}) {
        const url = `${this.baseUrl}/v1/messages`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': API_VERSION,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return response;
    }

    async validateKey() {
        try {
            // Send a minimal request to check key validity
            const response = await fetch(`${this.baseUrl}/v1/messages`, {
                method: 'POST',
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': API_VERSION,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            });
            // 200 or 400 (bad request) means key is valid; 401 means invalid
            return response.status !== 401;
        } catch {
            return false;
        }
    }

    async listModels() {
        try {
            const response = await fetch(`${this.baseUrl}/v1/models`, {
                headers: {
                    'x-api-key': this.apiKey,
                    'anthropic-version': API_VERSION
                }
            });
            if (!response.ok) return [];
            const data = await response.json();
            return (data.data || []).map(m => ({
                id: m.id,
                name: m.display_name || m.id
            }));
        } catch {
            return [];
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        const resolvedModel = MODEL_ALIASES[model] || model;
        return estimateCostWithRegistry(this.type, resolvedModel, inputTokens, outputTokens);
    }

    static get pricing() {
        return getDefaultPricing('anthropic');
    }
}

export default AnthropicProvider;
