/**
 * ZhipuAI Provider (GLM)
 * Forwards requests to ZhipuAI API (OpenAI-compatible).
 * https://open.bigmodel.cn/dev/api
 *
 * Note: ZhipuAI base URL is non-standard (/api/paas/v4 instead of /v1),
 * but the chat completions endpoint follows the same OpenAI format.
 */

import { OpenAIProvider } from './openai.js';

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

// Pricing per 1M tokens (USD)
const PRICING = {
    'glm-5':        { input: 0.72, output: 2.30 },
    'glm-5-turbo':  { input: 0.36, output: 1.15 },
    'glm-4.7':      { input: 0.40, output: 1.20 },
    'glm-4-plus':   { input: 0.30, output: 0.90 },
    'glm-4-air':    { input: 0.07, output: 0.07 },
    'glm-4-airx':   { input: 0.14, output: 0.14 },
    'glm-4-flash':  { input: 0.01, output: 0.01 },
};

export class ZhipuProvider extends OpenAIProvider {
    constructor(config) {
        super({
            ...config,
            baseUrl: config.baseUrl || DEFAULT_BASE_URL,
        });
        this.type = 'zhipu';
    }

    /**
     * Override validateKey — ZhipuAI doesn't have a standard /models endpoint.
     * Instead, send a minimal chat request to verify the key.
     */
    async validateKey() {
        try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: 'glm-4-flash',
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 1,
                }),
            });
            return response.status !== 401 && response.status !== 403;
        } catch {
            return false;
        }
    }

    estimateCost(model, inputTokens, outputTokens) {
        const pricing = PRICING[model];
        if (!pricing) return 0;
        return (inputTokens / 1_000_000) * pricing.input +
               (outputTokens / 1_000_000) * pricing.output;
    }

    static get pricing() {
        return PRICING;
    }
}

export default ZhipuProvider;
