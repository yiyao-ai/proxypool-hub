const credentialState = new Map();
const routingDecisions = [];
const MAX_ROUTING_DECISIONS = 100;

function nowIso() {
  return new Date().toISOString();
}

function cloneState(state = {}) {
  return {
    status: state.status || 'active',
    rateLimitedUntil: state.rateLimitedUntil || null,
    lastError: state.lastError || null,
    lastErrorAt: state.lastErrorAt || null,
    lastSuccessAt: state.lastSuccessAt || null,
    lastUsedAt: state.lastUsedAt || null,
    lastLatencyMs: state.lastLatencyMs ?? null,
    lastModel: state.lastModel || null
  };
}

function cleanupState(state) {
  if (!state) return cloneState();
  if (state.rateLimitedUntil && Date.now() >= state.rateLimitedUntil) {
    state.rateLimitedUntil = null;
    if (state.status === 'cooldown') {
      state.status = 'active';
    }
  }
  return state;
}

export function getCredentialRuntimeState(id) {
  if (!id) return cloneState();
  const existing = credentialState.get(id);
  if (!existing) return cloneState();
  return cloneState(cleanupState(existing));
}

export function listCredentialRuntimeStates() {
  return [...credentialState.entries()].map(([id, state]) => ({
    id,
    ...getCredentialRuntimeState(id)
  }));
}

export function setCredentialRuntimeState(id, patch = {}) {
  if (!id) return cloneState();
  const existing = cleanupState(credentialState.get(id) || cloneState());
  const next = {
    ...existing,
    ...patch
  };
  credentialState.set(id, next);
  return cloneState(next);
}

export function markCredentialRateLimited(id, durationMs = 60000, meta = {}) {
  const until = Date.now() + Math.max(0, Number(durationMs) || 0);
  return setCredentialRuntimeState(id, {
    status: 'cooldown',
    rateLimitedUntil: until,
    lastError: meta.message || 'rate_limited',
    lastErrorAt: nowIso(),
    lastModel: meta.model || null,
    lastUsedAt: nowIso()
  });
}

export function markCredentialError(id, error, meta = {}) {
  const message = typeof error === 'string' ? error : (error?.message || 'unknown_error');
  const invalid = meta.invalid === true;
  return setCredentialRuntimeState(id, {
    status: invalid ? 'invalid' : (meta.status || undefined),
    lastError: message,
    lastErrorAt: nowIso(),
    lastModel: meta.model || null,
    lastUsedAt: nowIso()
  });
}

export function markCredentialSuccess(id, meta = {}) {
  return setCredentialRuntimeState(id, {
    status: 'active',
    rateLimitedUntil: null,
    lastError: null,
    lastErrorAt: null,
    lastSuccessAt: nowIso(),
    lastUsedAt: nowIso(),
    lastLatencyMs: meta.latencyMs ?? null,
    lastModel: meta.model || null
  });
}

export function recordRoutingDecision(decision = {}) {
  const entry = {
    at: nowIso(),
    appId: decision.appId || 'unknown',
    protocol: decision.protocol || 'unknown',
    model: decision.model || null,
    selectedCredentialId: decision.selectedCredentialId || null,
    selectedCredentialKind: decision.selectedCredentialKind || null,
    selectedCredentialLabel: decision.selectedCredentialLabel || null,
    reason: decision.reason || 'unspecified',
    outcome: decision.outcome || 'selected'
  };

  routingDecisions.unshift(entry);
  if (routingDecisions.length > MAX_ROUTING_DECISIONS) {
    routingDecisions.length = MAX_ROUTING_DECISIONS;
  }
  return entry;
}

export function getRecentRoutingDecisions(limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, MAX_ROUTING_DECISIONS));
  return routingDecisions.slice(0, safeLimit);
}

export default {
  getCredentialRuntimeState,
  listCredentialRuntimeStates,
  setCredentialRuntimeState,
  markCredentialRateLimited,
  markCredentialError,
  markCredentialSuccess,
  recordRoutingDecision,
  getRecentRoutingDecisions
};
