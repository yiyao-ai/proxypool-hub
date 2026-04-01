/**
 * OpenAI Provider
 * Forwards requests to OpenAI API using API keys.
 * Also supports Anthropic Messages API passthrough via format conversion.
 */

import { BaseProvider } from './base.js';
import { anthropicToOpenAI, openAIToAnthropic } from './format-bridge.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export class OpenAIProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'openai',
            baseUrl: config.baseUrl || DEFAULT_BASE_URL
        });
    }

    async sendRequest(body, { stream = false } = {}) {
        const url = `${this.baseUrl}/chat/completions`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return response;
    }

    async listModels() {
        const response = await fetch(`${this.baseUrl}/models`, {
            headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });
        if (!response.ok) return [];
        const data = await response.json();
        return data.data || [];
    }

    async validateKey() {
        try {
            const response = await fetch(`${this.baseUrl}/models`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` }
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens);
    }

    // ─── Anthropic Messages API passthrough (for /v1/messages endpoint) ──────

    /**
     * Accept an Anthropic Messages API body, convert to OpenAI Chat Completions,
     * send to OpenAI, and return response in Anthropic Messages format.
     */
    async sendAnthropicRequest(body) {
        const openaiBody = anthropicToOpenAI(body);
        const url = `${this.baseUrl}/chat/completions`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(openaiBody)
        });

        if (!response.ok) return response;

        const data = await response.json();
        const anthropicResponse = openAIToAnthropic(data, body.model);

        return new Response(JSON.stringify(anthropicResponse), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    static get pricing() {
        return getDefaultPricing('openai');
    }
}

export default OpenAIProvider;
