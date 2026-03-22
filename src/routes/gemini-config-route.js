/**
 * Gemini CLI Config Route
 * Handles Gemini CLI configuration:
 *   GET  /gemini-cli/config        — Show current config status and setup instructions
 *   POST /gemini-cli/config/proxy  — Apply proxy patch to Gemini CLI
 *   POST /gemini-cli/config/direct — Restore direct Gemini API connection
 *
 * Gemini CLI uses @google/genai SDK which sets baseUrl in ApiClient constructor.
 * The SDK respects httpOptions.baseUrl passed via GoogleGenAI constructor.
 * In Gemini CLI, this is set via config.baseUrl in createContentGenerator().
 *
 * We patch the contentGenerator.js file to inject our proxy baseUrl.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';

// Locate Gemini CLI installation
function findGeminiCliCorePath() {
    const globalNpmDir = join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules');
    const corePath = join(globalNpmDir, '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'core', 'contentGenerator.js');
    if (existsSync(corePath)) return corePath;

    // Try Unix-style path
    const unixPath = join(homedir(), '.npm', 'node_modules', '@google', 'gemini-cli', 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'core', 'contentGenerator.js');
    if (existsSync(unixPath)) return unixPath;

    return null;
}

const GEMINI_DIR = join(homedir(), '.gemini');
const GEMINI_SETTINGS_FILE = join(GEMINI_DIR, 'settings.json');

/**
 * GET /gemini-cli/config
 */
export function handleGetGeminiCliConfig(req, res) {
    const corePath = findGeminiCliCorePath();
    let patched = false;
    let patchedUrl = null;

    if (corePath) {
        try {
            const content = readFileSync(corePath, 'utf8');
            const match = content.match(/\/\/ PROXYPOOL-HUB: baseUrl override\s*\n\s*httpOptions\.baseUrl\s*=\s*'([^']+)'/);
            if (match) {
                patched = true;
                patchedUrl = match[1];
            }
        } catch { /* ignore */ }
    }

    res.json({
        gemini_cli_found: !!corePath,
        core_path: corePath,
        patched,
        patched_url: patchedUrl,
        settings_path: GEMINI_SETTINGS_FILE,
    });
}

/**
 * POST /gemini-cli/config/proxy
 * Patch Gemini CLI's contentGenerator.js to inject our proxy baseUrl.
 */
export function handleSetGeminiCliProxy(req, res, { port }) {
    const proxyBaseUrl = `http://localhost:${port}/v1beta`;
    const corePath = findGeminiCliCorePath();

    if (!corePath) {
        return res.status(404).json({
            success: false,
            error: 'Gemini CLI not found. Install it with: npm install -g @google/gemini-cli'
        });
    }

    try {
        let content = readFileSync(corePath, 'utf8');

        // Remove any existing patch
        content = content.replace(/\s*\/\/ PROXYPOOL-HUB: baseUrl override\s*\n\s*httpOptions\.baseUrl\s*=\s*'[^']*';\s*/g, '');

        // Find the insertion point: after httpOptions object is built, before GoogleGenAI constructor
        // We inject right before: `const googleGenAI = new GoogleGenAI({`
        const marker = 'const googleGenAI = new GoogleGenAI({';
        const insertIdx = content.indexOf(marker);
        if (insertIdx === -1) {
            return res.status(500).json({
                success: false,
                error: 'Could not find GoogleGenAI constructor in contentGenerator.js. Gemini CLI version may be incompatible.'
            });
        }

        const patch = `\n            // PROXYPOOL-HUB: baseUrl override\n            httpOptions.baseUrl = 'http://localhost:${port}/';\n            `;
        content = content.slice(0, insertIdx) + patch + content.slice(insertIdx);

        writeFileSync(corePath, content);
        logger.info(`[GeminiCliConfig] Patched contentGenerator.js: baseUrl = "${proxyBaseUrl}"`);

        res.json({
            success: true,
            message: 'Gemini CLI patched to use proxy',
            core_path: corePath,
            base_url: proxyBaseUrl,
            instructions: [
                '1. Set environment variable: set GEMINI_API_KEY=proxy',
                '2. Run: gemini',
                '3. Select "Gemini API key" when prompted for auth',
                '4. The proxy will route requests through your API key pool.',
                '',
                'To restore direct connection, use POST /gemini-cli/config/direct'
            ]
        });
    } catch (error) {
        logger.error(`[GeminiCliConfig] Patch failed: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * POST /gemini-cli/config/direct
 * Remove proxy patch from Gemini CLI.
 */
export function handleSetGeminiCliDirect(req, res) {
    const corePath = findGeminiCliCorePath();

    if (!corePath) {
        return res.status(404).json({
            success: false,
            error: 'Gemini CLI not found.'
        });
    }

    try {
        let content = readFileSync(corePath, 'utf8');
        content = content.replace(/\s*\/\/ PROXYPOOL-HUB: baseUrl override\s*\n\s*httpOptions\.baseUrl\s*=\s*'[^']*';\s*/g, '');
        writeFileSync(corePath, content);
        logger.info('[GeminiCliConfig] Removed proxy patch from contentGenerator.js');

        res.json({
            success: true,
            message: 'Gemini CLI restored to direct Gemini API connection',
            core_path: corePath
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
}

export default { handleGetGeminiCliConfig, handleSetGeminiCliProxy, handleSetGeminiCliDirect };
