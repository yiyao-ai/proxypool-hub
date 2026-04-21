import { logger } from '../utils/logger.js';
import { getServerSettings, setServerSettings } from '../server-settings.js';
import agentChannelRegistry from './registry.js';
import agentChannelRouter from './router.js';
import agentChannelOutboundDispatcher from './outbound-dispatcher.js';

function cloneProvider(provider) {
  if (!provider) return null;
  const proto = Object.getPrototypeOf(provider);
  const copy = Object.create(proto);
  Object.assign(copy, provider);
  return copy;
}

function normalizeInstanceId(value, fallback = 'default') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function buildInstanceKey(channelId, instanceId) {
  return `${String(channelId || '')}:${String(instanceId || 'default')}`;
}

function buildDisabledStatus(entry, instance = {}) {
  return {
    providerId: entry.id,
    instanceId: String(instance.id || 'default'),
    running: false,
    enabled: false,
    mode: instance.mode || entry.capabilities?.mode || 'disabled',
    lastError: null,
    lastStartedAt: null
  };
}

export class AgentChannelManager {
  constructor({
    registry = agentChannelRegistry,
    router = agentChannelRouter,
    outboundDispatcher = agentChannelOutboundDispatcher,
    settingsProvider = getServerSettings,
    settingsWriter = setServerSettings
  } = {}) {
    this.registry = registry;
    this.router = router;
    this.outboundDispatcher = outboundDispatcher;
    if (this.outboundDispatcher) {
      this.outboundDispatcher.registry = {
        get: (providerId, instanceId) => this.getInstance(providerId, instanceId)
      };
    }
    this.settingsProvider = settingsProvider;
    this.settingsWriter = settingsWriter;
    this.providerStates = new Map();
    this.providerInstances = new Map();
    this.started = false;
  }

  getSettings() {
    return this.settingsProvider().channels || {};
  }

  listConfiguredInstances(providerId) {
    const channels = this.getSettings();
    const providerConfig = channels[String(providerId || '')] || {};
    if (Array.isArray(providerConfig.instances)) {
      return providerConfig.instances;
    }
    if (providerConfig && typeof providerConfig === 'object' && Object.keys(providerConfig).length > 0) {
      return [{
        id: 'default',
        label: 'Default',
        ...providerConfig
      }];
    }
    return [];
  }

  createChannelInstance(providerId, patch = {}) {
    const channelId = String(providerId || '');
    if (!channelId) {
      throw new Error('channel is required');
    }

    const instances = this.listConfiguredInstances(channelId);
    const nextIndex = instances.length + 1;
    const suggestedId = normalizeInstanceId(
      patch.id || patch.label || `${channelId}-${nextIndex}`,
      nextIndex === 1 ? 'default' : `${channelId}-${nextIndex}`
    );

    if (instances.some((instance) => String(instance?.id || '') === suggestedId)) {
      throw new Error(`channel instance already exists: ${suggestedId}`);
    }

    const nextInstance = {
      ...(instances[0] || {}),
      enabled: false,
      ...patch,
      id: suggestedId,
      label: String(patch.label || `Instance ${nextIndex}`)
    };

    const next = this.settingsWriter({
      channels: {
        ...this.getSettings(),
        [channelId]: {
          instances: [...instances, nextInstance]
        }
      }
    });

    return next.channels?.[channelId]?.instances?.find((instance) => instance.id === suggestedId) || null;
  }

  updateChannelInstanceSettings(providerId, instanceId, patch = {}) {
    const channelId = String(providerId || '');
    const targetInstanceId = normalizeInstanceId(instanceId, 'default');
    if (!channelId) {
      throw new Error('channel is required');
    }

    const instances = this.listConfiguredInstances(channelId);
    if (instances.length === 0) {
      throw new Error(`channel provider not found: ${channelId}`);
    }

    let found = false;
    const nextInstances = instances.map((instance) => {
      if (normalizeInstanceId(instance?.id, 'default') !== targetInstanceId) {
        return instance;
      }
      found = true;
      return {
        ...instance,
        ...patch,
        id: targetInstanceId
      };
    });

    if (!found) {
      throw new Error(`channel instance not found: ${channelId}/${targetInstanceId}`);
    }

    const next = this.settingsWriter({
      channels: {
        ...this.getSettings(),
        [channelId]: {
          instances: nextInstances
        }
      }
    });

    return next.channels?.[channelId]?.instances?.find((instance) => instance.id === targetInstanceId) || null;
  }

  removeChannelInstance(providerId, instanceId) {
    const channelId = String(providerId || '');
    const targetInstanceId = normalizeInstanceId(instanceId, 'default');
    const instances = this.listConfiguredInstances(channelId);
    if (instances.length <= 1) {
      throw new Error('cannot remove the last channel instance');
    }

    const nextInstances = instances.filter((instance) => normalizeInstanceId(instance?.id, 'default') !== targetInstanceId);
    if (nextInstances.length === instances.length) {
      throw new Error(`channel instance not found: ${channelId}/${targetInstanceId}`);
    }

    const next = this.settingsWriter({
      channels: {
        ...this.getSettings(),
        [channelId]: {
          instances: nextInstances
        }
      }
    });

    return next.channels?.[channelId] || null;
  }

