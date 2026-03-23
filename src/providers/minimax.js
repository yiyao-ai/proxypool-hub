/**
 * MiniMax Provider
 * Forwards requests to MiniMax API (OpenAI-compatible).
 * https://platform.minimax.io/docs/api-reference/text-openai-api
 */

import { OpenAIProvider } from './openai.js';

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';

// Pricing per 1M tokens (USD)
const PRICING = {
    'MiniMax-M2.7':           { input: 0.30, output: 1.20 },
    'MiniMax-M2.7-highspeed': { input: 0.30, output: 2.40 },
    'MiniMax-M2.5':           { input: 0.30, output: 1.20 },
    'MiniMax-M2.5-highspeed': { input: 0.30, output: 2.40 },
    'MiniMax-M2.1':           { input: 0.20, output: 0.80 },
    'MiniMax-M2.1-highspeed': { input: 0.20, output: 1.60 },
    'MiniMax-M2':             { input: 0.15, output: 0.60 },
};

export class MiniMaxProvider extends OpenAIProvider {
    constructor(config) {
        super({
            ...config,
            baseUrl: config.baseUrl || DEFAULT_BASE_URL,
        });
        this.type = 'minimax';
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

export default MiniMaxProvider;
