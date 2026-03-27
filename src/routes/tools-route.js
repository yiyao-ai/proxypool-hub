/**
 * Tools Route
 * Endpoints for detecting and installing CLI tools.
 *   GET  /api/tools/status     — detect all tool installation status
 *   GET  /api/tools/node-info  — get Node.js installation info for current platform
 *   POST /api/tools/install/:toolId — install a CLI tool via npm
 *   POST /api/tools/install-node    — attempt automatic Node.js installation
 */

import { detectAllTools, getNodeInstallInfo, installTool, installNode } from '../tool-installer.js';
import { launchTool } from '../tool-launcher.js';

export function handleGetToolsStatus(req, res) {
    const status = detectAllTools();
    res.json({ success: true, ...status });
}

export function handleGetNodeInfo(req, res) {
    const info = getNodeInstallInfo();
    res.json({ success: true, ...info });
}

export async function handleInstallTool(req, res) {
    const { toolId } = req.params;
    const result = await installTool(toolId);
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
}

export async function handleInstallNode(req, res) {
    const result = await installNode();
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
}

export function handleLaunchTool(req, res) {
    const { toolId } = req.params;
    const result = launchTool(toolId);
    if (result.success) {
        res.json(result);
    } else {
        res.status(400).json(result);
    }
}
