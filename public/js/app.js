document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({
        version: '1.0.5',
        connectionStatus: 'connecting',
        activeTab: 'dashboard',
        sidebarOpen: window.innerWidth >= 1024,
        loading: false,
        toast: null,
        currentTime: '',
        lang: localStorage.getItem('proxy-lang') || 'en',
        darkMode: localStorage.getItem('proxy-theme') !== 'light',

        t(key) {
            const dict = i18n[this.lang] || i18n.en;
            return dict[key] !== undefined ? dict[key] : (i18n.en[key] || key);
        },

        setLang(lang) {
            this.lang = lang;
            localStorage.setItem('proxy-lang', lang);
        },

        toggleTheme() {
            this.darkMode = !this.darkMode;
            document.documentElement.classList.toggle('light', !this.darkMode);
            document.documentElement.classList.toggle('dark', this.darkMode);
            localStorage.setItem('proxy-theme', this.darkMode ? 'dark' : 'light');
        },
        
        accounts: [],
        searchQuery: '',
        stats: { total: 0, active: 0, expired: 0, planType: '-' },

        haikuKiloModel: 'minimax/minimax-m2.5:free',
        accountStrategy: 'sticky',
        haikuModelSaving: false,
        strategySaving: false,
        routingPriority: 'account-first',
        routingSaving: false,

        // Model mapping
        modelMappingData: null,
        modelMappingProviders: [],
        modelMappingSaving: false,
        testMappingInput: '',
        testMappingResult: null,
        testMappingResults: {},
        kiloModels: [],
        kiloModelsLoading: false,

        showAddModal: false,
        showDeleteModal: false,
        deleteTarget: '',
        showQuotaModalView: false,
        selectedAccount: null,
        
        oauthManualMode: false,
        oauthManualUrl: '',
        oauthManualVerifier: '',
        oauthManualCode: '',
        
        testPrompt: 'Say hello',
        testResponse: '',
        testing: false,

        haikuTestPrompt: 'Say hello',
        haikuTestResponse: '',
        haikuTesting: false,

        haikuModelLabel() {
            const model = this.kiloModels.find(m => m.id === this.haikuKiloModel);
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
        
        configPath: '~/.proxypool-hub/accounts.json',
        
        logs: [],
        logSearchQuery: '',
        logFilters: { INFO: true, SUCCESS: true, WARN: true, ERROR: true, DEBUG: false },
        logEventSource: null,

        get filteredLogs() {
            const query = this.logSearchQuery.trim().toLowerCase();
            return this.logs.filter(log => {
                if (!this.logFilters[log.level]) return false;
                if (query && !log.message.toLowerCase().includes(query)) return false;
                return true;
            });
        },

        get filteredAccounts() {
            if (!this.searchQuery) return this.accounts;
            const q = this.searchQuery.toLowerCase();
            return this.accounts.filter(a => a.email.toLowerCase().includes(q));
        },

        init() {
            document.documentElement.classList.toggle('light', !this.darkMode);
            document.documentElement.classList.toggle('dark', this.darkMode);
            this.updateTime();
            setInterval(() => this.updateTime(), 1000);
            this.refreshAccounts();
            this.checkHealth();
            setInterval(() => this.checkHealth(), 30000);
            this.startLogStream();
            this.loadHaikuModelSetting();
            this.loadAccountStrategySetting();
            this.loadRoutingPrioritySetting();
            this.loadKiloModels();

            window.addEventListener('resize', () => {
                this.sidebarOpen = window.innerWidth >= 1024;
            });

            window.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'oauth-success') {
                    this.showToast(`Account ${event.data.email} added!`, 'success');
                    this.showAddModal = false;
                    this.refreshAccounts();
                }
            });
        },

        updateTime() {
            this.currentTime = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
        },

        setActiveTab(tab) {
            this.activeTab = tab;
            if (window.innerWidth < 1024) {
                this.sidebarOpen = false;
            }
            if (tab === 'apikeys') this.loadApiKeys();
            if (tab === 'usage') this.loadUsageData();
            if (tab === 'settings' && !this.modelMappingData) this.loadModelMappings();
        },

        async api(endpoint, options = {}) {
            try {
                const response = await fetch(endpoint, {
                    headers: { 'Content-Type': 'application/json' },
                    ...options
                });
                const data = await response.json();
                return { ok: response.ok, data };
            } catch (error) {
                return { ok: false, error: error.message };
            }
        },

        async checkHealth() {
            const { ok } = await this.api('/health');
            this.connectionStatus = ok ? 'connected' : 'disconnected';
        },

        async refreshAccounts() {
            this.loading = true;
            const { ok, data } = await this.api('/accounts');
            
            if (ok && data.accounts) {
                this.accounts = data.accounts;
                this.stats = {
                    total: data.total || data.accounts.length,
                    active: data.accounts.filter(a => a.isActive).length,
                    expired: data.accounts.filter(a => a.tokenExpired).length,
                    planType: data.accounts.find(a => a.isActive)?.planType || '-'
                };

                await this.refreshAllQuotaData();
            }
            this.loading = false;
        },

        async refreshAllQuotaData() {
            if (!this.accounts.length) return;
            const { ok, data } = await this.api('/accounts/quota/all');
            if (!ok || !data?.accounts) return;

            const quotaMap = new Map(
                data.accounts.map((entry) => [entry.email, entry.quota || null])
            );

            this.accounts = this.accounts.map((account) => ({
                ...account,
                quota: quotaMap.has(account.email) ? quotaMap.get(account.email) : account.quota
            }));

            if (this.selectedAccount?.email) {
                const refreshed = this.accounts.find((account) => account.email === this.selectedAccount.email);
                if (refreshed) this.selectedAccount = refreshed;
            }
        },

        getRemainingPercentage(account) {
            const usage = account?.quota?.usage;
            if (!usage) return null;

            const percentage = Number(usage.percentage);
            const usedFromTotal = Number(usage.totalTokenUsage);
            const remainingFromApi = Number(usage.remaining);

            let used = null;
            if (Number.isFinite(percentage)) {
                used = percentage;
            } else if (Number.isFinite(usedFromTotal)) {
                used = usedFromTotal;
            } else if (Number.isFinite(remainingFromApi)) {
                used = 100 - remainingFromApi;
            } else if (usage.limitReached === true || usage.allowed === false) {
                used = 100;
            }

            if (!Number.isFinite(used)) return null;
            const clampedUsed = Math.max(0, Math.min(100, used));
            return Math.max(0, Math.round(100 - clampedUsed));
        },

        isQuotaExhausted(account) {
            const remaining = this.getRemainingPercentage(account);
            if (remaining === null) return false;
            const usage = account?.quota?.usage;
            return remaining <= 0 || usage?.limitReached === true || usage?.allowed === false;
        },

        quotaBarClass(account) {
            const remaining = this.getRemainingPercentage(account);
            if (remaining === null) return 'bg-gray-500';
            if (remaining > 50) return 'bg-neon-green';
            if (remaining > 20) return 'bg-yellow-500';
            return 'bg-red-500';
        },

        quotaTextClass(account) {
            const remaining = this.getRemainingPercentage(account);
            if (remaining === null) return 'text-gray-500';
            return remaining <= 20 ? 'text-red-400' : 'text-gray-400';
        },

        quotaLabel(account) {
            const remaining = this.getRemainingPercentage(account);
            if (remaining === null) return '-';
            return `${remaining}%`;
        },

        getQuotaResetAt(account) {
            const usage = account?.quota?.usage;
            if (!usage) return null;

            if (usage.resetAt) return usage.resetAt;

            const epoch = Number(usage?.raw?.rate_limit?.primary_window?.reset_at);
            if (Number.isFinite(epoch)) {
                return new Date(epoch * 1000).toISOString();
            }

            const resetAfter = Number(
                usage.resetAfterSeconds ?? usage?.raw?.rate_limit?.primary_window?.reset_after_seconds
            );
            if (Number.isFinite(resetAfter) && resetAfter > 0) {
                return new Date(Date.now() + resetAfter * 1000).toISOString();
            }

            return null;
        },

        quotaResetAtLabel(account) {
            const resetAt = this.getQuotaResetAt(account);
            if (!resetAt) return null;
            const date = new Date(resetAt);
            if (Number.isNaN(date.getTime())) return null;
            return date.toLocaleString();
        },

        quotaResetSummary(account) {
            const resetAt = this.getQuotaResetAt(account);
            if (!resetAt) return null;

            const resetMs = new Date(resetAt).getTime();
            if (!Number.isFinite(resetMs)) return null;

            const deltaSec = Math.max(0, Math.floor((resetMs - Date.now()) / 1000));
            if (deltaSec === 0) return this.t('resetDueNow');

            const days = Math.floor(deltaSec / 86400);
            const hours = Math.floor((deltaSec % 86400) / 3600);
            const minutes = Math.floor((deltaSec % 3600) / 60);

            const dict = i18n[this.lang] || i18n.en;
            if (days > 0) return dict.resetsInDH(days, hours);
            if (hours > 0) return dict.resetsInHM(hours, minutes);
            return dict.resetsInM(minutes);
        },

        async startOAuth() {
            await this.api('/accounts/oauth/cleanup', { method: 'POST' });
            const { ok, data } = await this.api('/accounts/add', { method: 'POST' });
            
            if (ok && data.oauth_url) {
                const width = 500, height = 700;
                const left = (screen.width - width) / 2;
                const top = (screen.height - height) / 2;
                window.open(data.oauth_url, 'ChatGPT Login', `width=${width},height=${height},left=${left},top=${top}`);
                
                const checkAdded = setInterval(async () => {
                    const { ok, data } = await this.api('/accounts');
                    if (ok && data.accounts?.length > this.accounts.length) {
                        clearInterval(checkAdded);
                        this.showAddModal = false;
                        this.refreshAccounts();
                    }
                }, 2000);
                
                setTimeout(() => clearInterval(checkAdded), 120000);
            } else {
                this.showToast(data?.message || this.t('failedToStartOauth'), 'error');
            }
        },

        async startManualOAuth() {
            await this.api('/accounts/oauth/cleanup', { method: 'POST' });
            const { ok, data } = await this.api('/accounts/add', { method: 'POST' });

            if (ok && data.oauth_url) {
                this.oauthManualUrl = data.oauth_url;
                this.oauthManualVerifier = data.verifier;
                this.oauthManualCode = '';
                this.oauthManualMode = true;
            } else {
                this.showToast(data?.message || this.t('failedToStartOauth'), 'error');
            }
        },

        async submitManualOAuth() {
            if (!this.oauthManualCode) return;
            
            const { ok, data } = await this.api('/accounts/add/manual', {
                method: 'POST',
                body: JSON.stringify({
                    code: this.oauthManualCode,
                    verifier: this.oauthManualVerifier
                })
            });
            
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.showAddModal = false;
                this.oauthManualMode = false;
                this.refreshAccounts();
            } else {
                this.showToast(data?.error || this.t('failedToAdd'), 'error');
            }
        },

        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.showToast(this.t('copiedToClipboard'), 'success');
            } catch (e) {
                this.showToast(this.t('failedToCopy'), 'error');
            }
        },

        async importFromCodex() {
            const { ok, data } = await this.api('/accounts/import', { method: 'POST' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.showAddModal = false;
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || this.t('importFailed'), 'error');
            }
        },

        async switchAccount(email) {
            const { ok, data } = await this.api('/accounts/switch', {
                method: 'POST',
                body: JSON.stringify({ email })
            });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || this.t('failedToSwitch'), 'error');
            }
        },

        async refreshToken(email) {
            const { ok, data } = await this.api(`/accounts/${encodeURIComponent(email)}/refresh`, { method: 'POST' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || this.t('refreshFailed'), 'error');
            }
        },

        async refreshAllTokens() {
            this.showToast(this.t('refreshingAllTokens'), 'info');
            const { ok, data } = await this.api('/accounts/refresh/all', { method: 'POST' });
            if (ok) {
                this.showToast(data.message, 'success');
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || this.t('refreshFailed'), 'error');
            }
        },

        confirmDelete(email) {
            this.deleteTarget = email;
            this.showDeleteModal = true;
        },

        async executeDelete() {
            const { ok, data } = await this.api(`/accounts/${encodeURIComponent(this.deleteTarget)}`, { method: 'DELETE' });
            this.showDeleteModal = false;
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || this.t('deleteFailed'), 'error');
            }
        },

        showQuotaModal(acc) {
            this.selectedAccount = acc;
            this.showQuotaModalView = true;
        },

        async testChat() {
            if (!this.testPrompt.trim()) return;
            this.testing = true;
            this.testResponse = '';
            const { ok, data } = await this.api('/v1/chat/completions', {
                method: 'POST',
                body: JSON.stringify({
                    model: 'gpt-5.2',
                    messages: [{ role: 'user', content: this.testPrompt }]
                })
            });
            this.testing = false;
            if (ok && data.choices) {
                this.testResponse = data.choices[0].message.content;
            } else {
                this.testResponse = data?.error?.message || this.t('requestFailed');
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

        // ─── Model Mapping ─────────────────────────────────────────────

        async loadModelMappings() {
            const { ok, data } = await this.api('/api/model-mappings');
            if (ok && data) {
                this.modelMappingData = data;
                // Only show providers that have API keys configured
                const allProviders = Object.keys(data.providers || {});
                try {
                    const keysResp = await this.api('/api/keys');
                    const keys = keysResp.ok ? (Array.isArray(keysResp.data) ? keysResp.data : keysResp.data?.keys || []) : [];
                    if (keys.length > 0) {
                        const configuredTypes = new Set(keys.map(k => k.type));
                        this.modelMappingProviders = allProviders.filter(p => configuredTypes.has(p));
                    } else {
                        this.modelMappingProviders = [];
                    }
                } catch {
                    this.modelMappingProviders = [];
                }
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
                // Re-test if there's an active test
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
            // Test against all shown providers
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
                this.showToast(this.t('claudeSettingsUpdated'), 'success');
            } else {
                this.showToast(data?.error || error || this.t('claudeSettingsFailed'), 'error');
            }
        },

        async setCodexProxyConfig() {
            const { ok, data, error } = await this.api('/codex/config/proxy', {
                method: 'POST',
            });

            if (ok && data?.success) {
                this.showToast(this.t('codexSettingsUpdated'), 'success');
            } else {
                this.showToast(data?.error || data?.warning || error || this.t('codexSettingsFailed'), 'error');
            }
        },

        async setGeminiCliProxyConfig() {
            const { ok, data, error } = await this.api('/gemini-cli/config/proxy', {
                method: 'POST',
            });

            if (ok && data?.success) {
                this.showToast(this.t('geminiSettingsUpdated'), 'success');
            } else {
                this.showToast(data?.error || error || this.t('geminiSettingsFailed'), 'error');
            }
        },

        showToast(message, type = 'success') {
            this.toast = { message, type };
            setTimeout(() => { this.toast = null; }, 3000);
        },

        startLogStream() {
            if (this.logEventSource) this.logEventSource.close();
            
            this.logEventSource = new EventSource('/api/logs/stream?history=true');
            this.logEventSource.onmessage = (event) => {
                try {
                    const log = JSON.parse(event.data);
                    this.logs.unshift(log);
                    
                    if (this.logs.length > 500) {
                        this.logs = this.logs.slice(0, 500);
                    }
                } catch (e) {}
            };
            
            this.logEventSource.onerror = () => {
                setTimeout(() => this.startLogStream(), 3000);
            };
        },

        clearLogs() {
            this.logs = [];
        },

        formatLogMessage(message) {
            if (!message) return '';
            const match = message.match(/^\[(\w+)\]\s*/);
            if (match) {
                return message.replace(match[0], '');
            }
            return message;
        },

        getLogDetails(message) {
            if (!message) return null;
            const details = {};

            const patterns = [
                ['model', /model=([^\s|,]+)/],
                ['account', /account=([^\s|,]+)/],
                ['stream', /stream=(true|false)/],
                ['messages', /messages=(\d+)/],
                ['tools', /tools=(\d+)/],
                ['tokens', /tokens=(\d+)/],
                ['duration', /(\d+)ms/],
                ['status', /status=(\d+)/],
                ['error', /error=([^\s|]+)/]
            ];

            for (const [key, pattern] of patterns) {
                const match = message.match(pattern);
                if (match) {
                    details[key] = match[1];
                }
            }

            return Object.keys(details).length > 0 ? details : null;
        },

        // ─── API Keys Management ──────────────────────────────────────────
        keyPlaceholders: {
            'openai':       { name: 'My OpenAI Key',       key: 'sk-...',                           url: 'https://api.openai.com/v1' },
            'anthropic':    { name: 'My Anthropic Key',    key: 'sk-ant-...',                       url: 'https://api.anthropic.com' },
            'gemini':       { name: 'My Gemini Key',       key: 'AIza...',                          url: 'https://generativelanguage.googleapis.com/v1beta' },
            'azure-openai': { name: 'My Azure OpenAI Key', key: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', url: 'https://{resource}.openai.azure.com' },
            'vertex-ai':    { name: 'My Vertex AI Key',    key: '{"type":"service_account","project_id":"...","private_key":"...","client_email":"..."}', url: '' },
            'minimax':      { name: 'My MiniMax Key',      key: 'eyJ...',                           url: 'https://api.minimax.io/v1' },
            'moonshot':     { name: 'My Moonshot Key',     key: 'sk-...',                           url: 'https://api.moonshot.ai/v1' },
            'zhipu':        { name: 'My ZhipuAI Key',      key: 'xxxxxxxx.xxxxxxxx',                url: 'https://open.bigmodel.cn/api/paas/v4' },
        },
        apiKeysList: [],
        apiKeyStats: { totalKeys: 0, activeKeys: 0, totalRequests: 0, totalCost: 0 },
        showAddKeyModal: false,
        newKeyType: 'openai',
        newKeyName: '',
        newKeyValue: '',
        newKeyBaseUrl: '',
        newKeyExtra: { deploymentName: '', apiVersion: '2024-10-21', projectId: '', location: 'us-central1' },

        async loadApiKeys() {
            const { ok, data } = await this.api('/api/keys');
            if (ok) {
                this.apiKeysList = data.keys || [];
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
                body.location = this.newKeyExtra.location.trim() || 'us-central1';
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
                this.newKeyExtra = { deploymentName: '', apiVersion: '2024-10-21', projectId: '', location: 'us-central1' };
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

        // ─── Usage & Costs ────────────────────────────────────────────────
        usageOverview: { today: {}, allTime: {}, keys: {} },
        dailyStats: [],
        dailyDays: 7,
        usageHistory: [],
        providerStats: {},
        modelStats: {},

        get dailyChartMax() {
            if (!this.dailyStats.length) return 1;
            return Math.max(1, ...this.dailyStats.map(d => d.requests));
        },

        get providerStatsEntries() {
            const entries = Object.entries(this.providerStats)
                .map(([name, s]) => ({ name, ...s }))
                .sort((a, b) => b.requests - a.requests);
            const max = Math.max(1, ...entries.map(e => e.requests));
            return entries.map(e => ({ ...e, pct: (e.requests / max) * 100 }));
        },

        get modelStatsEntries() {
            const entries = Object.entries(this.modelStats)
                .map(([name, s]) => ({ name, ...s }))
                .sort((a, b) => b.requests - a.requests);
            const max = Math.max(1, ...entries.map(e => e.requests));
            return entries.map(e => ({ ...e, pct: (e.requests / max) * 100 }));
        },

        async loadUsageData() {
            const [overviewRes, dailyRes, historyRes, providerRes, modelRes] = await Promise.all([
                this.api('/api/usage/overview'),
                this.api(`/api/usage/daily?days=${this.dailyDays}`),
                this.api('/api/usage/history?limit=50'),
                this.api('/api/usage/providers'),
                this.api('/api/usage/models')
            ]);
            if (overviewRes.ok && overviewRes.data) {
                this.usageOverview = overviewRes.data;
            }
            if (dailyRes.ok && dailyRes.data?.stats) {
                this.dailyStats = dailyRes.data.stats;
            }
            if (historyRes.ok && historyRes.data?.history) {
                this.usageHistory = historyRes.data.history;
            }
            if (providerRes.ok && providerRes.data?.stats) {
                this.providerStats = providerRes.data.stats;
            }
            if (modelRes.ok && modelRes.data?.stats) {
                this.modelStats = modelRes.data.stats;
            }
        },

        async setDailyDays(days) {
            this.dailyDays = days;
            const res = await this.api(`/api/usage/daily?days=${days}`);
            if (res.ok && res.data?.stats) {
                this.dailyStats = res.data.stats;
            }
        },

        async refreshUsageData() {
            await this.loadUsageData();
            this.showToast(this.t('usageRefreshed'), 'success');
        },

        // ─── Request Logs ──────────────────────────────────────────────────
        reqLogEntries: [],
        reqLogDates: [],
        reqLogTotal: 0,
        reqLogOffset: 0,
        reqLogFilter: { date: '', provider: '', errorsOnly: false },
        reqLogSettings: { enabled: true, retentionDays: 7 },

        async loadRequestLogs() {
            // Load dates first if empty
            if (this.reqLogDates.length === 0) {
                const datesRes = await this.api('/api/request-logs/dates');
                if (datesRes.ok && datesRes.data?.dates) {
                    this.reqLogDates = datesRes.data.dates;
                    if (!this.reqLogFilter.date && this.reqLogDates.length > 0) {
                        this.reqLogFilter.date = this.reqLogDates[0];
                    }
                }
            }
            // Load settings
            const settingsRes = await this.api('/api/request-logs/settings');
            if (settingsRes.ok && settingsRes.data) {
                this.reqLogSettings = settingsRes.data;
            }

            const params = new URLSearchParams();
            if (this.reqLogFilter.date) params.set('date', this.reqLogFilter.date);
            params.set('limit', '50');
            params.set('offset', String(this.reqLogOffset));
            if (this.reqLogFilter.provider) params.set('provider', this.reqLogFilter.provider);
            if (this.reqLogFilter.errorsOnly) params.set('errorsOnly', 'true');

            const res = await this.api(`/api/request-logs?${params}`);
            if (res.ok && res.data) {
                this.reqLogEntries = (res.data.entries || []).map(e => ({ ...e, _expanded: false }));
                this.reqLogTotal = res.data.total || 0;
            }
        },

        async toggleRequestLogging(enabled) {
            const res = await this.api('/api/request-logs/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled })
            });
            if (res.ok && res.data) {
                this.reqLogSettings = res.data;
                this.showToast(enabled ? this.t('requestLoggingEnabled') : this.t('requestLoggingDisabled'), 'success');
            }
        },

        formatLogBody(body) {
            if (!body) return '';
            try {
                const parsed = JSON.parse(body);
                return JSON.stringify(parsed, null, 2);
            } catch {
                return body;
            }
        }
    }));
});
