/**
 * Model Mapping API Routes
 */

import { getDiscoveredModels } from '../model-discovery.js';
import { getMappings, getMappingsMeta, setProviderMappings, resetMappings, resolveModel, recognizeTier } from '../model-mapping.js';

/** GET /api/model-mappings */
export function handleGetModelMappings(req, res) {
    const mappings = getMappings();
    const meta = getMappingsMeta();
    const discovered = getDiscoveredModels();
    res.json({ ...mappings, ...meta, discovered });
}

/** PUT /api/model-mappings/provider/:provider */
export function handleSetProviderMapping(req, res) {
    const { provider } = req.params;
    const tierMap = req.body;

    if (!tierMap || typeof tierMap !== 'object') {
        return res.status(400).json({ error: 'Request body must be an object with tier mappings' });
    }

    const updated = setProviderMappings(provider, tierMap);
    res.json({ success: true, providers: updated.providers });
}

/** POST /api/model-mappings/reset */
export function handleResetModelMappings(req, res) {
    const result = resetMappings();
    res.json({ success: true, providers: result.providers });
}

/** GET /api/model-mappings/resolve?model=xxx&provider=yyy */
export function handleResolveModel(req, res) {
    const { model, provider } = req.query;
    if (!model || !provider) {
        return res.status(400).json({ error: 'Both model and provider query params are required' });
    }
    const tier = recognizeTier(model);
    const resolved = resolveModel(provider, model);
    res.json({ source: model, provider, tier, resolved });
}
