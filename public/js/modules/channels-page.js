export function createChannelsPageModule() {
  return {
    channelProviders: [],
    channelProvidersLoading: false,
    channelCatalog: [],
    channelSettings: {},
    channelSettingsSaving: {},
    channelInstanceExpanded: {},
    channelConversations: [],
    channelConversationsLoading: false,
    selectedChannelConversationId: '',
    selectedChannelConversation: null,
    channelConversationMessages: [],
    channelConversationLoading: false,
    channelConversationQuery: '',
    channelConversationChannelFilter: 'all',
    channelConversationStateFilter: 'all',

    get filteredChannelConversations() {
      const query = String(this.channelConversationQuery || '').trim().toLowerCase();
      const channelFilter = String(this.channelConversationChannelFilter || 'all');
      const stateFilter = String(this.channelConversationStateFilter || 'all');

      return this.channelConversations.filter((conversation) => {
        if (channelFilter !== 'all' && conversation.channel !== channelFilter) {
          return false;
        }

        const state = this.channelConversationStateValue(conversation);
        if (stateFilter !== 'all' && state !== stateFilter) {
          return false;
        }

        if (!query) {
          return true;
        }

        const haystack = [
          conversation.title,
          conversation.provider,
          conversation.model,
          conversation.summary,
          conversation.channel,
          conversation.externalConversationId,
          conversation.externalUserId,
          conversation.lastMessagePreview
        ]
          .map((item) => String(item || '').toLowerCase())
          .join(' ');

        return haystack.includes(query);
      });
    },

    get channelConversationFilterOptions() {
      const options = [];
      const seen = new Set();

      const addOption = (id, label) => {
        const value = String(id || '').trim();
        if (!value || value === 'all' || seen.has(value)) return;
        seen.add(value);
        options.push({
          id: value,
          label: String(label || value).trim() || value
        });
      };

      for (const provider of this.channelCatalog) {
        addOption(provider?.id, provider?.label);
      }

      for (const provider of this.channelProviders) {
        addOption(provider?.id, provider?.label);
      }

      for (const conversation of this.channelConversations) {
        addOption(conversation?.channel, conversation?.channel);
      }

      return options;
    },

    channelProviderStatusClass(provider) {
      const status = provider?.status || {};
      if (status.running) return 'bg-green-500/10 text-green-300 border-green-500/30';
      if (status.enabled && status.lastError) return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
      if (status.enabled) return 'bg-blue-500/10 text-blue-300 border-blue-500/30';
      return 'bg-space-800 text-gray-300 border-space-border/40';
    },

    channelProviderStatusLabel(provider) {
      const status = provider?.status || {};
      if (status.running) return this.t('channelStatusRunning');
      if (status.enabled && status.lastError) return this.t('channelStatusError');
      if (status.enabled) return this.t('channelStatusEnabled');
      return this.t('channelStatusDisabled');
    },

    channelProviderFormSections(provider) {
      const fields = Array.isArray(provider?.configFields) ? provider.configFields : [];
      const ordered = ['basic', 'auth', 'transport', 'runtime', 'security', 'advanced'];
      return ordered
        .map((section) => ({
          section,
          fields: fields.filter((field) => (field?.section || 'advanced') === section)
        }))
        .filter((group) => group.fields.length > 0);
    },

    channelFieldInputType(field) {
      if (field?.type === 'password') return 'password';
      if (field?.type === 'number') return 'number';
      return 'text';
    },

    channelFieldLabel(field) {
      return this.t(field?.labelKey || field?.key || '');
    },

    channelFieldDescription(field) {
      return field?.descriptionKey ? this.t(field.descriptionKey) : '';
    },

    channelFieldPlaceholder(field) {
      return field?.placeholderKey ? this.t(field.placeholderKey) : '';
    },

    channelSectionLabel(section) {
      if (section === 'basic') return 'Basic';
      if (section === 'auth') return 'Auth';
      if (section === 'transport') return 'Transport';
      if (section === 'runtime') return 'Runtime';
      if (section === 'security') return 'Security';
      return 'Advanced';
    },

    defaultChannelFieldValue(field) {
      if (field?.key === 'id') return 'default';
      if (field?.key === 'label') return 'Default';
      if (field?.type === 'boolean') return false;
      if (field?.type === 'number') return 0;
      if (field?.type === 'select' && Array.isArray(field.options) && field.options[0]) return field.options[0].value;
      if (field?.type === 'runtime-provider') return this.agentRuntimeProviders?.[0]?.id || 'codex';
      return '';
    },

    buildDefaultChannelInstance(provider, overrides = {}) {
      const instance = {
        id: 'default',
        label: 'Default'
      };
      for (const field of (provider?.configFields || [])) {
        instance[field.key] = this.defaultChannelFieldValue(field);
      }
      return {
        ...instance,
        ...overrides
      };
    },

    ensureChannelProviderState(provider) {
      if (!provider?.id) return;
      if (!this.channelSettings[provider.id]) {
        this.channelSettings[provider.id] = { instances: [this.buildDefaultChannelInstance(provider)] };
      }
      if (!Array.isArray(this.channelSettings[provider.id].instances) || this.channelSettings[provider.id].instances.length === 0) {
        this.channelSettings[provider.id].instances = [this.buildDefaultChannelInstance(provider)];
      }
      for (const instance of this.channelSettings[provider.id].instances) {
        if (!instance.id) instance.id = 'default';
        if (!instance.label) instance.label = instance.id === 'default' ? 'Default' : instance.id;
        for (const field of (provider.configFields || [])) {
          if (instance[field.key] === undefined) {
            instance[field.key] = this.defaultChannelFieldValue(field);
          }
        }
      }
    },

    channelProviderInstances(provider) {
      this.ensureChannelProviderState(provider);
      return this.channelSettings[provider?.id]?.instances || [];
    },

    channelProviderStatusEntries(provider) {
      return (this.channelProviders || []).filter((entry) => entry.providerId === provider?.id || entry.id === provider?.id);
    },

    channelInstanceStatus(providerId, instanceId) {
      return (this.channelProviders || []).find((entry) => (
        (entry.providerId || entry.id) === providerId
        && String(entry.instanceId || 'default') === String(instanceId || 'default')
      )) || null;
    },

    channelInstanceKey(providerId, instanceId) {
      return `${String(providerId || '')}:${String(instanceId || 'default')}`;
    },

    isChannelInstanceExpanded(providerId, instanceId) {
      return this.channelInstanceExpanded[this.channelInstanceKey(providerId, instanceId)] === true;
    },

    toggleChannelInstanceExpanded(providerId, instanceId) {
      const key = this.channelInstanceKey(providerId, instanceId);
      this.channelInstanceExpanded[key] = !this.channelInstanceExpanded[key];
    },

    channelInstanceSummary(provider, instance) {
      const status = this.channelInstanceStatus(provider?.id, instance?.id);
      const parts = [];
      if (instance?.mode) parts.push(instance.mode);
      parts.push(instance?.enabled === true ? this.t('channelStatusEnabled') : this.t('channelStatusDisabled'));
      if (instance?.defaultRuntimeProvider) {
        parts.push(this.chatRuntimeProviderLabel(instance.defaultRuntimeProvider));
      }
      if (instance?.model) {
        parts.push(instance.model);
      }
      if (status?.status?.lastError) {
        parts.push(this.t('channelStatusError'));
      }
      return parts.filter(Boolean).join(' · ');
    },

    channelWebhookHint(providerId, instance) {
      if (!instance || instance.mode !== 'webhook') return '';
      if (providerId === 'feishu' || providerId === 'dingtalk') {
        const params = new URLSearchParams({ instanceId: String(instance.id || 'default') });
        return `/api/agent-channels/${providerId}/webhook?${params.toString()}`;
      }
      return '';
    },

    channelConversationStatusClass(conversation) {
      if (conversation?.pairingStatus === 'pending') return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
      if (conversation?.activeRuntimeSessionId) return 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30';
      return 'bg-space-800 text-gray-300 border-space-border/40';
    },

    channelConversationCardClass(conversation) {
      const isSelected = conversation?.id && conversation.id === this.selectedChannelConversationId;
      return isSelected
        ? 'border-neon-cyan/40 bg-neon-cyan/10'
        : 'border-space-border/30 bg-space-900/40 hover:bg-space-800/50';
    },

    channelConversationStateValue(conversation) {
      return conversation?.state || 'idle';
    },

    channelConversationStateLabel(conversation) {
      const state = this.channelConversationStateValue(conversation);
      if (state === 'pending') return this.t('channelConversationPending');
      if (state === 'waiting_approval') return this.t('agentRuntimeStatusWaitingApproval');
      if (state === 'waiting_user') return this.t('agentRuntimeStatusWaitingUser');
      if (state === 'active') return this.t('activeStatus');
      if (state === 'failed') return this.t('failedLabel');
      if (state === 'completed') return this.t('agentRuntimeStatusReady');
      return this.t('idleStatus');
    },

    channelConversationStatePillClass(conversation) {
      const state = this.channelConversationStateValue(conversation);
      if (state === 'pending') return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
      if (state === 'waiting_approval') return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400';
      if (state === 'waiting_user') return 'border-blue-500/30 bg-blue-500/10 text-blue-400';
      if (state === 'active') return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
      if (state === 'failed') return 'border-red-500/30 bg-red-500/10 text-red-300';
      if (state === 'completed') return 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan';
      return 'border-space-border/40 bg-space-900/70 text-gray-400';
    },

    channelMessageRoleLabel(record) {
      return record?.direction === 'inbound'
        ? this.t('you')
        : this.t('assistant');
    },

    channelMessageBubbleClass(record) {
      if (record?.direction === 'inbound') return 'bg-neon-cyan/15 border-neon-cyan/30 text-white';
      if (record?.status === 'failed') return 'bg-red-500/10 border-red-500/30 text-red-200';
      return 'bg-space-800/70 border-space-border/40 text-gray-100';
    },

    channelMessageText(record) {
      if (!record) return '';
      const payload = record.payload || {};
      if (record.direction === 'inbound') {
        return payload.text || '';
      }
      return payload.fullText || payload.text || payload.summary || '';
    },

    channelMessageMeta(record) {
      if (!record) return '';
      const payload = record.payload || {};
      if (record.direction === 'inbound') {
        return payload.externalUserName || payload.externalUserId || '';
      }
      return record.status === 'failed'
        ? (record.error || this.t('channelStatusError'))
        : '';
    },

    channelConversationPreview(conversation) {
      if (!conversation?.lastMessagePreview) return '';
      const prefix = conversation.lastMessageDirection === 'inbound' ? `${this.t('you')}: ` : `${this.t('assistant')}: `;
      return `${prefix}${conversation.lastMessagePreview}`;
    },

    resolveChannelConversationActionId(conversation) {
      return conversation?.conversationId || conversation?.id || '';
    },

    async loadChannelProviders() {
      this.channelProvidersLoading = true;
      const { ok, data } = await this.api('/api/agent-channels/providers');
      if (ok && Array.isArray(data?.providers)) {
        this.channelProviders = data.providers;
      }
      this.channelProvidersLoading = false;
    },

    async loadChannelCatalog() {
      const { ok, data } = await this.api('/api/agent-channels/catalog');
      if (ok && Array.isArray(data?.providers)) {
        this.channelCatalog = data.providers;
        for (const provider of this.channelCatalog) {
          this.ensureChannelProviderState(provider);
        }
      }
    },

    async loadChannelSettings() {
      const { ok, data } = await this.api('/api/agent-channels/settings');
      if (!ok || !data?.channels) return;

      const next = {};
      for (const [channelId, value] of Object.entries(data.channels || {})) {
        next[channelId] = {
          instances: Array.isArray(value?.instances)
            ? value.instances.map((instance) => ({ ...instance }))
            : []
        };
      }
      this.channelSettings = next;
      this.channelSettingsSaving = {};
      for (const provider of this.channelCatalog) {
        this.ensureChannelProviderState(provider);
      }
    },

    async loadChannelConversations(options = {}) {
      if (!options.silent) {
        this.channelConversationsLoading = true;
      }
      const { ok, data } = await this.api('/api/agent-channels/session-records?limit=80');
      if (ok && Array.isArray(data?.records)) {
        this.channelConversations = data.records;
        if (!this.selectedChannelConversationId && this.channelConversations.length > 0) {
          this.selectedChannelConversationId = this.channelConversations[0].id;
        }
        if (this.selectedChannelConversationId) {
          const selected = this.channelConversations.find((item) => item.id === this.selectedChannelConversationId) || null;
          if (selected) {
            this.selectedChannelConversation = {
              ...(this.selectedChannelConversation || {}),
              ...selected
            };
          } else if (this.channelConversations.length > 0) {
            this.selectedChannelConversationId = this.channelConversations[0].id;
            this.selectedChannelConversation = this.channelConversations[0];
          } else {
            this.selectedChannelConversationId = '';
            this.selectedChannelConversation = null;
            this.channelConversationMessages = [];
          }
        }
      }
      if (!options.silent) {
        this.channelConversationsLoading = false;
      }
    },

    async selectChannelConversation(conversationId) {
      if (!conversationId) return;
      this.selectedChannelConversationId = conversationId;
      await this.loadChannelConversationDetail(conversationId);
    },

    async loadChannelConversationDetail(conversationId = this.selectedChannelConversationId, options = {}) {
      if (!conversationId) return;
      if (!options.silent) {
        this.channelConversationLoading = true;
      }
      const { ok, data } = await this.api(`/api/agent-channels/session-records/${encodeURIComponent(conversationId)}`);
      if (ok && data?.session) {
        this.selectedChannelConversation = {
          ...(data.conversation || {}),
          ...(data.session || {}),
          conversationId: data.conversation?.id || data.session?.conversationId || ''
        };
        this.channelConversationMessages = Array.isArray(data.deliveries) ? data.deliveries : [];
      }
      if (!options.silent) {
        this.channelConversationLoading = false;
      }
    },

    async refreshChannels() {
      this.channelProvidersLoading = true;
      const { ok, data } = await this.api('/api/agent-channels/refresh', {
        method: 'POST'
      });
      if (ok && Array.isArray(data?.providers)) {
        this.channelProviders = data.providers;
        this.showToast(this.t('channelRefreshSuccess'), 'success');
      } else {
        this.showToast(data?.error || this.t('channelRefreshFailed'), 'error');
      }
      this.channelProvidersLoading = false;
    },

    async addChannelInstance(provider) {
      if (!provider?.id) return;
      const payload = this.buildDefaultChannelInstance(provider, {
        id: `${provider.id}-${Date.now().toString(36).slice(-4)}`,
        label: `Instance ${(this.channelProviderInstances(provider).length || 0) + 1}`,
        enabled: false
      });
      const { ok, data } = await this.api(`/api/agent-channels/settings/${encodeURIComponent(provider.id)}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (ok && data?.instance) {
        this.ensureChannelProviderState(provider);
        this.channelSettings[provider.id].instances.push({ ...data.instance });
        this.showToast(this.t('channelSettingsSaved', provider.id), 'success');
        await this.loadChannelProviders();
      } else {
        this.showToast(data?.error || this.t('requestFailed'), 'error');
      }
    },

    async removeChannelInstance(provider, instance) {
      if (!provider?.id || !instance?.id) return;
      const { ok, data } = await this.api(`/api/agent-channels/settings/${encodeURIComponent(provider.id)}/${encodeURIComponent(instance.id)}`, {
        method: 'DELETE'
      });

      if (ok) {
        this.channelSettings[provider.id] = {
          instances: Array.isArray(data?.channel?.instances)
            ? data.channel.instances.map((entry) => ({ ...entry }))
            : this.channelProviderInstances(provider).filter((entry) => entry.id !== instance.id)
        };
        this.showToast(this.t('channelSettingsSaved', provider.id), 'success');
        await this.loadChannelProviders();
      } else {
        this.showToast(data?.error || this.t('requestFailed'), 'error');
      }
    },

    async saveChannelSettings(channelId, instanceId) {
      if (!channelId || !instanceId) return;
      const providerState = this.channelSettings[channelId];
      if (!providerState || !Array.isArray(providerState.instances)) return;
      const target = providerState.instances.find((instance) => String(instance.id || '') === String(instanceId));
      if (!target) return;
      const saveKey = `${channelId}:${instanceId}`;
      this.channelSettingsSaving[saveKey] = true;
      try {
        const payload = { ...target };
        const { ok, data, error } = await this.api(`/api/agent-channels/settings/${encodeURIComponent(channelId)}/${encodeURIComponent(instanceId)}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });

        if (ok && data?.instance) {
          const index = providerState.instances.findIndex((instance) => String(instance.id || '') === String(instanceId));
          if (index >= 0) {
            providerState.instances.splice(index, 1, {
              ...providerState.instances[index],
              ...data.instance
            });
          }
          await this.loadChannelProviders();
          this.showToast(this.t('channelSettingsSaved', channelId), 'success');
        } else {
          this.showToast(data?.error || error || this.t('channelSettingsSaveFailed', channelId), 'error');
        }
      } finally {
        this.channelSettingsSaving[saveKey] = false;
      }
    },

    async approveChannelPairing(conversation) {
      const targetId = this.resolveChannelConversationActionId(conversation);
      if (!targetId || !conversation?.channel) return;
      const { ok, data } = await this.api(`/api/agent-channels/pairing/${encodeURIComponent(conversation.channel)}/${encodeURIComponent(targetId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approvedBy: 'dashboard' })
      });
      if (ok && data?.success) {
        this.showToast(this.t('channelPairingApproved'), 'success');
        this.loadChannelConversations();
        if (conversation?.id === this.selectedChannelConversationId) {
          this.loadChannelConversationDetail(conversation.id);
        }
      } else {
        this.showToast(data?.error || this.t('requestFailed'), 'error');
      }
    },

    async denyChannelPairing(conversation) {
      const targetId = this.resolveChannelConversationActionId(conversation);
      if (!targetId || !conversation?.channel) return;
      const { ok, data } = await this.api(`/api/agent-channels/pairing/${encodeURIComponent(conversation.channel)}/${encodeURIComponent(targetId)}/deny`, {
        method: 'POST',
        body: JSON.stringify({ approvedBy: 'dashboard' })
      });
      if (ok && data?.success) {
        this.showToast(this.t('channelPairingDenied'), 'success');
        this.loadChannelConversations();
        if (conversation?.id === this.selectedChannelConversationId) {
          this.loadChannelConversationDetail(conversation.id);
        }
      } else {
        this.showToast(data?.error || this.t('requestFailed'), 'error');
      }
    },

    async resetChannelConversation(conversation) {
      const targetId = this.resolveChannelConversationActionId(conversation);
      if (!targetId) return;
      const { ok, data } = await this.api(`/api/agent-channels/conversations/${encodeURIComponent(targetId)}/reset`, {
        method: 'POST'
      });
      if (ok && data?.success) {
        this.showToast(this.t('channelConversationReset'), 'success');
        this.loadChannelConversations();
        if (conversation?.id === this.selectedChannelConversationId) {
          this.loadChannelConversationDetail(conversation.id);
        }
      } else {
        this.showToast(data?.error || this.t('requestFailed'), 'error');
      }
    }
  };
}
