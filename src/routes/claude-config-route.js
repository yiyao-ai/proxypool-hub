/**
 * Claude Config Route
 * Handles Claude CLI configuration endpoints:
 *   GET  /claude/config
 *   POST /claude/config/proxy
 *   POST /claude/config/direct
 *   POST /claude/config/set
 */

import {
  readClaudeConfig,
  setProxyMode,
  setDirectMode,
  setApiEndpoint,
  getClaudeConfigPath
} from '../claude-config.js';

/**
 * GET /claude/config
 * Returns the current Claude CLI configuration.
 */
export async function handleGetClaudeConfig(req, res) {
  try {
    const config = await readClaudeConfig();
    const configPath = getClaudeConfigPath();
    res.json({ success: true, configPath, config });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * POST /claude/config/proxy
 * Configures Claude CLI to use this proxy server.
 */
export async function handleSetProxyMode(req, res, { port }) {
  try {
    const proxyUrl = `http://localhost:${port}`;
    const models = {
      default: 'claude-sonnet-4-6',
      opus: 'claude-opus-4-6',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5'
    };
    const config = await setProxyMode(proxyUrl, models);
    res.json({
      success: true,
      message: `Claude CLI configured to use proxy at ${proxyUrl}`,
      config
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * POST /claude/config/direct
 * Configures Claude CLI to use the Anthropic API directly.
 */
export async function handleSetDirectMode(req, res) {
  const { apiKey } = req.body || {};
  try {
    const config = await setDirectMode(apiKey || undefined);
    res.json({
      success: true,
      message: 'Claude CLI proxy configuration removed',
      config
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export async function handleSetClaudeApiEndpoint(req, res) {
  const { apiUrl, apiKey } = req.body || {};

  if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
    return res.status(400).json({ success: false, error: 'apiUrl is required' });
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ success: false, error: 'apiKey is required' });
  }

  let parsed;
  try {
    parsed = new URL(apiUrl);
  } catch {
    return res.status(400).json({ success: false, error: 'apiUrl must be a valid URL' });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ success: false, error: 'apiUrl must use http or https' });
  }

  try {
    const config = await setApiEndpoint({ apiUrl: parsed.toString().replace(/\/$/, ''), apiKey });
    res.json({
      success: true,
      message: 'Claude CLI API endpoint updated',
      config
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
}

export default {
  handleGetClaudeConfig,
  handleSetProxyMode,
  handleSetDirectMode,
  handleSetClaudeApiEndpoint
};
