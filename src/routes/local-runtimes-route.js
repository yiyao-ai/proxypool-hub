import { getServerSettings, setServerSettings } from '../server-settings.js';
import {
  getLocalRuntimeById,
  listLocalRuntimes,
  updateLocalRuntime
} from '../local-runtime-manager.js';
import { checkOllamaHealth, listOllamaModels } from '../runtimes/ollama.js';
import { discoverModels } from '../model-discovery.js';
import { buildAssignableTargets } from '../app-routing.js';

function buildPayload(runtime, health = null, models = null, extra = {}) {
  return {
    success: true,
    enabled: getServerSettings().localModelRoutingEnabled === true,
    runtime,
    runtimes: listLocalRuntimes(),
    health,
    models,
    ...extra
  };
}

export function handleGetLocalRuntimeStatus(req, res) {
  const runtime = getLocalRuntimeById('ollama-local');
  res.json(buildPayload(runtime));
}

export function handleSetLocalRuntimeEnabled(req, res) {
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'enabled must be a boolean' });
  }

  setServerSettings({ localModelRoutingEnabled: enabled });
  const runtime = getLocalRuntimeById('ollama-local');
  res.json(buildPayload(runtime));
}

export function handleUpdateLocalRuntime(req, res) {
  const runtime = updateLocalRuntime('ollama-local', req.body || {});
  res.json(buildPayload(runtime));
}

export async function handleCheckLocalRuntime(req, res) {
  const runtime = getLocalRuntimeById('ollama-local');
  if (!runtime) {
    return res.status(404).json({ success: false, error: 'No local runtime configured' });
  }

  const health = await checkOllamaHealth(runtime.baseUrl);
  res.json(buildPayload(runtime, health));
}

export async function handleRefreshLocalRuntimeModels(req, res) {
  const runtime = getLocalRuntimeById('ollama-local');
  if (!runtime) {
    return res.status(404).json({ success: false, error: 'No local runtime configured' });
  }

  try {
    const models = await listOllamaModels(runtime.baseUrl);
    await discoverModels();
    res.json(buildPayload(runtime, null, models, {
      targets: buildAssignableTargets()
    }));
  } catch (error) {
    res.status(502).json({ success: false, error: error.message });
  }
}

export default {
  handleGetLocalRuntimeStatus,
  handleSetLocalRuntimeEnabled,
  handleUpdateLocalRuntime,
  handleCheckLocalRuntime,
  handleRefreshLocalRuntimeModels
};
