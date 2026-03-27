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
import { getDiscoveredModels, discoverModels } from '../model-discovery.js';
import { getMappingsMeta } from '../model-mapping.js';

const VALID_STRATEGIES = ['sticky', 'round-robin'];
const VALID_ROUTING = ['account-first', 'apikey-first'];

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

/**
 * GET /settings/routing-priority
 */
export function handleGetRoutingPriority(req, res) {
  const settings = getServerSettings();
  res.json({ success: true, routingPriority: settings.routingPriority });
}

/**
 * POST /settings/routing-priority
 */
export function handleSetRoutingPriority(req, res) {
  const { routingPriority } = req.body || {};

  if (!VALID_ROUTING.includes(routingPriority)) {
    return res.status(400).json({
      success: false,
      error: `Invalid routingPriority. Use one of: ${VALID_ROUTING.join(', ')}`
    });
  }

  const settings = setServerSettings({ routingPriority });
  res.json({ success: true, routingPriority: settings.routingPriority });
}

/**
 * GET /settings/enable-free-models
 * Returns whether free model routing (Kilo) is enabled.
 */
export function handleGetEnableFreeModels(req, res) {
  const settings = getServerSettings();
  res.json({ success: true, enableFreeModels: settings.enableFreeModels !== false });
}

/**
 * POST /settings/enable-free-models
 * Enables or disables free model routing (Kilo).
 * Body: { enableFreeModels: true|false }
 */
export function handleSetEnableFreeModels(req, res) {
  const { enableFreeModels } = req.body || {};

  if (typeof enableFreeModels !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'enableFreeModels is required and must be a boolean'
    });
  }

  const settings = setServerSettings({ enableFreeModels });
  res.json({ success: true, enableFreeModels: settings.enableFreeModels });
}

/**
 * GET /settings/discovered-models
 * Returns discovered models cache + mapping metadata.
 */
export function handleGetDiscoveredModels(req, res) {
  const discovered = getDiscoveredModels();
  const meta = getMappingsMeta();
  res.json({
    success: true,
    discovered,
    providerModels: meta.providerModels,
    tiers: meta.tiers,
    tierOrder: meta.tierOrder,
    defaults: meta.defaults
  });
}

/**
 * POST /settings/refresh-models
 * Manually trigger model discovery refresh.
 */
export async function handleRefreshDiscoveredModels(req, res) {
  const discovered = await discoverModels();
  const meta = getMappingsMeta();
  res.json({
    success: true,
    discovered: {
      providers: discovered.providers,
      lastRun: discovered.lastRun,
      cacheAge: discovered.lastRun ? Date.now() - discovered.lastRun : null,
      stale: discovered.lastRun ? (Date.now() - discovered.lastRun) > (30 * 60 * 1000) : true
    },
    providerModels: meta.providerModels,
    tiers: meta.tiers,
    tierOrder: meta.tierOrder,
    defaults: meta.defaults
  });
}

export default {
  handleGetHaikuModel,
  handleSetHaikuModel,
  handleGetKiloModels,
  handleGetAccountStrategy,
  handleSetAccountStrategy,
  handleGetRoutingPriority,
  handleSetRoutingPriority,
  handleGetEnableFreeModels,
  handleSetEnableFreeModels,
  handleGetDiscoveredModels,
  handleRefreshDiscoveredModels
};
