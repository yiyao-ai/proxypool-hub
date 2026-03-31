import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { getClaudeConfigPath } from '../claude-config.js';

function getToolFilePath(tool) {
    switch (tool) {
        case 'claude':
            return getClaudeConfigPath();
        case 'codex':
            return join(homedir(), '.codex', 'config.toml');
        case 'gemini':
            return join(homedir(), '.gemini', 'settings.json');
        case 'openclaw':
            return join(homedir(), '.openclaw', 'openclaw.json');
        default:
            return null;
    }
}

export function handleGetConfigFile(req, res) {
    const tool = String(req.params.tool || '').trim().toLowerCase();
    const filePath = getToolFilePath(tool);

    if (!filePath) {
        return res.status(404).json({
            success: false,
            error: `Unsupported tool: ${tool}`
        });
    }

    const exists = existsSync(filePath);
    let content = '';

    if (exists) {
        try {
            content = readFileSync(filePath, 'utf8');
        } catch (error) {
            return res.status(500).json({
                success: false,
                tool,
                file: {
                    path: filePath,
                    exists: true,
                    content: ''
                },
                error: error.message
            });
        }
    }

    res.json({
        success: true,
        tool,
        file: {
            path: filePath,
            exists,
            content
        }
    });
}

export default { handleGetConfigFile };
