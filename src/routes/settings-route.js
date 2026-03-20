/**
 * Settings Route
 * Handles server settings endpoints:
 *   GET  /settings/haiku-model
 *   POST /settings/haiku-model
 *   GET  /settings/account-strategy
 *   POST /settings/account-strategy
 *   GET  /settings/kilo-models
 */

import { getServerSettings, setServerSettings } from '../server-settings.js';
import { fetchFreeModels } from '../kilo-models.js';

const VALID_STRATEGIES = ['sticky', 'round-robin'];

/**
 * GET /settings/haiku-model
 * Returns the current Haiku/Kilo model selection.
 */
export function handleGetHaikuModel(req, res) {
  const settings = getServerSettings();
  res.json({ success: true, haikuKiloModel: settings.haikuKiloModel });
}

/**
 * POST /settings/haiku-model
 * Updates the Haiku/Kilo model selection.
 * Accepts any model ID string — the UI filters to only show free models.
 */
export async function handleSetHaikuModel(req, res) {
  const { haikuKiloModel } = req.body || {};

  if (!haikuKiloModel || typeof haikuKiloModel !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'haikuKiloModel is required and must be a string'
    });
  }

  // Validate against live free models from Kilo API
  try {
    const freeModels = await fetchFreeModels();
    const validIds = freeModels.map(m => m.id);
    if (!validIds.includes(haikuKiloModel)) {
      return res.status(400).json({
        success: false,
        error: `Model "${haikuKiloModel}" is not a free model. Available: ${validIds.join(', ')}`
      });
    }
  } catch (err) {
    // If API is unreachable, allow any value (user may know what they're doing)
    console.warn(`[Settings] Could not validate model against Kilo API: ${err.message}`);
  }

  const settings = setServerSettings({ haikuKiloModel });
  res.json({ success: true, haikuKiloModel: settings.haikuKiloModel });
}

/**
 * GET /settings/kilo-models
 * Returns the list of free Kilo models from the API.
 */
export async function handleGetKiloModels(req, res) {
  try {
    const freeModels = await fetchFreeModels();
    const settings = getServerSettings();
    res.json({
      success: true,
      models: freeModels,
      current: settings.haikuKiloModel
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: `Failed to fetch models: ${error.message}`
    });
  }
}

/**
 * GET /settings/account-strategy
 * Returns the current account selection strategy.
 */
export function handleGetAccountStrategy(req, res) {
  const settings = getServerSettings();
  res.json({ success: true, accountStrategy: settings.accountStrategy });
}

/**
 * POST /settings/account-strategy
 * Updates the account selection strategy.
 */
export function handleSetAccountStrategy(req, res) {
  const { accountStrategy } = req.body || {};

  if (!VALID_STRATEGIES.includes(accountStrategy)) {
    return res.status(400).json({
      success: false,
      error: `Invalid accountStrategy. Use one of: ${VALID_STRATEGIES.join(', ')}`
    });
  }

  const settings = setServerSettings({ accountStrategy });
  res.json({ success: true, accountStrategy: settings.accountStrategy });
}

export default { 
  handleGetHaikuModel, 
  handleSetHaikuModel,
  handleGetKiloModels,
  handleGetAccountStrategy,
  handleSetAccountStrategy
};
