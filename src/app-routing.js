import { listAccounts as listChatGPTAccounts, getAccount as getChatGPTAccount } from './account-manager.js';
import { listAccounts as listClaudeAccounts, getAccount as getClaudeAccount } from './claude-account-manager.js';
import { getProviderById, listApiKeys } from './api-key-manager.js';

export const ROUTING_MODES = ['automatic', 'app-assigned'];
export const APP_IDS = [
  'codex',
  'claude-code',
  'gemini-cli',
  'openclaw',
  'unknown-openai-client',
  'unknown-anthropic-client'
];
export const BINDING_TYPES = ['chatgpt-account', 'claude-account', 'api-key'];

function createEmptyBinding() {
  return {
    id: null,
    type: null,
    targetId: null
  };
}

function normalizeBinding(binding = {}, index = 0) {
  return {
    ...createEmptyBinding(),
    ...binding,
    id: binding?.id || `binding-${index + 1}`,
    type: binding?.type || binding?.bindingType || null,
    targetId: binding?.targetId || binding?.bindingId || null
  };
}

function normalizeLegacyBindings(current = {}) {
  if (Array.isArray(current?.bindings)) {
    return current.bindings.map((binding, index) => normalizeBinding(binding, index));
  }

  if (current?.bindingType || current?.bindingId) {
    return [normalizeBinding({
      id: current?.id || 'binding-1',
      type: current.bindingType || null,
      targetId: current.bindingId || null
    }, 0)];
  }

  return [];
}

export function createDefaultAppRouting() {
  return Object.fromEntries(APP_IDS.map((appId) => [appId, {
    enabled: false,
    fallbackToDefault: true,
    bindings: []
  }]));
}

export function normalizeAppRoutingConfig(appRouting = {}) {
  const defaults = createDefaultAppRouting();
  const normalized = { ...defaults };

  for (const appId of APP_IDS) {
    const current = appRouting?.[appId] || {};
    normalized[appId] = {
      ...defaults[appId],
      ...current,
      enabled: current.enabled === true,
      fallbackToDefault: current.fallbackToDefault !== false,
      bindings: normalizeLegacyBindings(current)
    };
  }

  return normalized;
}

export function detectRequestApp(req) {
  const path = req.path || req.originalUrl || '';
  const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
  const xClient = String(req.headers['x-proxypool-client'] || '').toLowerCase();
  const anthropicVersion = String(req.headers['anthropic-version'] || '').toLowerCase();

  if (path.startsWith('/backend-api/codex/') || path === '/responses' || path === '/responses/compact' || path === '/v1/responses' || path === '/v1/responses/compact') {
    return 'codex';
  }

  if (path.startsWith('/v1beta/models')) {
    return 'gemini-cli';
  }

  if (path === '/v1/messages') {
    if (xClient.includes('openclaw') || userAgent.includes('openclaw')) return 'openclaw';
    if (xClient.includes('claude') || userAgent.includes('claude') || anthropicVersion) return 'claude-code';
    return 'unknown-anthropic-client';
  }

  if (path === '/v1/chat/completions') {
    if (xClient.includes('openclaw') || userAgent.includes('openclaw')) return 'openclaw';
    if (xClient.includes('codex') || userAgent.includes('codex')) return 'codex';
    return 'unknown-openai-client';
  }

  return 'unknown-openai-client';
}

export function getAppBinding(settings, appId) {
  const appRouting = normalizeAppRoutingConfig(settings?.appRouting);
  return appRouting[appId] || null;
}

function assigned(appId, appBinding, binding, credential) {
  return {
    matched: true,
    appId,
    binding,
    appBinding,
    credential,
    credentialType: binding.type,
    fallbackToDefault: appBinding.fallbackToDefault !== false
  };
}

function unavailableAssigned(appId, appBinding, reason, attempts = []) {
  return {
    matched: true,
    appId,
    appBinding,
    fallbackToDefault: appBinding?.fallbackToDefault !== false,
    unavailableReason: reason,
    attempts
  };
}

function resolveSingleBinding(binding) {
  if (!BINDING_TYPES.includes(binding.type) || !binding.targetId) {
    return { ok: false, reason: 'invalid_binding', binding };
  }

  if (binding.type === 'chatgpt-account') {
    const account = getChatGPTAccount(binding.targetId);
    if (!account) return { ok: false, reason: 'account_not_found', binding };
    if (account.enabled === false) return { ok: false, reason: 'account_disabled', binding };
    return { ok: true, credential: account, binding };
  }

  if (binding.type === 'claude-account') {
    const account = getClaudeAccount(binding.targetId);
    if (!account) return { ok: false, reason: 'account_not_found', binding };
    if (account.enabled === false) return { ok: false, reason: 'account_disabled', binding };
    return { ok: true, credential: account, binding };
  }

  const provider = getProviderById(binding.targetId);
  if (!provider) return { ok: false, reason: 'api_key_not_found', binding };
  if (!provider.enabled) return { ok: false, reason: 'api_key_disabled', binding };
  return { ok: true, credential: provider, binding };
}

export function resolveAssignedCredential(settings, appId) {
  const appBinding = getAppBinding(settings, appId);
  if (!appBinding || !appBinding.enabled) {
    return { matched: false, appId, appBinding, fallbackToDefault: true };
  }

  const attempts = [];
  for (const binding of appBinding.bindings || []) {
    const resolved = resolveSingleBinding(binding);
    if (resolved.ok) {
      return assigned(appId, appBinding, binding, resolved.credential);
    }
    attempts.push({ binding, reason: resolved.reason });
  }

  return unavailableAssigned(appId, appBinding, attempts[0]?.reason || 'invalid_binding', attempts);
}

export function validateAppRoutingConfig(appRouting) {
  const normalized = normalizeAppRoutingConfig(appRouting);
  const chatgptEmails = new Set((listChatGPTAccounts().accounts || []).map((account) => account.email));
  const claudeEmails = new Set((listClaudeAccounts().accounts || []).map((account) => account.email));
  const apiKeyIds = new Set((listApiKeys() || []).map((key) => key.id));
  const errors = [];

  for (const appId of APP_IDS) {
    const appBinding = normalized[appId];
    if (!appBinding.enabled) continue;

    if (!Array.isArray(appBinding.bindings) || appBinding.bindings.length === 0) {
      errors.push(`${appId}: at least one binding is required`);
      continue;
    }

    for (const [index, binding] of appBinding.bindings.entries()) {
      const prefix = `${appId} binding #${index + 1}`;
      if (!BINDING_TYPES.includes(binding.type)) {
        errors.push(`${prefix}: invalid binding type`);
        continue;
      }
      if (!binding.targetId || typeof binding.targetId !== 'string') {
        errors.push(`${prefix}: targetId is required`);
        continue;
      }

      if (binding.type === 'chatgpt-account' && !chatgptEmails.has(binding.targetId)) {
        errors.push(`${prefix}: ChatGPT account not found`);
      }
      if (binding.type === 'claude-account' && !claudeEmails.has(binding.targetId)) {
        errors.push(`${prefix}: Claude account not found`);
      }
      if (binding.type === 'api-key' && !apiKeyIds.has(binding.targetId)) {
        errors.push(`${prefix}: API key not found`);
      }
    }
  }

  return { normalized, errors };
}

export function buildAssignableTargets() {
  return {
    appIds: APP_IDS,
    bindingTypes: BINDING_TYPES,
    chatgptAccounts: listChatGPTAccounts().accounts || [],
    claudeAccounts: listClaudeAccounts().accounts || [],
    apiKeys: listApiKeys() || []
  };
}