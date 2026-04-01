/**
 * MiniMax Provider
 * Forwards requests to MiniMax API (OpenAI-compatible).
 * https://platform.minimax.io/docs/api-reference/text-openai-api
 */

import { OpenAIProvider } from './openai.js';
import { estimateCostWithRegistry, getDefaultPricing } from '../pricing-registry.js';

const DEFAULT_BASE_URL = 'https://api.minimax.io/v1';

export class MiniMaxProvider extends OpenAIProvider {
    constructor(config) {
        super({
            ...config,
            baseUrl: config.baseUrl || DEFAULT_BASE_URL,
        });
        this.type = 'minimax';
    }

    estimateCost(model, inputTokens, outputTokens) {
        return estimateCostWithRegistry(this.type, model, inputTokens, outputTokens);
    }

    static get pricing() {
        return getDefaultPricing('minimax');
    }
}

export default MiniMaxProvider;
