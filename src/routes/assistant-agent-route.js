import assistantLlmClient from '../assistant-agent/llm-client.js';
import { describeBinding, listAvailableCredentials } from '../assistant-agent/credential-resolver.js';
import { getServerSettings, setServerSettings } from '../server-settings.js';

export async function handleGetAssistantAgentStatus(_req, res) {
  try {
    const status = await assistantLlmClient.inspectStatus();
    return res.json({ success: true, status });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * POST /api/assistant/agent-binding/test
 * Body: { type, id }
 * Verifies the descriptor resolves to an enabled, present credential. Does
 * NOT send an LLM call — purely a registry lookup.
 */
export async function handleTestAssistantBinding(req, res) {
  try {
    const body = req.body || {};
    const result = await describeBinding({ type: body.type, id: body.id });
    return res.json({ success: result.ok, ...result });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /api/assistant/agent-binding/catalog
 * Returns the inventory of credentials the user could bind to (api keys
 * grouped by provider type, claude accounts, chatgpt accounts) with light
 * health metadata for the UI dropdown.
 */
export function handleGetAssistantBindingCatalog(_req, res) {
  try {
    const catalog = listAvailableCredentials();
    return res.json({ success: true, catalog });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

function isValidDescriptorPayload(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  if (typeof value.type !== 'string' || typeof value.id !== 'string') {
    return false;
  }
  return value.model === undefined || typeof value.model === 'string';
}

/**
 * POST /api/assistant/agent-binding
 * Body: {
 *   enabled?: boolean,
 *   boundModelSource?: { type, id, model? } | null,
 *   boundCredential?: { type, id } | null,
 *   fallbacks?: Array<{ type, id }>,
 *   circuitBreaker?: { failureThreshold?, probeIntervalMs? }
 * }
 * Updates the supervisor binding chain. `null` for boundCredential
 * deliberately clears it (supervisor falls back to deterministic runner).
 * Each field is optional; missing fields keep their current value.
 */
export function handleSetAssistantBinding(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : null;
  if (!body) {
    return res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
  }

  const current = getServerSettings().assistantAgent || {};
  const next = { ...current, bindingConfigured: true };

  if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: '`enabled` must be boolean' });
    }
    next.enabled = body.enabled;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'boundCredential')) {
    if (!isValidDescriptorPayload(body.boundCredential)) {
      return res.status(400).json({ success: false, error: '`boundCredential` must be {type,id} or null' });
    }
    next.boundCredential = body.boundCredential;
    next.boundModelSource = body.boundCredential;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'boundModelSource')) {
    if (!isValidDescriptorPayload(body.boundModelSource)) {
      return res.status(400).json({ success: false, error: '`boundModelSource` must be {type,id,model?} or null' });
    }
    next.boundModelSource = body.boundModelSource;
    next.boundCredential = body.boundModelSource;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'fallbacks')) {
    if (!Array.isArray(body.fallbacks)) {
      return res.status(400).json({ success: false, error: '`fallbacks` must be an array' });
    }
    for (const entry of body.fallbacks) {
      if (!isValidDescriptorPayload(entry) || entry === null) {
        return res.status(400).json({ success: false, error: '`fallbacks` entries must be {type,id}' });
      }
    }
    next.fallbacks = body.fallbacks;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'circuitBreaker')) {
    const cb = body.circuitBreaker;
    if (cb !== null && (typeof cb !== 'object')) {
      return res.status(400).json({ success: false, error: '`circuitBreaker` must be object or null' });
    }
    next.circuitBreaker = cb;
  }

  try {
    const persisted = setServerSettings({ assistantAgent: next });
    // Reset breaker state for any tier whose descriptor changed so stale
    // failure counts don't leak across reconfiguration.
    assistantLlmClient.resetBreaker();
    return res.json({ success: true, assistantAgent: persisted.assistantAgent });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * POST /api/assistant/agent-binding/breaker/reset
 * Body: { descriptor?: { type, id } }
 * If `descriptor` is provided, resets only that tier; otherwise resets all.
 */
export function handleResetAssistantBreaker(req, res) {
  try {
    const descriptor = req.body?.descriptor;
    if (descriptor && !isValidDescriptorPayload(descriptor)) {
      return res.status(400).json({ success: false, error: '`descriptor` must be {type,id}' });
    }
    assistantLlmClient.resetBreaker(descriptor || null);
    return res.json({ success: true, breaker: assistantLlmClient.getBreakerSnapshot() });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export default {
  handleGetAssistantAgentStatus,
  handleTestAssistantBinding,
  handleGetAssistantBindingCatalog,
  handleSetAssistantBinding,
  handleResetAssistantBreaker
};
