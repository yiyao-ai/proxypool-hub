/**
 * Moonshot Provider (Kimi)
 * Forwards requests to Moonshot AI API (OpenAI-compatible).
 * https://platform.moonshot.ai/docs/api/chat
 */

import { OpenAIProvider } from './openai.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';

const DEFAULT_BASE_URL = 'https://api.moonshot.ai/v1';

export class MoonshotProvider extends OpenAIProvider {
    constructor(config) {
        super({
            ...config,
            baseUrl: config.baseUrl || DEFAULT_BASE_URL,
        });
        this.type = 'moonshot';
    }

    estimateCost(model, inputTokens, outputTokens) {
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens);
    }

    static get pricing() {
        return getDefaultPricing('moonshot');
    }
}

export default MoonshotProvider;
