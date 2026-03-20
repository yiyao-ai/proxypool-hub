/**
 * Kilo Models
 * Fetches and caches available free models from the Kilo API.
 */

const KILO_MODELS_URL = 'https://api.kilo.ai/api/openrouter/models';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

let cachedModels = null;
let cacheTimestamp = 0;

const KILO_HEADERS = {
    Authorization: 'Bearer anonymous',
    'HTTP-Referer': 'https://kilo.ai'
};

/**
 * Fetch all models from Kilo API and filter to free ones with tool support.
 * Results are cached for 10 minutes.
 * @returns {Promise<Array<{id: string, name: string, context_length: number}>>}
 */
export async function fetchFreeModels() {
    const now = Date.now();
    if (cachedModels && (now - cacheTimestamp) < CACHE_TTL_MS) {
        return cachedModels;
    }

    try {
        const response = await fetch(KILO_MODELS_URL, {
            headers: KILO_HEADERS
        });

        if (!response.ok) {
            console.warn(`[KiloModels] Failed to fetch models: ${response.status}`);
            return cachedModels || getHardcodedFallback();
        }

        const data = await response.json();
        const allModels = data?.data || [];

        const freeModels = allModels
            .filter(m => m.isFree === true)
            .filter(m => !m.id.includes('deprecated') && m.id !== 'kilo/auto-free')
            .map(m => ({
                id: m.id,
                name: m.name || m.id,
                context_length: m.context_length || 0,
                supportsTools: (m.supported_parameters || []).includes('tools')
            }));

        cachedModels = freeModels;
        cacheTimestamp = now;
        console.log(`[KiloModels] Fetched ${freeModels.length} free models from API`);
        return freeModels;
    } catch (error) {
        console.warn(`[KiloModels] Error fetching models: ${error.message}`);
        return cachedModels || getHardcodedFallback();
    }
}

/**
 * Get the list of free model IDs (just the id strings).
 * @returns {Promise<string[]>}
 */
export async function getFreeModelIds() {
    const models = await fetchFreeModels();
    return models.map(m => m.id);
}

/**
 * Check if a given model ID is currently free.
 * @param {string} modelId
 * @returns {Promise<boolean>}
 */
export async function isModelFree(modelId) {
    const models = await fetchFreeModels();
    return models.some(m => m.id === modelId);
}

/**
 * Invalidate the cache (e.g. after a failed request).
 */
export function invalidateCache() {
    cachedModels = null;
    cacheTimestamp = 0;
}

/**
 * Hardcoded fallback in case the API is unreachable.
 */
function getHardcodedFallback() {
    return [
        { id: 'minimax/minimax-m2.5:free', name: 'MiniMax M2.5', context_length: 204800, supportsTools: true },
        { id: 'kilo-auto/free', name: 'Kilo Auto Free', context_length: 204800, supportsTools: true }
    ];
}

export default {
    fetchFreeModels,
    getFreeModelIds,
    isModelFree,
    invalidateCache
};
