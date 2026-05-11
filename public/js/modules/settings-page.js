import { i18n } from '../i18n.js';

export function createSettingsPageModule() {
  return {
    haikuKiloModel: 'minimax/minimax-m2.5:free',
    accountStrategy: 'sequential',
    haikuModelSaving: false,
    strategySaving: false,
    routingPriority: 'account-first',
    routingSaving: false,
    routingMode: 'automatic',
    routingModeSaving: false,
    appRouting: {},
    appRoutingDraft: {},
    appRoutingTargets: { appIds: [], bindingTypes: [], chatgptAccounts: [], claudeAccounts: [], antigravityAccounts: [], apiKeys: [], localModels: [] },
    appRoutingSaving: {},
    selectedAppRoutingId: '',
    appRoutingForm: { enabled: true, fallbackToDefault: true, bindings: [], currentType: null, currentTargetIds: [], targetQuery: '', targetPickerOpen: false },
    enableFreeModels: true,
    freeModelsSaving: false,
    assistantAgentConfig: {
      enabled: false,
      bindingConfigured: false,
      boundModelSource: null,
      boundCredential: null,
      fallbacks: [],
      circuitBreaker: { failureThreshold: 3, probeIntervalMs: 300000 },
      sources: {
        chatgptAccount: false,
        claudeAccount: false,
        anthropicApiKey: true,
        openaiApiKeyBridge: true,
        azureOpenaiApiKeyBridge: true
      }
    },
    assistantAgentStatus: {
      enabled: false,
      bindingConfigured: false,
      boundModelSource: null,
      boundCredential: null,
      fallbacks: [],
      circuitBreaker: { failureThreshold: 3, probeIntervalMs: 300000 },
      tiers: [],
      statuses: [],
      resolvedSource: null,
      fallbackReason: '',
      lastUsed: null,
      catalog: { apiKeys: { anthropic: [], openai: [], 'azure-openai': [] }, claudeAccounts: [], chatgptAccounts: [] }
    },
    assistantAgentSaving: false,
    assistantAgentTestResult: null,
    localModelRoutingEnabled: false,
    localModelRoutingSaving: false,
    localRuntime: null,
    localRuntimes: [],
    localRuntimeHealth: null,
    localRuntimeModels: [],
    localRuntimeStatusLoading: false,
    localRuntimeSaving: false,
    localRuntimeChecking: false,
    localRuntimeModelsLoading: false,
    modelMappingData: null,
    modelMappingProviders: [],
    modelMappingSaving: false,
    testMappingInput: '',
    testMappingResult: null,
    testMappingResults: {},
    kiloModels: [],
    kiloModelsLoading: false,
    haikuTestPrompt: 'Say hello',
    haikuTestResponse: '',
    haikuTesting: false,

    haikuModelLabel() {
      const model = this.kiloModels.find((m) => m.id === this.haikuKiloModel);
      return model ? model.name : this.haikuKiloModel;
    },

    async testHaikuChat() {
      if (!this.haikuTestPrompt.trim()) return;
      this.haikuTesting = true;
      this.haikuTestResponse = '';
      const { ok, data } = await this.api('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'claude-haiku-4',
          messages: [{ role: 'user', content: this.haikuTestPrompt }]
        })
      });
      this.haikuTesting = false;
      if (ok && data.choices) {
        this.haikuTestResponse = data.choices[0].message.content;
      } else {
        this.haikuTestResponse = data?.error?.message || this.t('requestFailed');
      }
    },

    async loadHaikuModelSetting() {
      const { ok, data } = await this.api('/settings/haiku-model');
      if (ok && data?.haikuKiloModel) {
        this.haikuKiloModel = data.haikuKiloModel;
      }
    },

    async loadKiloModels() {
      this.kiloModelsLoading = true;
      const { ok, data } = await this.api('/settings/kilo-models');
      if (ok && data?.models) {
        this.kiloModels = data.models;
        if (data.current) {
          this.haikuKiloModel = data.current;
        }
      }
      this.kiloModelsLoading = false;
    },

    async setHaikuModel(model) {
      if (this.haikuModelSaving || this.haikuKiloModel === model) return;
      this.haikuModelSaving = true;
      const { ok, data } = await this.api('/settings/haiku-model', {
        method: 'POST',
        body: JSON.stringify({ haikuKiloModel: model })
      });
      this.haikuModelSaving = false;
      if (ok && data?.haikuKiloModel) {
        this.haikuKiloModel = data.haikuKiloModel;
        const dict = i18n[this.lang] || i18n.en;
        this.showToast(dict.haikuRoutedTo(data.haikuKiloModel.toUpperCase()), 'success');
      } else {
        this.showToast(data?.error || this.t('failedUpdateHaiku'), 'error');
      }
    },

    async loadAccountStrategySetting() {
      const { ok, data } = await this.api('/settings/account-strategy');
      if (ok && data?.accountStrategy) {
        this.accountStrategy = data.accountStrategy;
      }
    },

    async setAccountStrategy(strategy) {
      if (this.strategySaving || this.accountStrategy === strategy) return;
      this.strategySaving = true;
      const { ok, data } = await this.api('/settings/account-strategy', {
        method: 'POST',
        body: JSON.stringify({ accountStrategy: strategy })
      });
      this.strategySaving = false;
      if (ok && data?.accountStrategy) {
        this.accountStrategy = data.accountStrategy;
        const dict = i18n[this.lang] || i18n.en;
        this.showToast(dict.strategySetTo(data.accountStrategy), 'success');
      } else {
        this.showToast(data?.error || this.t('failedUpdateStrategy'), 'error');
      }
    },

    async loadRoutingPrioritySetting() {
      const { ok, data } = await this.api('/settings/routing-priority');
      if (ok && data?.routingPriority) {
        this.routingPriority = data.routingPriority;
      }
    },

    async setRoutingPriority(priority) {
      if (this.routingSaving || this.routingPriority === priority) return;
      this.routingSaving = true;
      const { ok, data } = await this.api('/settings/routing-priority', {
        method: 'POST',
        body: JSON.stringify({ routingPriority: priority })
      });
      this.routingSaving = false;
      if (ok && data?.routingPriority) {
        this.routingPriority = data.routingPriority;
        this.showToast(this.t('routingUpdated'), 'success');
      } else {
        this.showToast(data?.error || this.t('routingUpdateFailed'), 'error');
      }
    },

    async loadRoutingModeSetting() {
      const { ok, data } = await this.api('/settings/routing-mode');
      if (ok && data?.routingMode) {
        this.routingMode = data.routingMode;
      }
    },

    async setRoutingMode(mode) {
      if (this.routingModeSaving || this.routingMode === mode) return;
      this.routingModeSaving = true;
      const { ok, data } = await this.api('/settings/routing-mode', {
        method: 'POST',
        body: JSON.stringify({ routingMode: mode })
      });
      this.routingModeSaving = false;
      if (ok && data?.routingMode) {
        this.routingMode = data.routingMode;
        this.showToast(this.t('routingModeUpdated'), 'success');
      } else {
        this.showToast(data?.error || this.t('routingModeUpdateFailed'), 'error');
      }
    },

    async loadAppRoutingSettings() {
      const { ok, data } = await this.api('/settings/app-routing');
      if (ok && data) {
        this.appRouting = data.appRouting || {};
        this.appRoutingDraft = JSON.parse(JSON.stringify(this.appRouting));
        this.appRoutingTargets = data.targets || this.appRoutingTargets;
        if (data.routingMode) this.routingMode = data.routingMode;
        if (!this.selectedAppRoutingId && this.appRoutingTargets.appIds?.length) {
          this.selectedAppRoutingId = this.appRoutingTargets.appIds[0];
        }
        this.loadAppRoutingForm(this.selectedAppRoutingId);
      }
    },

    createEmptyAppRoutingForm() {
      return {
        enabled: false,
        fallbackToDefault: true,
        bindings: [],
        currentType: null,
        currentTargetIds: [],
        targetQuery: '',
        targetPickerOpen: false
      };
    },

    flattenAppRoutingBindings(bindings = []) {
      const flattened = [];
      for (const [index, binding] of (bindings || []).entries()) {
        const targetIds = Array.isArray(binding?.targetIds) && binding.targetIds.length > 0
          ? binding.targetIds.filter(Boolean)
          : (binding?.targetId ? [binding.targetId] : []);
        if (targetIds.length === 0) {
          flattened.push({
            id: binding.id || ('binding-' + (index + 1)),
            type: binding.type || null,
            targetIds: [],
            targetId: null
          });
          continue;
        }
        for (const targetId of targetIds) {
          flattened.push({
            id: `${binding.id || ('binding-' + (index + 1))}-${targetId}`,
            type: binding.type || null,
            targetIds: [targetId],
            targetId
          });
        }
      }
      return flattened;
    },

    loadAppRoutingForm(appId) {
      this.selectedAppRoutingId = appId || this.selectedAppRoutingId || '';
      const current = this.appRoutingDraft[this.selectedAppRoutingId];
      if (current) {
        this.appRoutingForm = {
          enabled: current.enabled === true,
          fallbackToDefault: current.fallbackToDefault !== false,
          bindings: this.flattenAppRoutingBindings(current.bindings || []),
          currentType: null,
          currentTargetIds: [],
          targetQuery: '',
          targetPickerOpen: false
        };
        return;
      }
      this.appRoutingForm = this.createEmptyAppRoutingForm();
    },

    getBindingOptions(bindingType) {
      if (bindingType === 'chatgpt-account') return this.appRoutingTargets.chatgptAccounts || [];
      if (bindingType === 'claude-account') return this.appRoutingTargets.claudeAccounts || [];
      if (bindingType === 'antigravity-account') return this.appRoutingTargets.antigravityAccounts || [];
      if (bindingType === 'api-key') return this.appRoutingTargets.apiKeys || [];
      if (bindingType === 'local-model') return this.appRoutingTargets.localModels || [];
      return [];
    },

    bindingOptionLabel(bindingType, option) {
      if (!option) return '';
      if (bindingType === 'api-key') return `${option.name} (${option.type})`;
      if (bindingType === 'local-model') return option.name || option.id;
      return option.displayName ? `${option.displayName} (${option.email})` : option.email;
    },

    appRoutingSummary(appId) {
      const config = this.appRouting[appId];
      if (!config?.enabled || !Array.isArray(config.bindings) || config.bindings.length === 0) return '';
      return config.bindings.map((binding) => {
        const labels = this.getBindingLabels(binding);
        const label = labels.join(', ');
        return `${binding.type}: ${label}`;
      }).join(' | ');
    },

    getBindingTargetIds(binding) {
      if (Array.isArray(binding?.targetIds) && binding.targetIds.length > 0) {
        return binding.targetIds.filter(Boolean);
      }
      return binding?.targetId ? [binding.targetId] : [];
    },

    getBindingLabels(binding) {
      const options = this.getBindingOptions(binding?.type);
      return this.getBindingTargetIds(binding).map((targetId) => {
        const option = options.find((item) => (item.id || item.email) === targetId);
        return option ? this.bindingOptionLabel(binding.type, option) : targetId;
      });
    },

    getFilteredBindingOptions(bindingType, query = '') {
      const keyword = String(query || '').trim().toLowerCase();
      const options = this.getBindingOptions(bindingType);
      if (!keyword) return options;
      return options.filter((option) => {
        const id = String(option.id || option.email || '').toLowerCase();
        const label = String(this.bindingOptionLabel(bindingType, option) || '').toLowerCase();
        return id.includes(keyword) || label.includes(keyword);
      });
    },

    getAppRoutingSelectionPreview(limit = 3) {
      const selectedIds = this.appRoutingForm.currentTargetIds || [];
      const options = this.getBindingOptions(this.appRoutingForm.currentType);
      const labels = selectedIds.map((targetId) => {
        const option = options.find((item) => (item.id || item.email) === targetId);
        return option ? this.bindingOptionLabel(this.appRoutingForm.currentType, option) : targetId;
      });
      return labels.slice(0, limit);
    },

    getSelectedAppRoutingTargets() {
      const selectedIds = this.appRoutingForm.currentTargetIds || [];
      const options = this.getBindingOptions(this.appRoutingForm.currentType);
      return selectedIds.map((targetId) => {
        const option = options.find((item) => (item.id || item.email) === targetId);
        return {
          id: targetId,
          label: option ? this.bindingOptionLabel(this.appRoutingForm.currentType, option) : targetId,
          meta: option ? (option.id || option.email || targetId) : targetId
        };
      });
    },

    isAppRoutingTargetSelected(targetId) {
      return (this.appRoutingForm.currentTargetIds || []).includes(targetId);
    },

    toggleAppRoutingTarget(targetId) {
      if (!targetId) return;
      const selected = new Set(this.appRoutingForm.currentTargetIds || []);
      if (selected.has(targetId)) selected.delete(targetId);
      else selected.add(targetId);
      this.updateAppRoutingFormField('currentTargetIds', Array.from(selected));
    },

    removeSelectedAppRoutingTarget(targetId) {
      if (!targetId) return;
      const selected = (this.appRoutingForm.currentTargetIds || []).filter((id) => id !== targetId);
      this.updateAppRoutingFormField('currentTargetIds', selected);
    },

    selectAllFilteredAppRoutingTargets() {
      const options = this.getFilteredBindingOptions(this.appRoutingForm.currentType, this.appRoutingForm.targetQuery);
      const selected = new Set(this.appRoutingForm.currentTargetIds || []);
      for (const option of options) {
        selected.add(option.id || option.email);
      }
      this.updateAppRoutingFormField('currentTargetIds', Array.from(selected));
    },

    clearAllAppRoutingTargets() {
      this.updateAppRoutingFormField('currentTargetIds', []);
    },

    toggleAppRoutingTargetPicker(force) {
      const targetPickerOpen = typeof force === 'boolean'
        ? force
        : !this.appRoutingForm.targetPickerOpen;
      this.appRoutingForm = {
        ...this.appRoutingForm,
        targetPickerOpen,
        targetQuery: targetPickerOpen ? this.appRoutingForm.targetQuery : ''
      };
    },

    areAllFilteredTargetsSelected() {
      const options = this.getFilteredBindingOptions(this.appRoutingForm.currentType, this.appRoutingForm.targetQuery);
      if (options.length === 0) return false;
      return options.every((option) => this.isAppRoutingTargetSelected(option.id || option.email));
    },

    updateAppRoutingFormField(field, value) {
      const patch = { [field]: value };
      if (field === 'currentType') {
        patch.currentTargetIds = [];
        patch.targetQuery = '';
        patch.targetPickerOpen = false;
      }
      this.appRoutingForm = { ...this.appRoutingForm, ...patch };
    },

    async updateAppRoutingToggle(field, value) {
      const appId = this.selectedAppRoutingId;
      if (!appId) return;
      const nextRouting = JSON.parse(JSON.stringify(this.appRoutingDraft || {}));
      const current = nextRouting[appId] || this.createEmptyAppRoutingForm();
      nextRouting[appId] = {
        enabled: field === 'enabled' ? value === true : current.enabled === true,
        fallbackToDefault: field === 'fallbackToDefault' ? value !== false : current.fallbackToDefault !== false,
        bindings: Array.isArray(current.bindings) ? current.bindings : []
      };
      this.appRoutingDraft = nextRouting;
      this.appRoutingForm = {
        ...this.appRoutingForm,
        [field]: field === 'enabled' ? value === true : value !== false
      };
      await this.saveAppRoutingConfig(appId, nextRouting);
    },

    async removeAppRoutingBinding(index) {
      const appId = this.selectedAppRoutingId;
      if (!appId) return;
      const bindings = [...(this.appRoutingForm.bindings || [])];
      if (!bindings[index]) return;
      bindings.splice(index, 1);
      const nextRouting = JSON.parse(JSON.stringify(this.appRoutingDraft || {}));
      nextRouting[appId] = {
        enabled: bindings.length > 0 ? this.appRoutingForm.enabled === true : false,
        fallbackToDefault: this.appRoutingForm.fallbackToDefault !== false,
        bindings
      };
      this.appRoutingDraft = nextRouting;
      this.appRoutingForm = { ...this.appRoutingForm, bindings };
      await this.saveAppRoutingConfig(appId, nextRouting);
    },

    async saveAppRoutingConfig(appId, nextRouting) {
      if (!appId || this.appRoutingSaving[appId]) return false;
      this.appRoutingSaving[appId] = true;
      const { ok, data } = await this.api('/settings/app-routing', {
        method: 'POST',
        body: JSON.stringify({ appRouting: nextRouting })
      });
      this.appRoutingSaving[appId] = false;
      if (ok && data?.appRouting) {
        this.appRouting = data.appRouting;
        this.appRoutingDraft = JSON.parse(JSON.stringify(data.appRouting));
        this.appRoutingTargets = data.targets || this.appRoutingTargets;
        this.loadAppRoutingForm(appId);
        this.showToast(this.t('appRoutingSaved'), 'success');
        return true;
      }
      this.showToast(data?.error || this.t('appRoutingSaveFailed'), 'error');
      await this.loadAppRoutingSettings();
      return false;
    },

    async moveAppRoutingBinding(index, direction) {
      const appId = this.selectedAppRoutingId;
      if (!appId) return;
      const bindings = [...(this.appRoutingForm.bindings || [])];
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= bindings.length) return;
      const item = bindings[index];
      bindings.splice(index, 1);
      bindings.splice(targetIndex, 0, item);
      this.appRoutingForm = { ...this.appRoutingForm, bindings };
      const nextRouting = JSON.parse(JSON.stringify(this.appRoutingDraft || {}));
      nextRouting[appId] = {
        enabled: this.appRoutingForm.enabled === true,
        fallbackToDefault: this.appRoutingForm.fallbackToDefault !== false,
        bindings
      };
      await this.saveAppRoutingConfig(appId, nextRouting);
    },

    async saveAppRouting() {
      const appId = this.selectedAppRoutingId;
      if (!appId || this.appRoutingSaving[appId]) return;
      const { currentType, currentTargetIds } = this.appRoutingForm;
      if (!currentType || !Array.isArray(currentTargetIds) || currentTargetIds.length === 0) return;
      const bindings = (this.appRoutingForm.bindings || []).map((b) => ({ ...b }));
      const normalizedTargetIds = [...new Set(currentTargetIds.filter(Boolean))];
      for (const targetId of normalizedTargetIds) {
        const existingIndex = bindings.findIndex((b) => b.type === currentType && this.getBindingTargetIds(b)[0] === targetId);
        if (existingIndex >= 0) {
          bindings[existingIndex] = {
            ...bindings[existingIndex],
            type: currentType,
            targetIds: [targetId],
            targetId
          };
          continue;
        }
        bindings.push({
          id: 'binding-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
          type: currentType,
          targetIds: [targetId],
          targetId
        });
      }
      const nextRouting = JSON.parse(JSON.stringify(this.appRoutingDraft || {}));
      const shouldEnable = bindings.length > 0 ? true : this.appRoutingForm.enabled === true;
      nextRouting[appId] = {
        enabled: shouldEnable,
        fallbackToDefault: this.appRoutingForm.fallbackToDefault !== false,
        bindings
      };
      this.appRoutingForm = {
        ...this.appRoutingForm,
        enabled: shouldEnable,
        bindings,
        currentTargetIds: [],
        targetQuery: '',
        targetPickerOpen: false
      };
      await this.saveAppRoutingConfig(appId, nextRouting);
    },

    async loadFreeModelsSetting() {
      const { ok, data } = await this.api('/settings/enable-free-models');
      if (ok && typeof data?.enableFreeModels === 'boolean') {
        this.enableFreeModels = data.enableFreeModels;
      }
    },

    async loadAssistantAgentConfig() {
      if (!this.modelMappingData) {
        await this.loadModelMappings();
      }
      const [statusResult, configResult] = await Promise.all([
        this.api('/api/assistant/agent-status'),
        this.api('/settings/assistant-agent')
      ]);

      if (statusResult.ok && statusResult.data?.status) {
        this.assistantAgentStatus = statusResult.data.status;
      }

      await new Promise((resolve) => setTimeout(resolve, 0));

      if (configResult.ok && configResult.data?.assistantAgent) {
        const cfg = configResult.data.assistantAgent;
        this.assistantAgentConfig = {
          enabled: cfg.enabled === true,
          bindingConfigured: cfg.bindingConfigured === true,
          boundModelSource: cfg.boundModelSource || cfg.boundCredential || null,
          boundCredential: cfg.boundModelSource || cfg.boundCredential || null,
          fallbacks: Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [],
          circuitBreaker: cfg.circuitBreaker || { failureThreshold: 3, probeIntervalMs: 300000 },
          sources: {
            chatgptAccount: cfg.sources?.chatgptAccount === true,
            claudeAccount: cfg.sources?.claudeAccount === true,
            anthropicApiKey: cfg.sources?.anthropicApiKey !== false,
            openaiApiKeyBridge: cfg.sources?.openaiApiKeyBridge !== false,
            azureOpenaiApiKeyBridge: cfg.sources?.azureOpenaiApiKeyBridge !== false
          }
        };
      }
    },

    async loadAssistantAgentStatus() {
      const { ok, data } = await this.api('/api/assistant/agent-status');
      if (ok && data?.status) {
        this.assistantAgentStatus = data.status;
      }
    },

    get assistantAgentCredentialOptions() {
      const cat = this.assistantAgentStatus?.catalog || {};
      const out = [];
      const providerLabels = {
        anthropic: this.t('assistantAgentGroupAnthropicKey'),
        openai: this.t('assistantAgentGroupOpenAiBridge'),
        'azure-openai': this.t('assistantAgentGroupAzureBridge'),
        gemini: this.t('assistantAgentGroupGeminiKey'),
        'vertex-ai': this.t('assistantAgentGroupVertexAiKey'),
        deepseek: this.t('assistantAgentGroupDeepseekKey')
      };
      const apiKeyGroups = Object.entries(cat.apiKeys || {}).map(([providerType, entries]) => ({
        key: `apiKeys-${providerType}`,
        label: providerLabels[providerType] || `${providerType} API Keys`,
        entries: Array.isArray(entries) ? entries : []
      }));
      const groups = [
        ...apiKeyGroups,
        { key: 'claudeAccounts', label: this.t('assistantAgentGroupClaudeAccount'), entries: cat.claudeAccounts || [] },
        { key: 'chatgptAccounts', label: this.t('assistantAgentGroupChatgptAccount'), entries: cat.chatgptAccounts || [] }
      ];
      for (const group of groups) {
        if (!group.entries.length) continue;
        out.push({ group: group.label, entries: group.entries.map((entry) => ({
          value: `${entry.type}::${entry.id}`,
          label: entry.label,
          available: entry.available !== false,
          detail: entry.detail || '',
          providerType: entry.providerType || '',
          models: Array.isArray(entry.models) ? entry.models : [],
          descriptor: { type: entry.type, id: entry.id }
        })) });
      }
      return out;
    },

    descriptorToValue(descriptor) {
      return descriptor && descriptor.type && descriptor.id ? `${descriptor.type}::${descriptor.id}` : '';
    },

    valueToDescriptor(value) {
      if (!value || typeof value !== 'string') return null;
      const idx = value.indexOf('::');
      if (idx <= 0) return null;
      return { type: value.slice(0, idx), id: value.slice(idx + 2) };
    },

    labelForDescriptor(descriptor) {
      if (!descriptor) return this.t('assistantAgentNoBinding');
      const flat = this.assistantAgentCredentialOptions.flatMap((g) => g.entries.map((e) => ({ group: g.group, ...e })));
      const target = `${descriptor.type}::${descriptor.id}`;
      const match = flat.find((entry) => entry.value === target);
      const model = descriptor.model ? ` / ${descriptor.model}` : '';
      return match ? `${match.group} · ${match.label}${model}` : `${descriptor.type} · ${descriptor.id}${model}`;
    },

    assistantProviderModelsForDescriptor(descriptor) {
      if (!descriptor?.type || !descriptor?.id) return [];
      const flat = this.assistantAgentCredentialOptions.flatMap((g) => g.entries);
      const match = flat.find((entry) => entry.value === `${descriptor.type}::${descriptor.id}`);
      const sourceModels = Array.isArray(match?.models) ? match.models.filter(Boolean) : [];
      if (sourceModels.length > 0) {
        const merged = [...sourceModels];
        if (descriptor.model && !merged.includes(descriptor.model)) {
          merged.unshift(descriptor.model);
        }
        return merged;
      }
      const providerType = String(match?.providerType || '').trim();
      return this.providerModelsForType(providerType, descriptor.model || '');
    },

    cloneDescriptorWithModel(descriptor, model) {
      if (!descriptor) return null;
      const normalizedModel = typeof model === 'string' ? model.trim() : '';
      return normalizedModel
        ? { ...descriptor, model: normalizedModel }
        : { type: descriptor.type, id: descriptor.id };
    },

    async submitAssistantBinding(patch, { suppressToast = false } = {}) {
      if (this.assistantAgentSaving) return;
      this.assistantAgentSaving = true;
      const { ok, data } = await this.api('/api/assistant/agent-binding', {
        method: 'POST',
        body: JSON.stringify(patch)
      });
      this.assistantAgentSaving = false;
      if (ok && data?.assistantAgent) {
        const cfg = data.assistantAgent;
        this.assistantAgentConfig = {
          ...this.assistantAgentConfig,
          enabled: cfg.enabled === true,
          bindingConfigured: cfg.bindingConfigured === true,
          boundModelSource: cfg.boundModelSource || cfg.boundCredential || null,
          boundCredential: cfg.boundModelSource || cfg.boundCredential || null,
          fallbacks: Array.isArray(cfg.fallbacks) ? cfg.fallbacks : [],
          circuitBreaker: cfg.circuitBreaker || this.assistantAgentConfig.circuitBreaker
        };
        await this.loadAssistantAgentStatus();
        if (!suppressToast) this.showToast(this.t('assistantAgentUpdated'), 'success');
        return true;
      }
      this.showToast(data?.error || this.t('assistantAgentUpdateFailed'), 'error');
      return false;
    },

    async toggleAssistantAgentEnabled() {
      await this.submitAssistantBinding({ enabled: !this.assistantAgentConfig.enabled });
    },

    async setAssistantPrimary(value) {
      const current = this.assistantAgentConfig.boundModelSource;
      const next = this.valueToDescriptor(value);
      const currentModel = current && next && current.type === next.type && current.id === next.id
        ? (current.model || '')
        : '';
      const descriptor = value === '' ? null : this.cloneDescriptorWithModel(next, currentModel);
      await this.submitAssistantBinding({ boundModelSource: descriptor });
    },

    async setAssistantPrimaryModel(model) {
      const descriptor = this.cloneDescriptorWithModel(this.assistantAgentConfig.boundModelSource, model);
      await this.submitAssistantBinding({ boundModelSource: descriptor });
    },

    async setAssistantFallback(index, value) {
      const fallbacks = [...(this.assistantAgentConfig.fallbacks || [])];
      const current = fallbacks[index] || null;
      const next = this.valueToDescriptor(value);
      const preservedModel = current && next && current.type === next.type && current.id === next.id
        ? (current.model || '')
        : '';
      const descriptor = this.cloneDescriptorWithModel(next, preservedModel);
      if (!descriptor) return;
      fallbacks[index] = descriptor;
      await this.submitAssistantBinding({ fallbacks });
    },

    async setAssistantFallbackModel(index, model) {
      const fallbacks = [...(this.assistantAgentConfig.fallbacks || [])];
      const descriptor = this.cloneDescriptorWithModel(fallbacks[index], model);
      if (!descriptor) return;
      fallbacks[index] = descriptor;
      await this.submitAssistantBinding({ fallbacks });
    },

    async addAssistantFallback(value) {
      const descriptor = this.cloneDescriptorWithModel(this.valueToDescriptor(value), '');
      if (!descriptor) return;
      const fallbacks = [...(this.assistantAgentConfig.fallbacks || []), descriptor];
      await this.submitAssistantBinding({ fallbacks });
    },

    async removeAssistantFallback(index) {
      const fallbacks = [...(this.assistantAgentConfig.fallbacks || [])];
      fallbacks.splice(index, 1);
      await this.submitAssistantBinding({ fallbacks });
    },

    async moveAssistantFallback(index, direction) {
      const fallbacks = [...(this.assistantAgentConfig.fallbacks || [])];
      const target = index + direction;
      if (target < 0 || target >= fallbacks.length) return;
      [fallbacks[index], fallbacks[target]] = [fallbacks[target], fallbacks[index]];
      await this.submitAssistantBinding({ fallbacks });
    },

    async saveAssistantCircuitBreaker() {
      const cb = this.assistantAgentConfig.circuitBreaker || {};
      await this.submitAssistantBinding({
        circuitBreaker: {
          failureThreshold: Number(cb.failureThreshold) || 3,
          probeIntervalMs: Number(cb.probeIntervalMs) || 300000
        }
      });
    },

    async testAssistantBinding(descriptor) {
      this.assistantAgentTestResult = { pending: true };
      const { ok, data } = await this.api('/api/assistant/agent-binding/test', {
        method: 'POST',
        body: JSON.stringify(descriptor || {})
      });
      this.assistantAgentTestResult = ok ? data : { ok: false, reason: data?.error || 'request failed' };
    },

    async resetAssistantBreaker(descriptor) {
      const body = descriptor ? { descriptor } : {};
      const { ok, data } = await this.api('/api/assistant/agent-binding/breaker/reset', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (ok) {
        await this.loadAssistantAgentStatus();
        this.showToast(this.t('assistantAgentBreakerReset'), 'success');
      } else {
        this.showToast(data?.error || this.t('assistantAgentUpdateFailed'), 'error');
      }
    },

    async toggleFreeModels() {
      if (this.freeModelsSaving) return;
      this.freeModelsSaving = true;
      const newValue = !this.enableFreeModels;
      const { ok, data } = await this.api('/settings/enable-free-models', {
        method: 'POST',
        body: JSON.stringify({ enableFreeModels: newValue })
      });
      this.freeModelsSaving = false;
      if (ok && typeof data?.enableFreeModels === 'boolean') {
        this.enableFreeModels = data.enableFreeModels;
        this.showToast(this.t('freeModelsUpdated'), 'success');
      } else {
        this.showToast(data?.error || this.t('freeModelsUpdateFailed'), 'error');
      }
    },

    async loadLocalModelRoutingSetting() {
      const { ok, data } = await this.api('/settings/local-model-routing-enabled');
      if (ok && typeof data?.localModelRoutingEnabled === 'boolean') {
        this.localModelRoutingEnabled = data.localModelRoutingEnabled;
      }
    },

    async toggleLocalModelRouting() {
      if (this.localModelRoutingSaving) return;
      this.localModelRoutingSaving = true;
      const newValue = !this.localModelRoutingEnabled;
      const { ok, data } = await this.api('/settings/local-model-routing-enabled', {
        method: 'POST',
        body: JSON.stringify({ localModelRoutingEnabled: newValue })
      });
      this.localModelRoutingSaving = false;
      if (ok && typeof data?.localModelRoutingEnabled === 'boolean') {
        this.localModelRoutingEnabled = data.localModelRoutingEnabled;
        this.showToast(this.t('localModelRoutingUpdated'), 'success');
      } else {
        this.showToast(data?.error || this.t('localModelRoutingUpdateFailed'), 'error');
      }
    },

    applyLocalRuntimePayload(data) {
      if (!data || typeof data !== 'object') return;
      if (typeof data.enabled === 'boolean') {
        this.localModelRoutingEnabled = data.enabled;
      }
      this.localRuntime = data.runtime || null;
      this.localRuntimes = Array.isArray(data.runtimes) ? data.runtimes : [];
      if (Object.prototype.hasOwnProperty.call(data, 'health')) {
        this.localRuntimeHealth = data.health || null;
      }
      if (Array.isArray(data.models)) {
        this.localRuntimeModels = data.models;
      }
      if (data.targets && typeof data.targets === 'object') {
        this.appRoutingTargets = {
          ...this.appRoutingTargets,
          ...data.targets
        };
      }
    },

    localRuntimeStatusLabel() {
      if (!this.localRuntimeHealth) return this.t('localRuntimeStatusUnknown');
      return this.localRuntimeHealth.ok
        ? this.t('localRuntimeStatusHealthy')
        : this.t('localRuntimeStatusUnreachable');
    },

    localRuntimeStatusClass() {
      if (!this.localRuntimeHealth) return 'text-gray-400';
      return this.localRuntimeHealth.ok ? 'text-neon-green' : 'text-red-400';
    },

    localRuntimeUpdatedAtLabel() {
      if (!this.localRuntime?.updatedAt) return this.t('notSet');
      const date = new Date(this.localRuntime.updatedAt);
      if (Number.isNaN(date.getTime())) return this.localRuntime.updatedAt;
      return date.toLocaleString();
    },

    async loadLocalRuntimeStatus() {
      this.localRuntimeStatusLoading = true;
      const { ok, data } = await this.api('/api/local-runtimes');
      this.localRuntimeStatusLoading = false;
      if (ok && data) {
        this.applyLocalRuntimePayload(data);
      }
    },

    async saveLocalRuntimeConfig() {
      if (this.localRuntimeSaving || !this.localRuntime) return;
      this.localRuntimeSaving = true;
      const payload = {
        name: this.localRuntime.name,
        baseUrl: this.localRuntime.baseUrl,
        enabled: this.localRuntime.enabled !== false,
        defaultModels: this.localRuntime.defaultModels || {}
      };
      const { ok, data } = await this.api('/api/local-runtimes/ollama-local', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      this.localRuntimeSaving = false;
      if (ok && data) {
        this.applyLocalRuntimePayload(data);
        this.showToast(this.t('localRuntimeSaved'), 'success');
      } else {
        this.showToast(data?.error || this.t('localRuntimeSaveFailed'), 'error');
      }
    },

    updateLocalRuntimeField(field, value) {
      if (!this.localRuntime) return;
      this.localRuntime = {
        ...this.localRuntime,
        [field]: value
      };
    },

    updateLocalRuntimeDefaultModel(appId, value) {
      if (!this.localRuntime) return;
      this.localRuntime = {
        ...this.localRuntime,
        defaultModels: {
          ...(this.localRuntime.defaultModels || {}),
          [appId]: value
        }
      };
    },

    async checkLocalRuntimeHealth() {
      if (this.localRuntimeChecking) return;
      this.localRuntimeChecking = true;
      const { ok, data } = await this.api('/api/local-runtimes/check', { method: 'POST' });
      this.localRuntimeChecking = false;
      if (ok && data) {
        this.applyLocalRuntimePayload(data);
        this.showToast(this.t('localRuntimeCheckFinished'), data.health?.ok ? 'success' : 'error');
      } else {
        this.showToast(data?.error || this.t('localRuntimeCheckFailed'), 'error');
      }
    },

    async refreshLocalRuntimeModels() {
      if (this.localRuntimeModelsLoading) return;
      this.localRuntimeModelsLoading = true;
      const { ok, data } = await this.api('/api/local-runtimes/refresh-models', { method: 'POST' });
      this.localRuntimeModelsLoading = false;
      if (ok && data) {
        this.applyLocalRuntimePayload(data);
        await this.loadAppRoutingSettings();
        this.showToast(this.t('localRuntimeModelsRefreshed'), 'success');
      } else {
        this.showToast(data?.error || this.t('localRuntimeModelsRefreshFailed'), 'error');
      }
    },

    normalizeModelMappingProvider(type) {
      switch (type) {
        case 'openai':
        case 'moonshot':
        case 'minimax':
        case 'zhipu':
          return 'openai';
        case 'anthropic':
          return 'anthropic';
        case 'gemini':
          return 'gemini';
        case 'vertex-ai':
          return 'vertex-ai';
        case 'deepseek':
          return 'deepseek';
        default:
          return type || null;
      }
    },

    providerModelsForType(providerType, currentModel = '') {
      const normalizedProvider = this.normalizeModelMappingProvider(providerType || '');
      const providerModels = this.modelMappingData?.providerModels || {};
      const discoveredModels = this.modelMappingData?.discovered?.providers?.[normalizedProvider]?.models || [];
      const discoveredIds = Array.isArray(discoveredModels)
        ? discoveredModels.map((entry) => entry?.id || entry).filter(Boolean)
        : [];
      const staticIds = Array.isArray(providerModels[normalizedProvider]) ? providerModels[normalizedProvider] : [];
      let merged = [...new Set([...discoveredIds, ...staticIds])];

      if (merged.length === 0 && normalizedProvider) {
        merged = this.chatModels.filter((modelId) => {
          const inferred = this.inferProviderTypeForModel(modelId);
          if (normalizedProvider === 'azure-openai') return inferred === 'openai';
          return inferred === normalizedProvider;
        });
      }

      if (!normalizedProvider) {
        merged = [...this.chatModels];
      }

      if (currentModel && !merged.includes(currentModel)) {
        merged.unshift(currentModel);
      }

      return merged;
    },

    async loadModelMappings() {
      const { ok, data } = await this.api('/api/model-mappings');
      if (ok && data) {
        this.modelMappingData = data;
        const allProviders = Object.keys(data.providers || {});
        const configuredTypes = new Set();

        try {
          const keysResp = await this.api('/api/keys');
          const keys = keysResp.ok ? (Array.isArray(keysResp.data) ? keysResp.data : keysResp.data?.keys || []) : [];
          for (const k of keys) {
            const normalized = this.normalizeModelMappingProvider(k.type);
            if (normalized) configuredTypes.add(normalized);
          }

          if (this.accounts.length > 0) configuredTypes.add('openai');
          if (this.claudeAccounts.length > 0) configuredTypes.add('anthropic');
          if (this.antigravityAccounts.length > 0) configuredTypes.add('gemini');
        } catch {
          if (this.accounts.length > 0) configuredTypes.add('openai');
          if (this.claudeAccounts.length > 0) configuredTypes.add('anthropic');
          if (this.antigravityAccounts.length > 0) configuredTypes.add('gemini');
        }

        this.modelMappingProviders = configuredTypes.size > 0
          ? allProviders.filter((p) => configuredTypes.has(p))
          : allProviders;
      }
    },

    async updateModelMapping(provider, tier, model) {
      this.modelMappingSaving = true;
      const { ok, data } = await this.api(`/api/model-mappings/provider/${provider}`, {
        method: 'PUT',
        body: JSON.stringify({ [tier]: model })
      });
      this.modelMappingSaving = false;
      if (ok && data?.providers) {
        this.modelMappingData.providers = data.providers;
        this.showToast(`${provider} ${tier} → ${model}`, 'success');
        if (this.testMappingInput) this.testModelMapping();
      } else {
        this.showToast(data?.error || this.t('updateFailed'), 'error');
      }
    },

    async resetModelMappings() {
      const { ok, data } = await this.api('/api/model-mappings/reset', { method: 'POST' });
      if (ok && data?.providers) {
        this.modelMappingData.providers = data.providers;
        this.showToast(this.t('modelMappingReset'), 'success');
        if (this.testMappingInput) this.testModelMapping();
      }
    },

    async testModelMapping() {
      if (!this.testMappingInput.trim()) {
        this.testMappingResult = null;
        this.testMappingResults = {};
        return;
      }
      const results = {};
      let tier = null;
      for (const provider of this.modelMappingProviders) {
        const { ok, data } = await this.api(`/api/model-mappings/resolve?model=${encodeURIComponent(this.testMappingInput)}&provider=${encodeURIComponent(provider)}`);
        if (ok && data) {
          results[provider] = data.resolved;
          if (!tier) tier = data.tier;
        }
      }
      this.testMappingResult = tier ? { tier } : null;
      this.testMappingResults = results;
    }
  };
}
