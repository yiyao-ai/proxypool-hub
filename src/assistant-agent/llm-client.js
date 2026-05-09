import { listAccounts as listChatGptAccounts } from '../account-manager.js';
import {
  getUsableAccounts,
  listAccounts as listClaudeAccounts
} from '../claude-account-manager.js';
import { selectKey } from '../api-key-manager.js';
import { getServerSettings, setServerSettings } from '../server-settings.js';
import { logger } from '../utils/logger.js';

import { CircuitBreaker, tierKeyFor } from './circuit-breaker.js';
import {
  resolveCredential,
  describeBinding,
  listAvailableCredentials,
  DEFAULT_CHATGPT_MODEL,
  DEFAULT_CLAUDE_MODEL
} from './credential-resolver.js';

let _migrationDone = false;

/**
 * One-shot migration from legacy `assistantAgent.sources` toggles to
 * `assistantAgent.boundModelSource`. Runs at most once per process — picks the
 * first resolvable concrete credential per the historical priority order
 * (anthropic key → openai bridge → azure bridge → claude account → chatgpt
 * account) and writes it back to settings.json. Subsequent runtime config
 * reads see the new shape and skip this entirely.
 */
function migrateLegacySourcesIfNeeded(config) {
  if (_migrationDone) return config;
  if (config.boundModelSource || config.boundCredential || config.bindingConfigured === true) {
    _migrationDone = true;
    return config;
  }

  const legacy = config.sources || {};
  const tries = [];

  if (legacy.anthropicApiKey) {
    tries.push(() => {
      const provider = selectKey('anthropic');
      return provider ? { type: 'api-key', id: provider.id } : null;
    });
  }
  if (legacy.openaiApiKeyBridge) {
    tries.push(() => {
      const provider = selectKey('openai');
      return provider?.sendAnthropicRequest ? { type: 'api-key', id: provider.id } : null;
    });
  }
  if (legacy.azureOpenaiApiKeyBridge) {
    tries.push(() => {
      const provider = selectKey('azure-openai');
      return provider?.sendAnthropicRequest ? { type: 'api-key', id: provider.id } : null;
    });
  }
  if (legacy.claudeAccount) {
    tries.push(() => {
      const usable = typeof getUsableAccounts === 'function' ? getUsableAccounts() : [];
      if (Array.isArray(usable) && usable.length > 0) {
        return { type: 'claude-account', id: usable[0].email };
      }
      const snapshot = listClaudeAccounts();
      const accounts = Array.isArray(snapshot?.accounts)
        ? snapshot.accounts.filter((entry) => entry.enabled !== false)
        : [];
      if (accounts.length === 0) return null;
      return { type: 'claude-account', id: accounts[0].email };
    });
  }
  if (legacy.chatgptAccount) {
    tries.push(() => {
      const snapshot = listChatGptAccounts();
      const accounts = Array.isArray(snapshot?.accounts)
        ? snapshot.accounts.filter((entry) => entry.enabled !== false)
        : [];
      if (accounts.length === 0) return null;
      const active = accounts.find((entry) => entry.email === snapshot.activeAccount) || accounts[0];
      return { type: 'chatgpt-account', id: active.email };
    });
  }

  let resolved = null;
  for (const tryFn of tries) {
    try {
      resolved = tryFn();
      if (resolved) break;
    } catch {
      // ignore and try next
    }
  }
  _migrationDone = true;

  if (!resolved) {
    logger.info('[Supervisor] legacy supervisor config present but no concrete credential resolved; supervisor will run in fallback mode until the user binds one explicitly');
    return config;
  }

  try {
    const persisted = setServerSettings({
      assistantAgent: { ...config, boundModelSource: resolved, boundCredential: resolved }
    });
    logger.info(`[Supervisor] migrated legacy supervisor config → ${resolved.type}::${resolved.id}`);
    return persisted.assistantAgent;
  } catch (error) {
    logger.warn(`[Supervisor] legacy migration failed to persist: ${error?.message || error}`);
    return { ...config, boundModelSource: resolved, boundCredential: resolved };
  }
}

