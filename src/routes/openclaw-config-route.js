/**
 * OpenClaw Config Route
 * Handles OpenClaw configuration:
 *   GET  /openclaw/config        — Show current config status
 *   POST /openclaw/config/proxy  — Configure OpenClaw to use this proxy
 *   POST /openclaw/config/direct — Restore direct connection
 */

import { getProxyStatus, setProxyMode, setDirectMode } from '../openclaw-config.js';
import { logger } from '../utils/logger.js';

/**
 * GET /openclaw/config
 */
export function handleGetOpenClawConfig(req, res) {
    const status = getProxyStatus();
    res.json(status);
}

/**
 * POST /openclaw/config/proxy
 */
export function handleSetOpenClawProxy(req, res, { port }) {
    try {
        const result = setProxyMode(port);
        logger.info(`[OpenClawConfig] Proxy configured: ${result.baseUrl} — ${result.models.length} models`);

        res.json({
            success: true,
            message: `OpenClaw configured to use proxy at ${result.baseUrl}`,
            ...result
        });
    } catch (error) {
        logger.error(`[OpenClawConfig] Failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * POST /openclaw/config/direct
 */
export function handleSetOpenClawDirect(req, res) {
    try {
        const result = setDirectMode();
        if (!result.success) {
            return res.status(404).json(result);
        }
        logger.info('[OpenClawConfig] Restored direct connection');
        res.json({ success: true, message: 'OpenClaw restored to direct connection' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export default { handleGetOpenClawConfig, handleSetOpenClawProxy, handleSetOpenClawDirect };
