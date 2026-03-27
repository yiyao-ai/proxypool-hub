/**
 * Azure OpenAI Provider
 * Forwards requests to Azure OpenAI Service endpoints.
 * Also supports Anthropic Messages API passthrough via format conversion.
 *
 * Required config:
 *   - apiKey:          Azure API key
 *   - baseUrl:         Resource endpoint, e.g. https://my-resource.openai.azure.com
 *   - deploymentName:  The deployment name created in Azure portal
 *   - apiVersion:      API version, e.g. 2024-10-21
 */

import { BaseProvider } from './base.js';
import { anthropicToOpenAI, openAIToAnthropic } from './format-bridge.js';

const DEFAULT_API_VERSION = '2024-10-21';

const PRICING = {
    'gpt-5.4':         { input: 2.50, output: 15.00 },
    'gpt-5.4-mini':    { input: 0.75, output: 4.50 },
    'gpt-5.4-nano':    { input: 0.20, output: 1.25 },
    'gpt-4o':          { input: 2.50, output: 10.00 },
    'gpt-4o-mini':     { input: 0.15, output: 0.60 },
    'gpt-4-turbo':     { input: 10.00, output: 30.00 },
    'gpt-4':           { input: 30.00, output: 60.00 },
    'gpt-35-turbo':    { input: 0.50, output: 1.50 },
    'gpt-3.5-turbo':   { input: 0.50, output: 1.50 },
    'o1':              { input: 15.00, output: 60.00 },
    'o1-mini':         { input: 3.00, output: 12.00 },
    'o3':              { input: 2.00, output: 8.00 },
    'o3-mini':         { input: 1.10, output: 4.40 },
    'o4-mini':         { input: 1.10, output: 4.40 },
};

export class AzureOpenAIProvider extends BaseProvider {
    constructor(config) {
        super({
            ...config,
            type: 'azure-openai',
            baseUrl: config.baseUrl || ''
        });
        this.deploymentName = config.deploymentName || '';
        this.apiVersion = config.apiVersion || DEFAULT_API_VERSION;
    }

    /**
     * Build the chat completions URL.
     * Format: https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}
     */
    _buildChatUrl() {
        const base = this.baseUrl.replace(/\/+$/, '');
        return `${base}/openai/deployments/${this.deploymentName}/chat/completions?api-version=${this.apiVersion}`;
    }

    async sendRequest(body) {
        const url = this._buildChatUrl();
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'api-key': this.apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });
        return response;
    }

    async validateKey() {
        try {
            const url = this._buildChatUrl();
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'api-key': this.apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    max_tokens: 1,
                    messages: [{ role: 'user', content: 'hi' }]
                })
            });
            // 200 or 400 means key & deployment are valid; 401/403 means auth failed
            return response.status !== 401 && response.status !== 403;
        } catch {
            return false;
        }
    }

    async listModels() {
        try {
            const base = this.baseUrl.replace(/\/+$/, '');
            const url = `${base}/openai/models?api-version=${this.apiVersion}`;
            const response = await fetch(url, {
                headers: { 'api-key': this.apiKey }
            });
            if (!response.ok) return [];
            const data = await response.json();
            return (data.data || []).map(m => ({
                id: m.id,
                name: m.id
            }));
        } catch {
            return [];
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        const pricing = PRICING[model] || PRICING[this.deploymentName];
        if (!pricing) return 0;
        return (inputTokens / 1_000_000) * pricing.input +
               (outputTokens / 1_000_000) * pricing.output;
    }

    toJSON() {
        return {
            ...super.toJSON(),
            deploymentName: this.deploymentName,
            apiVersion: this.apiVersion
        };
    }

    // ─── Anthropic Messages API passthrough (for /v1/messages endpoint) ──────

    /**
     * Accept an Anthropic Messages API body, convert to OpenAI Chat Completions,
     * send to Azure OpenAI, and return response in Anthropic Messages format.
     */
    async sendAnthropicRequest(body) {
        const openaiBody = anthropicToOpenAI(body);
        // Azure doesn't use the model field in body — it's in the URL via deployment
        delete openaiBody.model;

        const url = this._buildChatUrl();
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'api-key': this.apiKey,
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
        return PRICING;
    }
}

export default AzureOpenAIProvider;
