/**
 * ZhipuAI Provider (GLM)
 * Forwards requests to ZhipuAI API (OpenAI-compatible).
 * https://open.bigmodel.cn/dev/api
 *
 * Note: ZhipuAI base URL is non-standard (/api/paas/v4 instead of /v1),
 * but the chat completions endpoint follows the same OpenAI format.
 */

import { OpenAIProvider } from './openai.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

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
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens);
    }

    static get pricing() {
        return getDefaultPricing('zhipu');
    }
}

export default ZhipuProvider;