export class AssistantLlmClient {
  constructor({
    defaultChatGptModel = DEFAULT_CHATGPT_MODEL,
    defaultClaudeModel = DEFAULT_CLAUDE_MODEL,
    enabled = process.env.CLIGATE_ENABLE_ASSISTANT_AGENT !== '0'
  } = {}) {
    this.defaultChatGptModel = defaultChatGptModel;
    this.defaultClaudeModel = defaultClaudeModel;
    this.enabled = enabled === true;
    this._breaker = new CircuitBreaker();
    this._lastUsed = null; // { descriptor, kind, label, model, at }
    this._lastFallbackReason = '';
  }

  // ─── Config + migration ──────────────────────────────────────────────────

  getRuntimeConfig() {
    const settings = getServerSettings();
    const stored = settings?.assistantAgent && typeof settings.assistantAgent === 'object'
      ? settings.assistantAgent
      : null;

    let config = stored
      ? {
          enabled: stored.enabled === true,
          bindingConfigured: stored.bindingConfigured === true,
          boundModelSource: stored.boundModelSource || stored.boundCredential || null,
          boundCredential: stored.boundModelSource || stored.boundCredential || null,
          fallbacks: Array.isArray(stored.fallbacks) ? stored.fallbacks : [],
          circuitBreaker: stored.circuitBreaker || { failureThreshold: 3, probeIntervalMs: 300_000 },
          sources: stored.sources || {}
        }
      : {
          enabled: this.enabled,
          bindingConfigured: false,
          boundModelSource: null,
          boundCredential: null,
          fallbacks: [],
          circuitBreaker: { failureThreshold: 3, probeIntervalMs: 300_000 },
          sources: {}
        };

    config = migrateLegacySourcesIfNeeded(config);
    this._breaker.updateThresholds(config.circuitBreaker);
    return config;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  _chainDescriptors(config) {
    const chain = [];
    if (config.boundModelSource || config.boundCredential) {
      chain.push(config.boundModelSource || config.boundCredential);
    }
    if (Array.isArray(config.fallbacks)) {
      for (const entry of config.fallbacks) {
        if (entry && typeof entry === 'object' && entry.type && entry.id) {
          chain.push(entry);
        }
      }
    }
    return chain;
  }

  _pruneBreaker(chain) {
    this._breaker.pruneTo(chain.map((descriptor) => tierKeyFor(descriptor)));
  }

  // ─── Source resolution ───────────────────────────────────────────────────

  async hasAvailableSource() {
    if (!this.getRuntimeConfig().enabled) return false;
    const candidates = await this.listCandidateSources();
    return candidates.length > 0;
  }

  getFallbackReason() {
    const config = this.getRuntimeConfig();
    if (!config.enabled) return 'assistant_agent_disabled';
    if (this._lastFallbackReason) return this._lastFallbackReason;
    if (!(config.boundModelSource || config.boundCredential)) return 'no_supervisor_binding';
    return 'no_available_llm_source';
  }

  /**
   * Walk the binding chain (primary then ordered fallbacks). For each tier:
   *   - skip if circuit breaker says the tier is in cooldown
   *   - resolve the credential into a working candidate
   *   - skip if the credential has been deleted or disabled
   *
   * The returned list is in the order requests should try them. complete()
   * iterates this list and records success/failure on the breaker.
   */
  async listCandidateSources() {
    const config = this.getRuntimeConfig();
    if (!config.enabled) {
      throw new Error('Assistant LLM agent is disabled');
    }

    const chain = this._chainDescriptors(config);
    this._pruneBreaker(chain);

    const candidates = [];
    for (const descriptor of chain) {
      const tierKey = tierKeyFor(descriptor);
      if (this._breaker.shouldSkip(tierKey)) continue;
      const candidate = await resolveCredential(descriptor, {
        defaultChatGptModel: this.defaultChatGptModel,
        defaultClaudeModel: this.defaultClaudeModel
      });
      if (!candidate) continue;
      candidates.push({ ...candidate, tierKey });
    }
    return candidates;
  }

  async resolveSource() {
    const candidates = await this.listCandidateSources();
    if (candidates.length === 0) {
      throw new Error('No assistant model source available');
    }
    return candidates[0];
  }

  // ─── Status snapshot ─────────────────────────────────────────────────────

  /**
   * Snapshot of the current binding chain + breaker state for the UI.
   * Does NOT make any LLM calls; purely reads in-memory state and the
   * configured credential records.
   */
  async inspectStatus() {
    const config = this.getRuntimeConfig();
    const chain = this._chainDescriptors(config);
    this._pruneBreaker(chain);

    const tiers = await Promise.all(chain.map(async (descriptor, index) => {
      const tierKey = tierKeyFor(descriptor);
      const breakerState = this._breaker.getState(tierKey);
      const description = await describeBinding(descriptor);
      return {
        tier: index === 0 ? 'primary' : `fallback-${index}`,
        descriptor,
        resolved: description.ok,
        kind: description.kind || null,
        providerType: description.providerType || null,
        label: description.label || null,
        model: description.model || null,
        reason: description.ok ? '' : (description.reason || ''),
        breaker: breakerState
      };
    }));

    let resolvedSource = null;
    let fallbackReason = '';
    if (!config.enabled) {
      fallbackReason = 'Assistant LLM agent is disabled';
    } else if (chain.length === 0) {
      fallbackReason = 'No supervisor binding configured';
    } else {
      const usable = tiers.find((tier) => tier.resolved && tier.breaker.state !== 'tripped');
      if (usable) {
        resolvedSource = {
          tier: usable.tier,
          descriptor: usable.descriptor,
          kind: usable.kind,
          label: usable.label,
          model: usable.model
        };
      } else {
        fallbackReason = 'All supervisor tiers are unavailable';
      }
    }

    return {
      enabled: config.enabled,
      bindingConfigured: config.bindingConfigured === true,
      boundModelSource: config.boundModelSource || config.boundCredential,
      boundCredential: config.boundModelSource || config.boundCredential,
      fallbacks: config.fallbacks,
      circuitBreaker: config.circuitBreaker,
      tiers,
      // Backwards-compat alias for callers (older UI, route-handlers test) that
      // expect `statuses` to be an array. The shape is the same as `tiers`;
      // remove once the UI moves to the `tiers` key.
      statuses: tiers,
      resolvedSource,
      fallbackReason,
      lastUsed: this._lastUsed,
      // Catalog of all bindable credentials for the UI dropdown.
      catalog: listAvailableCredentials()
    };
  }

  // ─── Breaker controls (used by routes) ───────────────────────────────────

  resetBreaker(descriptor) {
    if (!descriptor) {
      this._breaker.resetAll();
      return;
    }
    this._breaker.reset(tierKeyFor(descriptor));
  }

  getBreakerSnapshot() {
    return this._breaker.snapshot();
  }

  // ─── Send ────────────────────────────────────────────────────────────────

  async complete({
    system,
    messages,
    tools = [],
    model = '',
    maxTokens = 1200
  } = {}) {
    const candidates = await this.listCandidateSources();
    if (candidates.length === 0) {
      this._lastFallbackReason = 'no_available_supervisor_tier';
      throw new Error('No assistant model source available');
    }

    const failures = [];
    for (const source of candidates) {
      try {
        const response = await source.send({
          system,
          messages,
          tools,
          max_tokens: maxTokens,
          model: source.model || model
        });
        this._breaker.recordSuccess(source.tierKey);
        this._lastUsed = {
          descriptor: source.descriptor,
          kind: source.kind,
          label: source.label,
          model: source.model || model,
          at: Date.now()
        };
        this._lastFallbackReason = '';
        return {
          ...response,
          source: {
            kind: source.kind,
            label: source.label,
            model: source.model || model,
            descriptor: source.descriptor
          }
        };
      } catch (error) {
        const breakerState = this._breaker.recordFailure(source.tierKey);
        const message = error?.message || String(error);
        failures.push(`${source.label}: ${message}`);
        logger.warn(`[Supervisor] tier failed | tier=${source.tierKey} | breaker=${breakerState} | reason=${message.slice(0, 200)}`);
      }
    }

    this._lastFallbackReason = `all_supervisor_tiers_failed: ${failures.join(' | ')}`;
    throw new Error(`All assistant model sources failed: ${failures.join(' | ')}`);
  }
}

export const assistantLlmClient = new AssistantLlmClient();

export default assistantLlmClient;
