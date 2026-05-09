/**
 * Circuit breaker state machine for assistant supervisor model sources.
 *
 * Each tier (primary + ordered fallbacks) is identified by a stable key (e.g.
 * `api-key::key_xyz`). The breaker maintains in-memory state per tier; nothing
 * is persisted, so process restart resets everything to healthy. That's a
 * deliberate trade-off: simpler state, no stale rate-limit windows, and the
 * first real request after restart re-probes.
 *
 * Lifecycle (per tier):
 *
 *   HEALTHY  ── recordFailure × N ──▶ TRIPPED
 *      ▲                                │
 *      │                          (nextProbeAt expires)
 *      │                                │
 *   recordSuccess ◀── probe success ──┘
 *
 * Real requests on healthy tiers validate health implicitly; we do not poll
 * healthy tiers in the background. Tripped tiers are probed by the caller
 * (a probe loop in llm-client.js) when `isProbeReady(key)` returns true; the
 * caller invokes recordSuccess on success or rescheduleProbe on failure.
 */

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_PROBE_INTERVAL_MS = 300_000; // 5 minutes

export class CircuitBreaker {
    constructor({
        failureThreshold = DEFAULT_FAILURE_THRESHOLD,
        probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
        now = () => Date.now()
    } = {}) {
        this.failureThreshold = failureThreshold;
        this.probeIntervalMs = probeIntervalMs;
        this._now = now;
        this._tiers = new Map();
    }

    _ensure(key) {
        if (!this._tiers.has(key)) {
            this._tiers.set(key, {
                state: 'healthy',
                consecutiveFailures: 0,
                trippedAt: null,
                nextProbeAt: null,
                lastSuccessAt: null,
                lastFailureAt: null
            });
        }
        return this._tiers.get(key);
    }

    /**
     * Record a successful request (real or probe). Resets the tier to healthy
     * and clears the failure counter.
     */
    recordSuccess(key) {
        const tier = this._ensure(key);
        tier.state = 'healthy';
        tier.consecutiveFailures = 0;
        tier.trippedAt = null;
        tier.nextProbeAt = null;
        tier.lastSuccessAt = this._now();
    }

    /**
     * Record a failed request. Returns the resulting state ('healthy' or
     * 'tripped'). Trips when consecutiveFailures reaches failureThreshold.
     */
    recordFailure(key) {
        const tier = this._ensure(key);
        tier.consecutiveFailures += 1;
        tier.lastFailureAt = this._now();
        if (tier.state === 'healthy' && tier.consecutiveFailures >= this.failureThreshold) {
            tier.state = 'tripped';
            tier.trippedAt = this._now();
            tier.nextProbeAt = tier.trippedAt + this.probeIntervalMs;
        }
        return tier.state;
    }

    /**
     * True when the tier is tripped and the cooldown hasn't expired. Caller
     * should skip this tier and try the next one in the chain.
     */
    shouldSkip(key) {
        const tier = this._tiers.get(key);
        if (!tier || tier.state !== 'tripped') return false;
        return this._now() < (tier.nextProbeAt || 0);
    }

    /**
     * True when the tier is tripped and ready for a probe attempt.
     */
    isProbeReady(key) {
        const tier = this._tiers.get(key);
        if (!tier || tier.state !== 'tripped') return false;
        return this._now() >= (tier.nextProbeAt || 0);
    }

    /**
     * Called by the probe loop after a probe failure. Pushes nextProbeAt out
     * by another probeIntervalMs so we don't hammer a broken upstream.
     */
    rescheduleProbe(key) {
        const tier = this._tiers.get(key);
        if (!tier) return;
        tier.nextProbeAt = this._now() + this.probeIntervalMs;
    }

    /**
     * Force-reset a single tier to healthy state. Used by the UI's manual
     * "reset breaker" action and when the user changes the binding for that
     * tier (so stale state doesn't leak across config changes).
     */
    reset(key) {
        this._tiers.delete(key);
    }

    /**
     * Drop all tier state.
     */
    resetAll() {
        this._tiers.clear();
    }

    /**
     * Remove tier state for keys not in `keepKeys`. Use this when the user
     * reconfigures the binding chain so removed credentials don't keep
     * accumulating state.
     */
    pruneTo(keepKeys) {
        const keep = new Set(keepKeys);
        for (const key of [...this._tiers.keys()]) {
            if (!keep.has(key)) this._tiers.delete(key);
        }
    }

    /**
     * Read-only view of one tier's state. Returns the canonical "healthy and
     * never seen" shape if the tier is unknown.
     */
    getState(key) {
        const tier = this._tiers.get(key);
        if (!tier) {
            return {
                state: 'healthy',
                consecutiveFailures: 0,
                trippedAt: null,
                nextProbeAt: null,
                lastSuccessAt: null,
                lastFailureAt: null
            };
        }
        return { ...tier };
    }

    /**
     * Snapshot of all known tiers, keyed by tier key. Used by inspectStatus.
     */
    snapshot() {
        const result = {};
        for (const [key, tier] of this._tiers.entries()) {
            result[key] = { ...tier };
        }
        return result;
    }

    /**
     * Update threshold/interval at runtime (e.g., after a settings change).
     * Existing tier state is left intact; new thresholds apply to subsequent
     * failures and probes.
     */
    updateThresholds({ failureThreshold, probeIntervalMs } = {}) {
        if (Number.isFinite(failureThreshold) && failureThreshold >= 1) {
            this.failureThreshold = Math.floor(failureThreshold);
        }
        if (Number.isFinite(probeIntervalMs) && probeIntervalMs >= 1000) {
            this.probeIntervalMs = Math.floor(probeIntervalMs);
        }
    }
}

/**
 * Build a stable tier key from a bound-credential descriptor.
 */
export function tierKeyFor({ type, id, model } = {}) {
    if (!type || !id) return '';
    const modelKey = typeof model === 'string' && model.trim()
        ? `::${model.trim()}`
        : '';
    return `${String(type)}::${String(id)}${modelKey}`;
}

export default CircuitBreaker;