  getInstance(providerId, instanceId = 'default') {
    return this.providerInstances.get(buildInstanceKey(providerId, instanceId)) || null;
  }

  getProviderStatuses() {
    const result = [];
    for (const provider of this.registry.list()) {
      const instances = this.listConfiguredInstances(provider.id);
      for (const instance of instances) {
        const key = buildInstanceKey(provider.id, instance.id);
        result.push({
          id: provider.id,
          providerId: provider.id,
          instanceId: String(instance.id || 'default'),
          label: provider.label || provider.id,
          instanceLabel: String(instance.label || instance.id || 'Default'),
          capabilities: provider.capabilities || {},
          configFields: Array.isArray(provider.configFields) ? provider.configFields : [],
          status: this.providerStates.get(key) || buildDisabledStatus(provider, instance)
        });
      }
    }
    return result;
  }

  getStatus(providerId, instanceId = 'default') {
    return this.getProviderStatuses().find((entry) => (
      entry.providerId === String(providerId || '')
      && entry.instanceId === String(instanceId || 'default')
    )) || null;
  }

  async start() {
    if (this.started) {
      return this.getProviderStatuses();
    }

    this.outboundDispatcher.start();
    this.started = true;
    await this.refresh();
    return this.getProviderStatuses();
  }

  async stop() {
    for (const [key, provider] of this.providerInstances.entries()) {
      try {
        await provider?.stop?.();
      } catch (error) {
        logger.warn(`[AgentChannel] Failed to stop ${key}: ${error.message}`);
      }
    }

    const statuses = this.getProviderStatuses();
    for (const entry of statuses) {
      this.providerStates.set(buildInstanceKey(entry.providerId, entry.instanceId), buildDisabledStatus(entry, {
        id: entry.instanceId,
        mode: entry.status?.mode
      }));
    }

    this.providerInstances.clear();
    this.outboundDispatcher.stop();
    this.started = false;
  }

  async refresh() {
    const channels = this.getSettings();
    const activeKeys = new Set();

    for (const entry of this.registry.list()) {
      const instances = Array.isArray(channels?.[entry.id]?.instances) ? channels[entry.id].instances : [];
      for (const instance of instances) {
        const key = buildInstanceKey(entry.id, instance.id);
        activeKeys.add(key);
        await this._refreshProviderInstance(entry.id, instance);
      }
    }

    for (const key of [...this.providerInstances.keys()]) {
      if (activeKeys.has(key)) continue;
      const provider = this.providerInstances.get(key);
      try {
        await provider?.stop?.();
      } catch (error) {
        logger.warn(`[AgentChannel] Failed to stop stale ${key}: ${error.message}`);
      }
      this.providerInstances.delete(key);
      this.providerStates.delete(key);
    }

    return this.getProviderStatuses();
  }

  async _refreshProviderInstance(providerId, instanceSettings = {}) {
    const providerTemplate = this.registry.get(providerId);
    if (!providerTemplate) {
      return;
    }

    const instanceId = normalizeInstanceId(instanceSettings?.id, 'default');
    const key = buildInstanceKey(providerId, instanceId);
    const existingProvider = this.providerInstances.get(key);
    if (existingProvider) {
      try {
        await existingProvider.stop?.();
      } catch (error) {
        logger.warn(`[AgentChannel] Failed to stop ${key} before refresh: ${error.message}`);
      }
    }

    if (instanceSettings.enabled !== true) {
      this.providerInstances.delete(key);
      this.providerStates.set(key, buildDisabledStatus(providerTemplate, {
        id: instanceId,
        mode: instanceSettings.mode
      }));
      return;
    }

    const provider = cloneProvider(providerTemplate);
    if (!provider) {
      return;
    }

    provider.instanceId = instanceId;
    provider.instanceLabel = String(instanceSettings.label || instanceId);
    provider.settings = instanceSettings;

    try {
      const result = await provider.start({
        settings: instanceSettings,
        router: this.router,
        logger
      });

      this.providerInstances.set(key, provider);
      this.providerStates.set(key, {
        providerId,
        instanceId,
        running: result?.started === true,
        enabled: true,
        mode: instanceSettings.mode || provider.capabilities?.mode || 'unknown',
        lastError: result?.started === true ? null : (result?.reason || null),
        lastStartedAt: result?.started === true ? new Date().toISOString() : null
      });
    } catch (error) {
      logger.error(`[AgentChannel] Failed to start ${key}: ${error.message}`);
      this.providerInstances.delete(key);
      this.providerStates.set(key, {
        providerId,
        instanceId,
        running: false,
        enabled: true,
        mode: instanceSettings.mode || provider.capabilities?.mode || 'unknown',
        lastError: error.message,
        lastStartedAt: null
      });
    }
  }
}

export const agentChannelManager = new AgentChannelManager();

export default agentChannelManager;
