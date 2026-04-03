import { listAccounts as listChatGPTAccounts, getAccount as getChatGPTAccount, getActiveAccount as getActiveChatGPTAccount } from './account-manager.js';
import { listAccounts as listClaudeAccounts, getAccount as getClaudeAccount, getActiveAccount as getActiveClaudeAccount } from './claude-account-manager.js';
import { listAccounts as listAntigravityAccounts, getAccount as getAntigravityAccount, getActiveAccount as getActiveAntigravityAccount } from './antigravity-account-manager.js';
import { listApiKeys, getProviderById } from './api-key-manager.js';
import { getCredentialRuntimeState } from './runtime-state.js';

export function buildCredentialId(kind, targetId) {
  return `${kind}:${targetId}`;
}

function deriveStatus(summary, runtime) {
  if (summary.enabled === false) {
    return { status: 'disabled', reason: 'disabled' };
  }
  if (summary.tokenExpired === true) {
    return { status: 'invalid', reason: 'token_expired' };
  }
  if (runtime.rateLimitedUntil && runtime.rateLimitedUntil > Date.now()) {
    return { status: 'cooldown', reason: 'rate_limited' };
  }
  if (runtime.status === 'invalid') {
    return { status: 'invalid', reason: runtime.lastError || 'invalid' };
  }
  return { status: 'active', reason: null };
}

function buildDescriptor(kind, provider, targetId, summary, raw, { includeRaw = false } = {}) {
  const id = buildCredentialId(kind, targetId);
  const runtime = getCredentialRuntimeState(id);
  const statusInfo = deriveStatus(summary, runtime);
  return {
    id,
    kind,
    provider,
    targetId,
    label: summary.displayName || summary.name || summary.email || summary.id || targetId,
    enabled: summary.enabled !== false,
    isActive: summary.isActive === true,
    tokenExpired: summary.tokenExpired === true,
    addedAt: summary.addedAt || null,
    lastUsed: summary.lastUsed || null,
    totalRequests: summary.totalRequests ?? 0,
    status: statusInfo.status,
    statusReason: statusInfo.reason,
    rateLimitedUntil: runtime.rateLimitedUntil,
    lastError: runtime.lastError,
    runtime,
    ...(includeRaw ? { raw } : {})
  };
}

function mapChatGPT(includeRaw = false) {
  const active = getActiveChatGPTAccount();
  return (listChatGPTAccounts().accounts || []).map((account) => {
    const raw = includeRaw ? getChatGPTAccount(account.email) : null;
    return buildDescriptor(
      'chatgpt-account',
      'openai',
      account.email,
      { ...account, isActive: active?.email === account.email },
      raw,
      { includeRaw }
    );
  });
}

function mapClaude(includeRaw = false) {
  const active = getActiveClaudeAccount();
  return (listClaudeAccounts().accounts || []).map((account) => {
    const raw = includeRaw ? getClaudeAccount(account.email) : null;
    return buildDescriptor(
      'claude-account',
      'anthropic',
      account.email,
      { ...account, isActive: active?.email === account.email },
      raw,
      { includeRaw }
    );
  });
}

function mapAntigravity(includeRaw = false) {
  const active = getActiveAntigravityAccount();
  return (listAntigravityAccounts().accounts || []).map((account) => {
    const raw = includeRaw ? getAntigravityAccount(account.email) : null;
    return buildDescriptor(
      'antigravity-account',
      'google',
      account.email,
      { ...account, isActive: active?.email === account.email },
      raw,
      { includeRaw }
    );
  });
}

function mapApiKeys(includeRaw = false) {
  return (listApiKeys() || []).map((key) => {
    const raw = includeRaw ? getProviderById(key.id) : null;
    return buildDescriptor(
      'api-key',
      key.type,
      key.id,
      key,
      raw,
      { includeRaw }
    );
  });
}

export function listAllCredentials(options = {}) {
  const includeRaw = options.includeRaw === true;
  return [
    ...mapChatGPT(includeRaw),
    ...mapClaude(includeRaw),
    ...mapAntigravity(includeRaw),
    ...mapApiKeys(includeRaw)
  ];
}

export function getCredentialById(id, options = {}) {
  return listAllCredentials(options).find((credential) => credential.id === id) || null;
}

export function isCredentialAvailable(credential) {
  return !!credential && credential.enabled !== false && credential.status === 'active';
}

export default {
  buildCredentialId,
  listAllCredentials,
  getCredentialById,
  isCredentialAvailable
};
