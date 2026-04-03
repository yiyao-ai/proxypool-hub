/**
 * OpenAI Provider
 * Forwards requests to OpenAI API using API keys.
 * Also supports Anthropic Messages API passthrough via translator conversion.
 */

import { BaseProvider } from './base.js';
import { translateAnthropicToOpenAIResponsesRequest } from '../translators/request/anthropic-to-openai-responses.js';
import { translateOpenAIResponsesToAnthropicMessage } from '../translators/response/openai-responses-to-anthropic.js';
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

    async sendResponsesRequest(body) {
        const url = `${this.baseUrl}/responses`;
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
     * Accept an Anthropic Messages API body, convert to OpenAI Responses,
     * send to OpenAI, and return response in Anthropic Messages format.
     */
    async sendAnthropicRequest(body) {
        const openaiBody = translateAnthropicToOpenAIResponsesRequest(body, { stream: false });
        const url = `${this.baseUrl}/responses`;
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
        const anthropicResponse = translateOpenAIResponsesToAnthropicMessage(data, {
            model: body.model,
            requestEcho: openaiBody.__translatorMeta?.requestEcho
        });

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
