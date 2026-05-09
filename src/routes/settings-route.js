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
import { ROUTING_MODES, validateAppRoutingConfig, buildAssignableTargets } from '../app-routing.js';
import { isSupportedStrategyName, normalizeStrategyName, STRATEGIES } from '../account-rotation/strategies/index.js';

const VALID_STRATEGIES = [STRATEGIES.RANDOM, STRATEGIES.SEQUENTIAL];
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
  res.json({ success: true, accountStrategy: normalizeStrategyName(settings.accountStrategy) });
}

/**
 * POST /settings/account-strategy
 * Updates the account selection strategy.
 */
export function handleSetAccountStrategy(req, res) {
  const { accountStrategy } = req.body || {};

  if (!isSupportedStrategyName(accountStrategy)) {
    return res.status(400).json({
      success: false,
      error: `Invalid accountStrategy. Use one of: ${VALID_STRATEGIES.join(', ')}`
    });
  }

  const normalized = normalizeStrategyName(accountStrategy);
  const settings = setServerSettings({ accountStrategy: normalized });
  res.json({ success: true, accountStrategy: normalizeStrategyName(settings.accountStrategy) });
}

/**
 * GET /settings/routing-priority
 */
export function handleGetRoutingPriority(req, res) {
  const settings = getServerSettings();
  res.json({ success: true, routingPriority: settings.routingPriority });
}

/**
 * GET /settings/routing-mode
 */
export function handleGetRoutingMode(req, res) {
  const settings = getServerSettings();
  res.json({ success: true, routingMode: settings.routingMode || 'automatic' });
}

export function handleGetStrictCodexCompatibility(req, res) {
  const settings = getServerSettings();
  res.json({
    success: true,
    strictCodexCompatibility: settings.strictCodexCompatibility !== false
  });
}

export function handleGetStrictTranslatorCompatibility(req, res) {
  const settings = getServerSettings();
  res.json({
    success: true,
    strictTranslatorCompatibility: settings.strictTranslatorCompatibility === true
  });
}

export function handleSetStrictCodexCompatibility(req, res) {
  const { strictCodexCompatibility } = req.body || {};

  if (typeof strictCodexCompatibility !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'strictCodexCompatibility is required and must be a boolean'
    });
  }

  const settings = setServerSettings({ strictCodexCompatibility });
  res.json({
    success: true,
    strictCodexCompatibility: settings.strictCodexCompatibility !== false
  });
}

export function handleSetStrictTranslatorCompatibility(req, res) {
  const { strictTranslatorCompatibility } = req.body || {};

  if (typeof strictTranslatorCompatibility !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'strictTranslatorCompatibility is required and must be a boolean'
    });
  }

  const settings = setServerSettings({ strictTranslatorCompatibility });
  res.json({
    success: true,
    strictTranslatorCompatibility: settings.strictTranslatorCompatibility === true
  });
}

/**
 * POST /settings/routing-mode
 */
export function handleSetRoutingMode(req, res) {
  const { routingMode } = req.body || {};

  if (!ROUTING_MODES.includes(routingMode)) {
    return res.status(400).json({
      success: false,
      error: `Invalid routingMode. Use one of: ${ROUTING_MODES.join(', ')}`
    });
  }

  const settings = setServerSettings({ routingMode });
  res.json({ success: true, routingMode: settings.routingMode });
}

/**
 * GET /settings/app-routing
 */
export function handleGetAppRouting(req, res) {
  const settings = getServerSettings();
  res.json({
    success: true,
    routingMode: settings.routingMode || 'automatic',
    appRouting: settings.appRouting,
    targets: buildAssignableTargets()
  });
}

/**
 * POST /settings/app-routing
 */
export function handleSetAppRouting(req, res) {
  const { appRouting } = req.body || {};
  const { normalized, errors } = validateAppRoutingConfig(appRouting);

  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: errors.join('; ') });
  }

  const settings = setServerSettings({ appRouting: normalized });
  res.json({
    success: true,
    appRouting: settings.appRouting,
    targets: buildAssignableTargets()
  });
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

export function handleGetLocalModelRoutingEnabled(req, res) {
  const settings = getServerSettings();
  res.json({
    success: true,
    localModelRoutingEnabled: settings.localModelRoutingEnabled === true
  });
}

export function handleGetAssistantAgentConfig(req, res) {
  const settings = getServerSettings();
  res.json({
    success: true,
    assistantAgent: settings.assistantAgent
  });
}

function isBooleanRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function isDescriptor(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.type === 'string'
    && typeof value.id === 'string'
    && (value.model === undefined || typeof value.model === 'string');
}

