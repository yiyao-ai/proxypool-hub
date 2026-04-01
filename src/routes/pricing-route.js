import {
    listPricingEntries,
    getPricingSummary,
    updatePricingEntry,
    resetPricingEntry
} from '../pricing-registry.js';

export function handleGetPricing(req, res) {
    res.json({
        success: true,
        summary: getPricingSummary(),
        entries: listPricingEntries()
    });
}

export function handleUpdatePricing(req, res) {
    const { provider, model, input, output, cacheRead, cacheWrite } = req.body || {};

    try {
        const entry = updatePricingEntry(provider, model, { input, output, cacheRead, cacheWrite });
        res.json({ success: true, entry });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
}

export function handleResetPricing(req, res) {
    const { provider, model } = req.body || {};

    try {
        if (!provider || !model) {
            return res.status(400).json({ success: false, error: 'provider and model are required' });
        }
        const entry = resetPricingEntry(provider, model);
        res.json({ success: true, entry });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
}

export default {
    handleGetPricing,
    handleUpdatePricing,
    handleResetPricing
};
