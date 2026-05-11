export function createApiKeysPageModule() {
  return {
    keyPlaceholders: {
      'openai': { name: 'My OpenAI Key', key: 'sk-...', url: 'https://api.openai.com/v1' },
      'anthropic': { name: 'My Anthropic Key', key: 'sk-ant-...', url: 'https://api.anthropic.com' },
      'gemini': { name: 'My Gemini Key', key: 'AIza...', url: 'https://generativelanguage.googleapis.com/v1beta' },
      'azure-openai': { name: 'My Azure OpenAI Key', key: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', url: 'https://{resource}.openai.azure.com' },
      'vertex-ai': { name: 'My Vertex AI Key', key: '{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}', url: '' },
      'deepseek': { name: 'My DeepSeek Key', key: 'sk-...', url: 'https://api.deepseek.com' },
      'minimax': { name: 'My MiniMax Key', key: 'eyJ...', url: 'https://api.minimax.io/v1' },
      'moonshot': { name: 'My Moonshot Key', key: 'sk-...', url: 'https://api.moonshot.ai/v1' },
      'zhipu': { name: 'My ZhipuAI Key', key: 'xxxxxxxx.xxxxxxxx', url: 'https://open.bigmodel.cn/api/paas/v4' }
    },
    apiKeysList: [],
    apiKeyStats: { totalKeys: 0, activeKeys: 0, totalRequests: 0, totalCost: 0 },
    showAddKeyModal: false,
    newKeyType: 'openai',
    newKeyName: '',
    newKeyValue: '',
    newKeyBaseUrl: '',
    newKeyExtra: { deploymentName: '', apiVersion: '2024-10-21', projectId: '', location: 'global' },
    showEditKeyModal: false,
    editKeyData: { id: '', name: '', type: '', apiKey: '', baseUrl: '', maskedKey: '', deploymentName: '', apiVersion: '', projectId: '', location: '', loading: false },
    editKeyTesting: false,

    apiKeyStateValue(key) {
      if (key?.enabled === false) return 'disabled';
      if (key?.isAvailable) return 'active';
      return 'idle';
    },

    apiKeyStateLabel(key) {
      const state = this.apiKeyStateValue(key);
      if (state === 'disabled') return this.t('disabled');
      if (state === 'active') return this.t('activeStatus');
      return this.t('idleStatus');
    },

    apiKeyStateDotClass(key) {
      const state = this.apiKeyStateValue(key);
      if (state === 'disabled') return 'bg-red-500';
      if (state === 'active') return 'bg-neon-green shadow-[0_0_8px_rgba(34,197,94,0.6)]';
      return 'bg-gray-500';
    },

    apiKeyStateTextClass(key) {
      const state = this.apiKeyStateValue(key);
      if (state === 'disabled') return 'text-red-400';
      if (state === 'active') return 'text-neon-green';
      return 'text-gray-500';
    },

    async loadApiKeys() {
      const { ok, data } = await this.api('/api/keys');
      if (ok) {
        this.apiKeysList = (data.keys || []).map((key) => ({ ...key, _testing: false }));
        if (data.stats) {
          this.apiKeyStats = {
            totalKeys: data.stats.totalKeys || 0,
            activeKeys: data.stats.activeKeys || 0,
            totalRequests: data.stats.totalRequests || 0,
            totalCost: data.stats.totalCost || 0
          };
        }
      }
    },

    async submitAddKey() {
      if (!this.newKeyValue.trim()) {
        this.showToast(this.t('apiKeyRequired'), 'error');
        return;
      }
      const type = this.newKeyType;
      const body = {
        type,
        name: this.newKeyName.trim() || `${type}-key`,
        apiKey: this.newKeyValue.trim()
      };

      if (type === 'azure-openai') {
        if (!this.newKeyBaseUrl.trim()) {
          this.showToast(this.t('azureEndpointRequired'), 'error');
          return;
        }
        if (!this.newKeyExtra.deploymentName.trim()) {
          this.showToast(this.t('azureDeploymentRequired'), 'error');
          return;
        }
        body.baseUrl = this.newKeyBaseUrl.trim();
        body.deploymentName = this.newKeyExtra.deploymentName.trim();
        body.apiVersion = this.newKeyExtra.apiVersion.trim() || '2024-10-21';
      } else if (type === 'vertex-ai') {
        if (!this.newKeyExtra.projectId.trim()) {
          this.showToast(this.t('vertexProjectRequired'), 'error');
          return;
        }
        body.projectId = this.newKeyExtra.projectId.trim();
        body.location = this.newKeyExtra.location.trim() || 'global';
      } else if (this.newKeyBaseUrl.trim()) {
        body.baseUrl = this.newKeyBaseUrl.trim();
      }

      const { ok, data } = await this.api('/api/keys', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (ok && data?.success) {
        this.showToast(this.t('apiKeyAdded'), 'success');
        this.showAddKeyModal = false;
        this.newKeyType = 'openai';
        this.newKeyName = '';
        this.newKeyValue = '';
        this.newKeyBaseUrl = '';
        this.newKeyExtra = { deploymentName: '', apiVersion: '2024-10-21', projectId: '', location: 'global' };
        this.loadApiKeys();
      } else {
        this.showToast(data?.error || this.t('apiKeyAddFailed'), 'error');
      }
    },

    async toggleApiKey(id, enabled) {
      const { ok } = await this.api(`/api/keys/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled })
      });
      if (ok) {
        this.loadApiKeys();
      } else {
        this.showToast(this.t('apiKeyUpdateFailed'), 'error');
      }
    },

    async deleteApiKey(id) {
      const { ok } = await this.api(`/api/keys/${id}`, { method: 'DELETE' });
      if (ok) {
        this.showToast(this.t('apiKeyDeleted'), 'success');
        this.loadApiKeys();
      } else {
        this.showToast(this.t('apiKeyDeleteFailed'), 'error');
      }
    },

    async validateApiKey(id) {
      const { ok, data } = await this.api(`/api/keys/${id}/validate`, { method: 'POST' });
      if (ok && data?.valid) {
        this.showToast(this.t('apiKeyValid'), 'success');
      } else {
        this.showToast(data?.error || this.t('apiKeyInvalid'), 'error');
      }
      this.loadApiKeys();
    },

    async testApiKey(id) {
      const key = this.apiKeysList.find((entry) => entry.id === id);
      if (key) key._testing = true;
      const { ok, data } = await this.api(`/api/keys/${id}/validate`, { method: 'POST' });
      if (key) key._testing = false;
      if (ok && data?.valid) {
        this.showToast(this.t('apiKeyValid'), 'success');
      } else {
        this.showToast(data?.error || this.t('apiKeyInvalid'), 'error');
      }
    },

    async openEditKeyModal(key) {
      this.editKeyData = {
        id: key.id,
        name: key.name,
        type: key.type,
        apiKey: '',
        baseUrl: key.baseUrl || '',
        maskedKey: key.apiKey,
        deploymentName: key.deploymentName || '',
        apiVersion: key.apiVersion || '2024-10-21',
        projectId: key.projectId || '',
        location: key.location || 'global',
        loading: true
      };
      this.showEditKeyModal = true;

      const { ok, data } = await this.api(`/api/keys/${key.id}`);
      if (ok && data?.key) {
        this.editKeyData = {
          ...this.editKeyData,
          name: data.key.name || this.editKeyData.name,
          apiKey: data.key.apiKey || '',
          baseUrl: data.key.baseUrl || '',
          deploymentName: data.key.deploymentName || '',
          apiVersion: data.key.apiVersion || this.editKeyData.apiVersion,
          projectId: data.key.projectId || '',
          location: data.key.location || this.editKeyData.location,
          loading: false
        };
      } else {
        this.editKeyData.loading = false;
        this.showToast(data?.error || this.t('apiKeyUpdateFailed'), 'error');
      }
    },

    _buildEditPatch() {
      const data = this.editKeyData;
      const patch = { name: data.name.trim() };
      if (data.apiKey.trim()) patch.apiKey = data.apiKey.trim();
      patch.baseUrl = data.baseUrl.trim() || undefined;
      if (data.type === 'azure-openai') {
        patch.deploymentName = data.deploymentName.trim();
        patch.apiVersion = data.apiVersion.trim() || '2024-10-21';
      }
      if (data.type === 'vertex-ai') {
        patch.projectId = data.projectId.trim();
        patch.location = data.location.trim() || 'global';
      }
      return patch;
    },

    async submitEditKey() {
      const patch = this._buildEditPatch();
      const { ok, data } = await this.api(`/api/keys/${this.editKeyData.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      if (ok && data?.success) {
        this.showToast(this.t('apiKeyUpdated'), 'success');
        this.showEditKeyModal = false;
        this.loadApiKeys();
      } else {
        this.showToast(data?.error || this.t('apiKeyUpdateFailed'), 'error');
      }
    },

    async testEditingKey() {
      this.editKeyTesting = true;
      const patch = this._buildEditPatch();
      await this.api(`/api/keys/${this.editKeyData.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });

      const { ok, data } = await this.api(`/api/keys/${this.editKeyData.id}/validate`, { method: 'POST' });
      this.editKeyTesting = false;

      if (ok && data?.valid) {
        this.showToast(this.t('apiKeyValid'), 'success');
      } else {
        this.showToast(data?.error || this.t('apiKeyInvalid'), 'error');
      }
    }
  };
}
