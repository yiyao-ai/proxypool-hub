/**
 * API Keys Route
 * CRUD endpoints for managing API keys across providers.
 */

import {
    addApiKey,
    removeApiKey,
    updateApiKey,
    listApiKeys,
    validateApiKey,
    getStats
} from '../api-key-manager.js';

export function handleListApiKeys(req, res) {
    const keys = listApiKeys();
    const stats = getStats();
    res.json({ keys, stats });
}

export async function handleAddApiKey(req, res) {
    const { type, name, apiKey, baseUrl, deploymentName, apiVersion, projectId, location } = req.body;

    if (!type || !apiKey) {
        return res.status(400).json({ success: false, error: 'type and apiKey are required' });
    }

    const result = addApiKey({ type, name, apiKey, baseUrl, deploymentName, apiVersion, projectId, location });
    if (!result.success) {
        return res.status(400).json(result);
    }

    res.json(result);
}

export function handleRemoveApiKey(req, res) {
    const { id } = req.params;
    const result = removeApiKey(id);
    if (!result.success) {
        return res.status(404).json(result);
    }
    res.json(result);
}

export function handleUpdateApiKey(req, res) {
    const { id } = req.params;
    const { name, apiKey, baseUrl, enabled, deploymentName, apiVersion, projectId, location } = req.body;
    const result = updateApiKey(id, { name, apiKey, baseUrl, enabled, deploymentName, apiVersion, projectId, location });
    if (!result.success) {
        return res.status(404).json(result);
    }
    res.json(result);
}

export async function handleValidateApiKey(req, res) {
    const { id } = req.params;
    const result = await validateApiKey(id);
    res.json(result);
}

export function handleGetApiKeyStats(req, res) {
    res.json(getStats());
}
