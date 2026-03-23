/**
 * Moonshot Provider (Kimi)
 * Forwards requests to Moonshot AI API (OpenAI-compatible).
 * https://platform.moonshot.ai/docs/api/chat
 */

import { OpenAIProvider } from './openai.js';

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

// Pricing per 1M tokens (USD)
const PRICING = {
    'kimi-k2.5':              { input: 0.60, output: 2.50 },
    'kimi-k2-thinking':       { input: 0.60, output: 2.50 },
    'kimi-k2-thinking-turbo': { input: 0.30, output: 1.20 },
};

export class MoonshotProvider extends OpenAIProvider {
    constructor(config) {
        super({
            ...config,
            baseUrl: config.baseUrl || DEFAULT_BASE_URL,
        });
        this.type = 'moonshot';
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

export default MoonshotProvider;
