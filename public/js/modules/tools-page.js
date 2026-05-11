export function createToolsPageModule() {
  return {
    proxyStatus: {
      claude: false,
      codex: false,
      gemini: false,
      openclaw: false
    },
    configViewerOpen: false,
    configViewerLoading: false,
    configViewerTool: '',
    configViewerFile: { path: '', exists: false, content: '' },
    configViewerError: '',
    toolsList: {},
    toolsOS: '',
    toolsInstalling: { node: false, claude: false, codex: false, gemini: false, openclaw: false },
    toolsErrors: {},
    toolsInstallingAll: false,
    nodeInstallInfo: null,
    toolsLatestVersions: {},
    toolsCheckingUpdates: false,
    toolsUpdating: { claude: false, codex: false, gemini: false, openclaw: false },
    toolsUpdatingAll: false,
    toolsSubTab: 'install',

    async refreshProxyStatus() {
      const [claude, codex, gemini, openclaw] = await Promise.all([
        this.api('/claude/config'),
        this.api('/codex/config'),
        this.api('/gemini-cli/config'),
        this.api('/openclaw/config')
      ]);
      this.proxyStatus.claude = !!(claude.ok && claude.data?.config?.env?.ANTHROPIC_BASE_URL?.includes('localhost'));
      this.proxyStatus.codex = !!(codex.ok && codex.data?.chatgpt_base_url?.includes('localhost'));
      this.proxyStatus.gemini = !!(gemini.ok && gemini.data?.patched);
      this.proxyStatus.openclaw = !!(openclaw.ok && openclaw.data?.configured);
    },

    getConfigViewerTitle(tool = this.configViewerTool) {
      const titles = {
        claude: 'Claude Code',
        codex: 'Codex',
        gemini: 'Gemini CLI',
        openclaw: 'OpenClaw'
      };
      return titles[tool] || tool || 'Config';
    },

    initConfigViewerFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const tool = params.get('configTool');
      if (tool) {
        this.openConfigViewer(tool, { pushHistory: false });
      }
    },

    updateConfigViewerUrl(tool = this.configViewerTool, { replace = false } = {}) {
      const url = new URL(window.location.href);
      if (tool) {
        url.searchParams.set('configTool', tool);
      } else {
        url.searchParams.delete('configTool');
      }
      const method = replace ? 'replaceState' : 'pushState';
      window.history[method]({}, '', url);
    },

    async openConfigViewer(tool, { pushHistory = true } = {}) {
      this.configViewerOpen = true;
      this.configViewerTool = tool;
      this.configViewerLoading = true;
      this.configViewerError = '';
      this.configViewerFile = { path: '', exists: false, content: '' };

      if (pushHistory) {
        this.updateConfigViewerUrl(tool);
      }

      const { ok, data, error } = await this.api(`/config-files/${encodeURIComponent(tool)}`);
      this.configViewerLoading = false;

      if (ok && data?.success && data.file) {
        this.configViewerFile = data.file;
        return;
      }

      this.configViewerError = data?.error || error || this.t('configViewerLoadFailed');
      this.configViewerFile = {
        path: data?.file?.path || '',
        exists: !!data?.file?.exists,
        content: ''
      };
    },

    closeConfigViewer() {
      this.configViewerOpen = false;
      this.configViewerLoading = false;
      this.configViewerTool = '';
      this.configViewerError = '';
      this.configViewerFile = { path: '', exists: false, content: '' };
      this.updateConfigViewerUrl('', { replace: true });
    },

    async refreshConfigViewer() {
      if (!this.configViewerTool) return;
      await this.openConfigViewer(this.configViewerTool, { pushHistory: false });
    },

    openConfigViewerInNewTab(tool) {
      const url = new URL(window.location.href);
      url.searchParams.set('configTool', tool);
      window.open(url.toString(), '_blank');
    },

    async setClaudeCodeProxyTestConfig() {
      const { ok, data, error } = await this.api('/claude/config/set', {
        method: 'POST',
        body: JSON.stringify({
          apiUrl: 'http://localhost:8081',
          apiKey: 'test'
        })
      });

      if (ok && data?.success) {
        this.proxyStatus.claude = true;
        this.showToast(this.t('claudeSettingsUpdated'), 'success');
      } else {
        this.showToast(data?.error || error || this.t('claudeSettingsFailed'), 'error');
      }
    },

    async removeClaudeProxy() {
      const { ok, data, error } = await this.api('/claude/config/direct', { method: 'POST' });
      if (ok && data?.success) {
        this.proxyStatus.claude = false;
        this.showToast(this.t('claudeProxyRemoved'), 'success');
      } else {
        this.showToast(data?.error || error || this.t('removeProxyFailed'), 'error');
      }
    },

    async setCodexProxyConfig() {
      const { ok, data, error } = await this.api('/codex/config/proxy', {
        method: 'POST'
      });

      if (ok && data?.success) {
        this.proxyStatus.codex = true;
        this.showToast(data?.message || this.t('codexSettingsUpdated'), data?.auth_ready ? 'success' : 'warning');
        return { ok: true, data };
      }

      this.showToast(data?.error || data?.warning || error || this.t('codexSettingsFailed'), 'error');
      return { ok: false, data, error };
    },

    async removeCodexProxy() {
      const { ok, data, error } = await this.api('/codex/config/direct', { method: 'POST' });
      if (ok && data?.success) {
        this.proxyStatus.codex = false;
        this.showToast(this.t('codexProxyRemoved'), 'success');
      } else {
        this.showToast(data?.error || error || this.t('removeProxyFailed'), 'error');
      }
    },

    async setGeminiCliProxyConfig() {
      const { ok, data, error } = await this.api('/gemini-cli/config/proxy', {
        method: 'POST'
      });

      if (ok && data?.success) {
        this.proxyStatus.gemini = true;
        this.showToast(this.t('geminiSettingsUpdated'), 'success');
      } else {
        this.showToast(data?.error || error || this.t('geminiSettingsFailed'), 'error');
      }
    },

    async removeGeminiProxy() {
      const { ok, data, error } = await this.api('/gemini-cli/config/direct', { method: 'POST' });
      if (ok && data?.success) {
        this.proxyStatus.gemini = false;
        this.showToast(this.t('geminiProxyRemoved'), 'success');
      } else {
        this.showToast(data?.error || error || this.t('removeProxyFailed'), 'error');
      }
    },

    async setOpenClawProxyConfig() {
      const { ok, data, error } = await this.api('/openclaw/config/proxy', {
        method: 'POST'
      });

      if (ok && data?.success) {
        this.proxyStatus.openclaw = true;
        this.showToast(this.t('openclawSettingsUpdated'), 'success');
      } else {
        this.showToast(data?.error || error || this.t('openclawSettingsFailed'), 'error');
      }
    },

    async removeOpenClawProxy() {
      const { ok, data, error } = await this.api('/openclaw/config/direct', { method: 'POST' });
      if (ok && data?.success) {
        this.proxyStatus.openclaw = false;
        this.showToast(this.t('openclawProxyRemoved'), 'success');
      } else {
        this.showToast(data?.error || error || this.t('removeProxyFailed'), 'error');
      }
    },

    async launchTool(toolId) {
      const { ok, data } = await this.api(`/api/tools/launch/${toolId}`, { method: 'POST' });
      if (ok && data?.success) {
        this.showToast(this.t('toolLaunched'), 'success');
      } else {
        this.showToast(data?.error || this.t('toolLaunchFailed'), 'error');
      }
    },

    async configAndLaunch(toolId) {
      await this.refreshProxyStatus();
      if (!this.proxyStatus[toolId]) {
        const configMethods = {
          claude: () => this.setClaudeCodeProxyTestConfig(),
          codex: () => this.setCodexProxyConfig(),
          gemini: () => this.setGeminiCliProxyConfig(),
          openclaw: () => this.setOpenClawProxyConfig()
        };
        const configResult = await configMethods[toolId]?.();
        if (toolId === 'codex' && (!configResult?.ok || !configResult?.data?.auth_ready)) {
          return;
        }
      }
      await this.launchTool(toolId);
    },

    async loadToolsStatus() {
      const res = await this.api('/api/tools/status');
      if (res.ok && res.data) {
        this.toolsList = res.data.tools || {};
        this.toolsOS = res.data.os || '';
      }
      if (this.toolsList.node && !this.toolsList.node.installed) {
        const infoRes = await this.api('/api/tools/node-info');
        if (infoRes.ok && infoRes.data) {
          this.nodeInstallInfo = infoRes.data;
        }
      }
      this.checkToolUpdates();
    },

    async installNodeJs() {
      this.toolsInstalling.node = true;
      this.toolsErrors.node = null;
      const res = await this.api('/api/tools/install-node', { method: 'POST' });
      this.toolsInstalling.node = false;
      if (res.ok && res.data?.success) {
        this.showToast(`Node.js ${this.t('installSuccess')}`, 'success');
        await this.loadToolsStatus();
      } else {
        const errMsg = res.data?.error || this.t('installFailed');
        this.toolsErrors.node = errMsg;
        if (res.data?.command) {
          this.toolsErrors.node = `${errMsg}\n${this.t('tryManually')}: ${res.data.command}`;
        }
        this.showToast(this.t('installFailed'), 'error');
      }
    },

    async installCliTool(toolId) {
      this.toolsInstalling[toolId] = true;
      this.toolsErrors[toolId] = null;
      const res = await this.api(`/api/tools/install/${toolId}`, { method: 'POST' });
      this.toolsInstalling[toolId] = false;
      if (res.ok && res.data?.success) {
        this.showToast(`${this.toolsList[toolId]?.name || toolId} ${this.t('installSuccess')}`, 'success');
        await this.loadToolsStatus();
      } else {
        this.toolsErrors[toolId] = res.data?.error || this.t('installFailed');
        this.showToast(this.t('installFailed'), 'error');
      }
    },

    async installAllTools() {
      this.toolsInstallingAll = true;
      const tools = ['claude', 'codex', 'gemini', 'openclaw'];
      for (const toolId of tools) {
        if (!this.toolsList[toolId]?.installed) {
          await this.installCliTool(toolId);
        }
      }
      this.toolsInstallingAll = false;
      this.showToast(this.t('allToolsInstalled'), 'success');
    },

    async checkToolUpdates() {
      this.toolsCheckingUpdates = true;
      const res = await this.api('/api/tools/check-updates', { method: 'POST' });
      this.toolsCheckingUpdates = false;
      if (res.ok && res.data?.latestVersions) {
        this.toolsLatestVersions = res.data.latestVersions;
      }
    },

    isUpdateAvailable(toolId) {
      const tool = this.toolsList[toolId];
      const latest = this.toolsLatestVersions[toolId];
      if (!tool?.installed || !tool.version || !latest) return false;
      return tool.version !== latest;
    },

    toolsWithUpdates() {
      return ['claude', 'codex', 'gemini', 'openclaw'].filter((id) => this.isUpdateAvailable(id)).length;
    },

    async updateCliTool(toolId) {
      this.toolsUpdating[toolId] = true;
      this.toolsErrors[toolId] = null;
      const res = await this.api(`/api/tools/update/${toolId}`, { method: 'POST' });
      this.toolsUpdating[toolId] = false;
      if (res.ok && res.data?.success) {
        this.showToast(`${this.toolsList[toolId]?.name || toolId} ${this.t('updateSuccess')}`, 'success');
        await this.loadToolsStatus();
      } else {
        this.toolsErrors[toolId] = res.data?.error || this.t('updateFailed');
        this.showToast(this.t('updateFailed'), 'error');
      }
    },

    async updateAllTools() {
      this.toolsUpdatingAll = true;
      const tools = ['claude', 'codex', 'gemini', 'openclaw'];
      for (const toolId of tools) {
        if (this.isUpdateAvailable(toolId)) {
          await this.updateCliTool(toolId);
        }
      }
      this.toolsUpdatingAll = false;
      this.showToast(this.t('allToolsUpdated'), 'success');
    }
  };
}