export function handleSetAssistantAgentConfig(req, res) {
  const { assistantAgent } = req.body || {};
  if (!assistantAgent || typeof assistantAgent !== 'object' || Array.isArray(assistantAgent)) {
    return res.status(400).json({
      success: false,
      error: 'assistantAgent is required and must be an object'
    });
  }

  if (typeof assistantAgent.enabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'assistantAgent.enabled is required and must be a boolean'
    });
  }

  const sourceKeys = [
    'chatgptAccount',
    'claudeAccount',
    'anthropicApiKey',
    'openaiApiKeyBridge',
    'azureOpenaiApiKeyBridge'
  ];

  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'sources')) {
    if (!isBooleanRecord(assistantAgent.sources)) {
      return res.status(400).json({
        success: false,
        error: 'assistantAgent.sources must be an object when provided'
      });
    }
    for (const key of sourceKeys) {
      if (typeof assistantAgent.sources[key] !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: `assistantAgent.sources.${key} is required and must be a boolean`
        });
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'boundCredential')) {
    const { boundCredential } = assistantAgent;
    if (boundCredential !== null && !isDescriptor(boundCredential)) {
      return res.status(400).json({
        success: false,
        error: 'assistantAgent.boundCredential must be { type, id } or null'
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'boundModelSource')) {
    const { boundModelSource } = assistantAgent;
    if (boundModelSource !== null && !isDescriptor(boundModelSource)) {
      return res.status(400).json({
        success: false,
        error: 'assistantAgent.boundModelSource must be { type, id, model? } or null'
      });
    }
  }

  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'fallbacks')) {
    if (!Array.isArray(assistantAgent.fallbacks)) {
      return res.status(400).json({
        success: false,
        error: 'assistantAgent.fallbacks must be an array'
      });
    }
    for (const entry of assistantAgent.fallbacks) {
      if (!isDescriptor(entry)) {
        return res.status(400).json({
          success: false,
          error: 'assistantAgent.fallbacks entries must be { type, id }'
        });
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'circuitBreaker')) {
    const { circuitBreaker } = assistantAgent;
    if (circuitBreaker !== null && (!circuitBreaker || typeof circuitBreaker !== 'object' || Array.isArray(circuitBreaker))) {
      return res.status(400).json({
        success: false,
        error: 'assistantAgent.circuitBreaker must be an object or null'
      });
    }
  }

  const current = getServerSettings().assistantAgent || {};
  const next = {
    ...current,
    enabled: assistantAgent.enabled
  };

  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'sources')) {
    next.sources = assistantAgent.sources;
  }
  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'boundCredential')) {
    next.boundCredential = assistantAgent.boundCredential;
    next.boundModelSource = assistantAgent.boundCredential;
    next.bindingConfigured = true;
  }
  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'boundModelSource')) {
    next.boundModelSource = assistantAgent.boundModelSource;
    next.boundCredential = assistantAgent.boundModelSource;
    next.bindingConfigured = true;
  }
  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'fallbacks')) {
    next.fallbacks = assistantAgent.fallbacks;
    next.bindingConfigured = true;
  }
  if (Object.prototype.hasOwnProperty.call(assistantAgent, 'circuitBreaker')) {
    next.circuitBreaker = assistantAgent.circuitBreaker;
    next.bindingConfigured = true;
  }

  const settings = setServerSettings({
    assistantAgent: next
  });
  res.json({
    success: true,
    assistantAgent: settings.assistantAgent
  });
}

export function handleSetLocalModelRoutingEnabled(req, res) {
  const { localModelRoutingEnabled } = req.body || {};

  if (typeof localModelRoutingEnabled !== 'boolean') {
    return res.status(400).json({
      success: false,
      error: 'localModelRoutingEnabled is required and must be a boolean'
    });
  }

  const settings = setServerSettings({ localModelRoutingEnabled });
  res.json({
    success: true,
    localModelRoutingEnabled: settings.localModelRoutingEnabled === true
  });
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
  handleGetRoutingMode,
  handleGetStrictCodexCompatibility,
  handleGetStrictTranslatorCompatibility,
  handleSetRoutingMode,
  handleGetAppRouting,
  handleSetAppRouting,
  handleSetRoutingPriority,
  handleSetStrictCodexCompatibility,
  handleSetStrictTranslatorCompatibility,
  handleGetEnableFreeModels,
  handleSetEnableFreeModels,
  handleGetAssistantAgentConfig,
  handleSetAssistantAgentConfig,
  handleGetLocalModelRoutingEnabled,
  handleSetLocalModelRoutingEnabled,
  handleGetDiscoveredModels,
  handleRefreshDiscoveredModels
};
