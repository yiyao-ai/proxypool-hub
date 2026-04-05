document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({
        version: '1.0.6',
        connectionStatus: 'connecting',
        activeTab: 'dashboard',
        sidebarOpen: window.innerWidth >= 1024,
        loading: false,
        toast: null,
        currentTime: '',
        lang: localStorage.getItem('proxy-lang') || 'en',
        darkMode: localStorage.getItem('proxy-theme') !== 'light',

        t(key, ...args) {
            const dict = i18n[this.lang] || i18n.en;
            const value = dict[key] !== undefined ? dict[key] : (i18n.en[key] || key);
            return typeof value === 'function' ? value(...args) : value;
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
        accountSubTab: 'chatgpt',
        accountSearchQuery: '',
        stats: { total: 0, available: 0, expired: 0, planType: '-' },

        // Claude accounts
        claudeAccounts: [],
        antigravityAccounts: [],
        showClaudeUsageModal: false,
        selectedClaudeAccount: null,
        claudeUsageRefreshing: false,
        showAntigravityQuotaModal: false,
        selectedAntigravityAccount: null,
        antigravityQuotaRefreshing: false,

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
        appRoutingTargets: { appIds: [], bindingTypes: [], chatgptAccounts: [], claudeAccounts: [], antigravityAccounts: [], apiKeys: [] },
        appRoutingSaving: {},
        selectedAppRoutingId: '',
        appRoutingForm: { enabled: true, fallbackToDefault: true, bindings: [], currentType: null, currentTargetIds: [], targetQuery: '', targetPickerOpen: false },
        enableFreeModels: true,
        freeModelsSaving: false,

        // Proxy status
        proxyStatus: {
            claude: false,
            codex: false,
            gemini: false,
            openclaw: false
        },

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
        configViewerOpen: false,
        configViewerLoading: false,
        configViewerTool: '',
        configViewerFile: { path: '', exists: false, content: '' },
        configViewerError: '',
        
        oauthManualMode: false,
        oauthManualUrl: '',
        oauthManualVerifier: '',
        oauthManualCode: '',
        
        testPrompt: 'Say hello',
        testResponse: '',
        testing: false,
        chatSources: [],
        chatModels: [],
        chatSourceId: '',
        chatModel: 'gpt-5.2',
        chatSystemPrompt: '',
        chatInput: '',
        chatMessages: [],
        chatSessions: [],
        activeChatSessionId: '',
        chatStorageKey: 'proxypool-hub-chat-sessions-v1',
        chatHistoryOpen: false,
        chatSystemPromptOpen: false,
        chatLoading: false,
        chatSourceLoading: false,
        chatStreamController: null,

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
        apiExplorerPresets: [
            { name: 'Health', method: 'GET', endpoint: '/health', body: '' },
            { name: 'Accounts', method: 'GET', endpoint: '/accounts', body: '' },
            { name: 'Claude Accounts', method: 'GET', endpoint: '/claude-accounts', body: '' },
            { name: 'Models', method: 'GET', endpoint: '/v1/models', body: '' },
            { name: 'Usage Overview', method: 'GET', endpoint: '/api/usage/overview', body: '' },
            { name: 'Request Logs', method: 'GET', endpoint: '/api/request-logs?limit=10', body: '' },
            {
                name: 'Chat Completion Test',
                method: 'POST',
                endpoint: '/v1/chat/completions',
                body: JSON.stringify({
                    model: 'gpt-5.2',
                    messages: [{ role: 'user', content: 'Say hello' }]
                }, null, 2)
            }
        ],
        apiExplorerPresetIndex: 0,
        apiExplorerForm: {
            method: 'GET',
            endpoint: '/health',
            body: ''
        },
        apiExplorerLoading: false,
        apiExplorerResponse: null,

        get filteredLogs() {
            const query = this.logSearchQuery.trim().toLowerCase();
            return this.logs.filter(log => {
                if (!this.logFilters[log.level]) return false;
                if (query && !log.message.toLowerCase().includes(query)) return false;
                return true;
            });
        },

        get filteredAccounts() {
            if (!this.accountSearchQuery) return this.accounts;
            const q = this.accountSearchQuery.toLowerCase();
            return this.accounts.filter(a => a.email.toLowerCase().includes(q));
        },

        get filteredClaudeAccounts() {
            if (!this.accountSearchQuery) return this.claudeAccounts;
            const q = this.accountSearchQuery.toLowerCase();
            return this.claudeAccounts.filter(a => a.email.toLowerCase().includes(q) || (a.displayName || '').toLowerCase().includes(q));
        },

        get filteredAntigravityAccounts() {
            if (!this.accountSearchQuery) return this.antigravityAccounts;
            const q = this.accountSearchQuery.toLowerCase();
            return this.antigravityAccounts.filter(a => a.email.toLowerCase().includes(q) || (a.displayName || '').toLowerCase().includes(q));
        },

        get dashboardTotalAccounts() {
            return this.accounts.length + this.claudeAccounts.length + this.antigravityAccounts.length;
        },

        get dashboardProxyReadyCount() {
            return Object.values(this.proxyStatus).filter(Boolean).length;
        },

        init() {
            document.documentElement.classList.toggle('light', !this.darkMode);
            document.documentElement.classList.toggle('dark', this.darkMode);
            this.updateTime();
            setInterval(() => this.updateTime(), 1000);
            this.refreshAccounts();
            this.refreshClaudeAccounts();
            this.refreshAntigravityAccounts();
            this.checkHealth();
            setInterval(() => this.checkHealth(), 30000);
            this.startLogStream();
            this.loadHaikuModelSetting();
            this.loadAccountStrategySetting();
            this.loadRoutingPrioritySetting();
            this.loadRoutingModeSetting();
            this.loadAppRoutingSettings();
            this.loadFreeModelsSetting();
            this.loadKiloModels();
            this.refreshProxyStatus();
            this.loadChatSessions();
            this.loadChatSources();
            this.loadChatModels();
            this.initConfigViewerFromUrl();

            window.addEventListener('resize', () => {
                this.sidebarOpen = window.innerWidth >= 1024;
            });

            window.addEventListener('message', (event) => {
                if (event.data && event.data.type === 'oauth-success') {
                    this.showToast(`Account ${event.data.email} added!`, 'success');
                    this.showAddModal = false;
                    this.refreshAccounts();
                }
                if (event.data && event.data.type === 'claude-oauth-success') {
                    this.showToast('Claude account added!', 'success');
                    this.refreshClaudeAccounts();
                }
                if (event.data && event.data.type === 'antigravity-oauth-success') {
                    this.showToast(this.t('antigravityAccountAdded'), 'success');
                    this.refreshAntigravityAccounts();
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
            if (tab === 'accounts') { this.refreshAccounts(); this.refreshClaudeAccounts(); this.refreshAntigravityAccounts(); }
            if (tab === 'apikeys') this.loadApiKeys();
            if (tab === 'usage') this.loadUsageData();
            if (tab === 'pricing') this.loadPricingData();
            if (tab === 'apiExplorer' && !this.apiExplorerResponse) this.loadApiExplorerPreset(this.apiExplorerPresetIndex);
            if (tab === 'dashboard') this.refreshProxyStatus();
            if (tab === 'chat') {
                this.loadChatSources();
                this.loadChatModels();
            }
            if (tab === 'settings') {
                if (!this.modelMappingData) this.loadModelMappings();
                this.refreshProxyStatus();
            }
        },

        loadApiExplorerPreset(index) {
            const preset = this.apiExplorerPresets[index];
            if (!preset) return;

            this.apiExplorerPresetIndex = index;
            this.apiExplorerForm = {
                method: preset.method,
                endpoint: preset.endpoint,
                body: preset.body || ''
            };
        },

        apiExplorerCanSendBody() {
            return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(this.apiExplorerForm.method);
        },

        clearApiExplorerResponse() {
            this.apiExplorerResponse = null;
        },

        async copyApiExplorerResponse() {
            if (!this.apiExplorerResponse?.bodyText) return;
            try {
                await navigator.clipboard.writeText(this.apiExplorerResponse.bodyText);
                this.showToast(this.t('copiedToClipboard'), 'success');
            } catch {
                this.showToast(this.t('failedToCopy'), 'error');
            }
        },

        async runApiExplorerRequest() {
            const endpoint = this.apiExplorerForm.endpoint.trim();
            if (!endpoint) {
                this.showToast(this.t('endpointRequired'), 'error');
                return;
            }

            const method = this.apiExplorerForm.method.toUpperCase();
            const headers = { Accept: 'application/json' };
            const options = { method, headers };

            if (this.apiExplorerCanSendBody()) {
                const body = this.apiExplorerForm.body.trim();
                if (body) {
                    try {
                        JSON.parse(body);
                        headers['Content-Type'] = 'application/json';
                        options.body = body;
                    } catch {
                        this.showToast(this.t('invalidJsonBody'), 'error');
                        return;
                    }
                }
            }

            this.apiExplorerLoading = true;
            const startedAt = performance.now();

            try {
                const response = await fetch(endpoint, options);
                const durationMs = Math.round(performance.now() - startedAt);
                const rawText = await response.text();

                let parsedBody = null;
                let prettyBody = rawText;
                try {
                    parsedBody = rawText ? JSON.parse(rawText) : null;
                    prettyBody = parsedBody === null ? '' : JSON.stringify(parsedBody, null, 2);
                } catch {
                    parsedBody = null;
                }

                this.apiExplorerResponse = {
                    ok: response.ok,
                    status: response.status,
                    statusText: response.statusText,
                    durationMs,
                    contentType: response.headers.get('content-type') || '-',
                    headers: Array.from(response.headers.entries()),
                    isJson: parsedBody !== null,
                    body: parsedBody,
                    bodyText: rawText,
                    prettyBody
                };
            } catch (error) {
                this.apiExplorerResponse = {
                    ok: false,
                    status: 0,
                    statusText: 'NETWORK_ERROR',
                    durationMs: Math.round(performance.now() - startedAt),
                    contentType: '-',
                    headers: [],
                    isJson: false,
                    body: null,
                    bodyText: error.message,
                    prettyBody: error.message
                };
                this.showToast(error.message || this.t('requestFailed'), 'error');
            } finally {
                this.apiExplorerLoading = false;
            }
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
                const enabledAccounts = data.accounts.filter(a => a.enabled !== false);
                this.stats = {
                    total: data.total || data.accounts.length,
                    available: enabledAccounts.length,
                    expired: data.accounts.filter(a => a.tokenExpired).length,
                    planType: enabledAccounts[0]?.planType || data.accounts[0]?.planType || '-'
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

        async toggleAccountEnabled(email, enabled) {
            const { ok, data } = await this.api(`/accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'PUT',
                body: JSON.stringify({ enabled })
            });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || data?.error || this.t('updateFailed'), 'error');
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

        // ─── Claude Account Methods ────────────────────────────────────────
        async refreshClaudeAccounts({ refreshUsage = false } = {}) {
            const { ok, data } = await this.api('/claude-accounts');
            if (ok) {
                this.claudeAccounts = data.accounts || [];
                await this.refreshClaudeQuotaData({ force: refreshUsage });
            }
        },

        async refreshAntigravityAccounts({ refreshQuota = false } = {}) {
            const { ok, data } = await this.api('/antigravity-accounts');
            if (ok) {
                this.antigravityAccounts = data.accounts || [];
                await this.refreshAntigravityQuotaData({ force: refreshQuota });
            }
        },

        async refreshClaudeQuotaData({ force = false } = {}) {
            if (!this.claudeAccounts.length) return;
            const endpoint = force ? '/claude-accounts/quota/all?refresh=true' : '/claude-accounts/quota/all';
            const { ok, data } = await this.api(endpoint);
            if (!ok || !data?.accounts) return;

            const usageMap = new Map(
                data.accounts.map((entry) => [entry.email, entry])
            );

            this.claudeAccounts = this.claudeAccounts.map((account) => ({
                ...account,
                usageSummary: usageMap.get(account.email) || account.usageSummary || null
            }));

            if (this.selectedClaudeAccount?.email) {
                const refreshed = this.claudeAccounts.find((account) => account.email === this.selectedClaudeAccount.email);
                if (refreshed) this.selectedClaudeAccount = refreshed;
            }
        },

        claudeUsageWindow(account, key) {
            return account?.usageSummary?.usage?.[key] || null;
        },

        claudeUsagePercent(windowData) {
            const value = Number(windowData?.utilization);
            return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
        },

        claudeUsageRemaining(windowData) {
            const used = this.claudeUsagePercent(windowData);
            if (used === null) return null;
            return Math.max(0, 100 - used);
        },

        claudeUsageBarClass(windowData) {
            const used = this.claudeUsagePercent(windowData);
            if (used === null) return 'bg-gray-600';
            if (used >= 90) return 'bg-red-500';
            if (used >= 70) return 'bg-yellow-500';
            return 'bg-cyan-400';
        },

        claudeUsageTextClass(windowData) {
            const used = this.claudeUsagePercent(windowData);
            if (used === null) return 'text-gray-500';
            if (used >= 90) return 'text-red-400';
            if (used >= 70) return 'text-yellow-400';
            return 'text-cyan-300';
        },

        claudeUsageWindowLabel(account, key, fallback = '-') {
            const used = this.claudeUsagePercent(this.claudeUsageWindow(account, key));
            return used === null ? fallback : `${used}% used`;
        },

        claudeUsageResetLabel(windowData) {
            if (!windowData?.resetsAt) return '-';
            const resetAt = new Date(windowData.resetsAt);
            if (Number.isNaN(resetAt.getTime())) return '-';
            return resetAt.toLocaleString();
        },

        claudeUsageSourceLabel(account) {
            const source = account?.usageSummary?.source;
            if (source === 'oauth_usage') return 'OAuth usage API';
            if (source === 'response_headers') return 'Observed headers';
            return 'Usage unavailable';
        },

        claudeUsageUnavailableReason(account) {
            const availability = account?.usageSummary?.availability;
            if (!availability) return null;
            if (availability.fetchError && /does not support this OAuth token/i.test(availability.fetchError)) {
                return 'This token cannot call /api/oauth/usage';
            }
            if (availability.hasProfileScope === false) {
                return 'Missing user:profile scope';
            }
            return availability.fetchError || null;
        },

        claudeRuntimeStatusLabel(account) {
            const runtime = account?.usageSummary?.runtime;
            if (!runtime) return 'Unknown';
            if (runtime.status === 'rejected') return 'Blocked';
            if (runtime.status === 'allowed_warning') return 'Warning';
            if (runtime.status === 'allowed') return 'Available';
            return runtime.status || 'Unknown';
        },

        claudeRuntimeStatusClass(account) {
            const status = account?.usageSummary?.runtime?.status;
            if (status === 'rejected') return 'bg-red-500/10 text-red-400 border border-red-500/30';
            if (status === 'allowed_warning') return 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30';
            if (status === 'allowed') return 'bg-green-500/10 text-green-400 border border-green-500/30';
            return 'bg-gray-500/10 text-gray-400 border border-gray-500/30';
        },

        claudeExtraUsageLabel(account) {
            const extra = account?.usageSummary?.usage?.extraUsage;
            if (!extra) return null;
            if (extra.monthlyLimit !== null && extra.usedCredits !== null) {
                return `$${extra.usedCredits} / $${extra.monthlyLimit}`;
            }
            const utilization = Number(extra.utilization);
            return Number.isFinite(utilization) ? `${Math.round(utilization)}%` : null;
        },

        openClaudeUsageModal(account) {
            this.selectedClaudeAccount = account;
            this.showClaudeUsageModal = true;
            this.refreshSingleClaudeQuota(account.email);
        },

        async refreshSingleClaudeQuota(email) {
            this.claudeUsageRefreshing = true;
            const { ok, data } = await this.api(`/claude-accounts/${encodeURIComponent(email)}/quota/refresh`, { method: 'POST' });
            this.claudeUsageRefreshing = false;
            if (!ok || !data?.account) return;

            this.claudeAccounts = this.claudeAccounts.map((account) => (
                account.email === email
                    ? { ...account, usageSummary: data.account }
                    : account
            ));

            if (this.selectedClaudeAccount?.email === email) {
                const refreshed = this.claudeAccounts.find((account) => account.email === email);
                if (refreshed) this.selectedClaudeAccount = refreshed;
            }
        },

        async refreshAntigravityQuotaData({ force = false } = {}) {
            if (!this.antigravityAccounts.length) return;
            const endpoint = force ? '/antigravity-accounts/quota/all?refresh=true' : '/antigravity-accounts/quota/all';
            const { ok, data } = await this.api(endpoint);
            if (!ok || !data?.accounts) return;

            const quotaMap = new Map(
                data.accounts.map((entry) => [entry.email, entry])
            );

            this.antigravityAccounts = this.antigravityAccounts.map((account) => ({
                ...account,
                quotaSummary: quotaMap.get(account.email) || account.quotaSummary || null
            }));

            if (this.selectedAntigravityAccount?.email) {
                const refreshed = this.antigravityAccounts.find((account) => account.email === this.selectedAntigravityAccount.email);
                if (refreshed) this.selectedAntigravityAccount = refreshed;
            }
        },

        antigravityQuotaModels(account) {
            return (account?.quotaSummary?.models || [])
                .filter((model) => model?.quota?.remainingPercent !== null && model?.quota?.remainingPercent !== undefined)
                .sort((a, b) => (a.quota.remainingPercent ?? 101) - (b.quota.remainingPercent ?? 101));
        },

        antigravityQuotaPreviewModels(account) {
            return this.antigravityQuotaModels(account).slice(0, 3);
        },

        antigravityQuotaPercent(model) {
            const value = Number(model?.quota?.remainingPercent);
            return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
        },

        antigravityQuotaBarClass(model) {
            const remaining = this.antigravityQuotaPercent(model);
            if (remaining === null) return 'bg-gray-600';
            if (remaining <= 20) return 'bg-red-500';
            if (remaining <= 50) return 'bg-yellow-500';
            return 'bg-cyan-400';
        },

        antigravityQuotaTextClass(model) {
            const remaining = this.antigravityQuotaPercent(model);
            if (remaining === null) return 'text-gray-500';
            if (remaining <= 20) return 'text-red-400';
            if (remaining <= 50) return 'text-yellow-400';
            return 'text-cyan-300';
        },

        antigravityQuotaResetLabel(model) {
            if (!model?.quota?.resetTime) return '-';
            const resetAt = new Date(model.quota.resetTime);
            return Number.isNaN(resetAt.getTime()) ? '-' : resetAt.toLocaleString();
        },

        antigravityQuotaSummaryLabel(account) {
            const count = this.antigravityQuotaModels(account).length;
            return count > 0 ? `${count} model quotas` : 'No quota data';
        },

        openAntigravityQuotaModal(account) {
            this.selectedAntigravityAccount = account;
            this.showAntigravityQuotaModal = true;
            this.refreshSingleAntigravityQuota(account.email);
        },

        async refreshSingleAntigravityQuota(email) {
            this.antigravityQuotaRefreshing = true;
            const { ok, data } = await this.api(`/antigravity-accounts/${encodeURIComponent(email)}/quota/refresh`, { method: 'POST' });
            this.antigravityQuotaRefreshing = false;
            if (!ok || !data?.account) return;

            this.antigravityAccounts = this.antigravityAccounts.map((account) => (
                account.email === email
                    ? { ...account, quotaSummary: data.account }
                    : account
            ));

            if (this.selectedAntigravityAccount?.email === email) {
                const refreshed = this.antigravityAccounts.find((account) => account.email === email);
                if (refreshed) this.selectedAntigravityAccount = refreshed;
            }
        },

        async addClaudeAccount() {
            await this.api('/claude-accounts/oauth/cleanup', { method: 'POST' });
            const { ok, data } = await this.api('/claude-accounts/add', { method: 'POST' });
            if (ok && data.oauth_url) {
                window.open(data.oauth_url, '_blank', 'width=600,height=700');
                this.showToast(this.t('oauthWindowOpened'), 'info');

                const checkAdded = setInterval(async () => {
                    const { ok: refreshOk, data: refreshData } = await this.api('/claude-accounts');
                    if (refreshOk && refreshData.accounts) {
                        const prevCount = this.claudeAccounts.length;
                        this.claudeAccounts = refreshData.accounts;
                        if (refreshData.accounts.length > prevCount) {
                            this.showToast(this.t('claudeAccountAdded'), 'success');
                            clearInterval(checkAdded);
                        }
                        await this.refreshClaudeQuotaData({ force: true });
                    }
                }, 2000);

                setTimeout(() => clearInterval(checkAdded), 120000);
            } else {
                this.showToast(data?.message || this.t('failedToStartOauth'), 'error');
            }
        },

        async importClaudeAccount() {
            const { ok, data } = await this.api('/claude-accounts/import', { method: 'POST' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshClaudeAccounts({ refreshUsage: true });
            } else {
                this.showToast(data?.message || this.t('importFailed'), 'error');
            }
        },

        async switchClaudeAccount(email) {
            const { ok, data } = await this.api('/claude-accounts/switch', {
                method: 'POST',
                body: JSON.stringify({ email })
            });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshClaudeAccounts({ refreshUsage: true });
            } else {
                this.showToast(data?.message || this.t('failedToSwitch'), 'error');
            }
        },

        async refreshClaudeAccount(email) {
            const { ok, data } = await this.api(`/claude-accounts/${encodeURIComponent(email)}/refresh`, { method: 'POST' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshClaudeAccounts({ refreshUsage: true });
            } else {
                this.showToast(data?.message || this.t('refreshFailed'), 'error');
            }
        },

        async refreshAllClaudeTokens() {
            this.showToast(this.t('refreshingAllTokens'), 'info');
            const { ok, data } = await this.api('/claude-accounts/refresh/all', { method: 'POST' });
            if (ok) {
                this.showToast(this.t('allTokensRefreshed'), 'success');
                this.refreshClaudeAccounts({ refreshUsage: true });
            } else {
                this.showToast(data?.message || this.t('refreshFailed'), 'error');
            }
        },

        async toggleClaudeAccountEnabled(email, enabled) {
            const { ok, data } = await this.api(`/claude-accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'PUT',
                body: JSON.stringify({ enabled })
            });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshClaudeAccounts({ refreshUsage: true });
            } else {
                this.showToast(data?.message || data?.error || this.t('updateFailed'), 'error');
            }
        },

        async removeClaudeAccount(email) {
            if (!confirm(this.t('confirmDeleteAccount') + ': ' + email)) return;
            const { ok, data } = await this.api(`/claude-accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshClaudeAccounts({ refreshUsage: true });
            } else {
                this.showToast(data?.message || this.t('deleteFailed'), 'error');
            }
        },

        async addAntigravityAccount() {
            await this.api('/antigravity-accounts/oauth/cleanup', { method: 'POST' });
            const { ok, data } = await this.api('/antigravity-accounts/add', { method: 'POST' });
            if (ok && data.oauth_url) {
                window.open(data.oauth_url, '_blank', 'width=640,height=760');
                this.showToast(this.t('oauthWindowOpened'), 'info');

                const checkAdded = setInterval(async () => {
                    const { ok: refreshOk, data: refreshData } = await this.api('/antigravity-accounts');
                    if (refreshOk && refreshData.accounts) {
                        const prevCount = this.antigravityAccounts.length;
                        this.antigravityAccounts = refreshData.accounts;
                        if (refreshData.accounts.length > prevCount) {
                            this.showToast(this.t('antigravityAccountAdded'), 'success');
                            clearInterval(checkAdded);
                        }
                    }
                }, 2000);

                setTimeout(() => clearInterval(checkAdded), 120000);
            } else {
                this.showToast(data?.message || data?.error || this.t('failedToStartOauth'), 'error');
            }
        },

        async importAntigravityAccount() {
            const raw = prompt('Paste Antigravity account JSON');
            if (!raw) return;
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                this.showToast('Invalid JSON', 'error');
                return;
            }
            const { ok, data } = await this.api('/antigravity-accounts/import', {
                method: 'POST',
                body: JSON.stringify(parsed)
            });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAntigravityAccounts();
            } else {
                this.showToast(data?.message || data?.error || this.t('importFailed'), 'error');
            }
        },

        async switchAntigravityAccount(email) {
            const { ok, data } = await this.api('/antigravity-accounts/switch', {
                method: 'POST',
                body: JSON.stringify({ email })
            });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAntigravityAccounts({ refreshQuota: true });
            } else {
                this.showToast(data?.message || this.t('failedToSwitch'), 'error');
            }
        },

        async refreshAntigravityAccount(email) {
            const { ok, data } = await this.api(`/antigravity-accounts/${encodeURIComponent(email)}/refresh`, { method: 'POST' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAntigravityAccounts({ refreshQuota: true });
            } else {
                this.showToast(data?.message || data?.error || this.t('refreshFailed'), 'error');
            }
        },

        async refreshAllAntigravityTokens() {
            const { ok, data } = await this.api('/antigravity-accounts/refresh/all', { method: 'POST' });
            if (ok) {
                this.showToast(this.t('antigravityAccountsRefreshed'), 'success');
                this.refreshAntigravityAccounts({ refreshQuota: true });
            } else {
                this.showToast(data?.message || data?.error || this.t('refreshFailed'), 'error');
            }
        },

        async toggleAntigravityAccountEnabled(email, enabled) {
            const { ok, data } = await this.api(`/antigravity-accounts/${encodeURIComponent(email)}/toggle`, {
                method: 'PUT',
                body: JSON.stringify({ enabled })
            });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAntigravityAccounts({ refreshQuota: true });
            } else {
                this.showToast(data?.message || data?.error || this.t('updateFailed'), 'error');
            }
        },

        async removeAntigravityAccount(email) {
            if (!confirm(this.t('confirmDeleteAccount') + ': ' + email)) return;
            const { ok, data } = await this.api(`/antigravity-accounts/${encodeURIComponent(email)}`, { method: 'DELETE' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAntigravityAccounts({ refreshQuota: true });
            } else {
                this.showToast(data?.message || data?.error || this.t('deleteFailed'), 'error');
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

        async loadChatSources() {
            this.chatSourceLoading = true;
            const { ok, data } = await this.api('/api/chat/sources');
            if (ok && Array.isArray(data?.sources)) {
                this.chatSources = data.sources;
                if (!this.chatSourceId || !this.chatSources.some((source) => source.id === this.chatSourceId)) {
                    this.chatSourceId = this.chatSources[0]?.id || '';
                    this.syncActiveChatSession();
                }
            }
            this.chatSourceLoading = false;
        },

        async loadChatModels() {
            const { ok, data } = await this.api('/v1/models');
            if (ok && Array.isArray(data?.data)) {
                this.chatModels = data.data.map((item) => item.id).filter(Boolean);
            }
        },

        loadChatSessions() {
            try {
                const raw = localStorage.getItem(this.chatStorageKey);
                const parsed = raw ? JSON.parse(raw) : [];
                this.chatSessions = Array.isArray(parsed) ? parsed : [];
            } catch {
                this.chatSessions = [];
            }

            if (this.chatSessions.length === 0) {
                this.newChatSession();
                return;
            }

            this.openChatSession(this.chatSessions[0].id);
        },

        persistChatSessions() {
            localStorage.setItem(this.chatStorageKey, JSON.stringify(this.chatSessions.slice(0, 30)));
        },

        chatSessionTitle(session) {
            return session?.title || this.t('newChat');
        },

        buildChatSessionTitle(messages) {
            const firstUserMessage = messages.find((message) => message.role === 'user' && message.content);
            if (!firstUserMessage) return this.t('newChat');
            return firstUserMessage.content.trim().slice(0, 24) || this.t('newChat');
        },

        newChatSession() {
            const sessionId = 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const session = {
                id: sessionId,
                title: this.t('newChat'),
                sourceId: this.chatSourceId || this.chatSources[0]?.id || '',
                model: this.chatModel || 'gpt-5.2',
                systemPrompt: '',
                messages: [],
                updatedAt: new Date().toISOString()
            };

            this.chatSessions.unshift(session);
            this.openChatSession(sessionId);
            this.persistChatSessions();
            this.chatHistoryOpen = false;
        },

        openChatSession(sessionId) {
            const session = this.chatSessions.find((item) => item.id === sessionId);
            if (!session) return;

            this.activeChatSessionId = session.id;
            this.chatSourceId = session.sourceId || this.chatSources[0]?.id || '';
            this.chatModel = session.model || 'gpt-5.2';
            this.chatSystemPrompt = session.systemPrompt || '';
            this.chatMessages = Array.isArray(session.messages) ? session.messages : [];
            this.chatInput = '';
            if (window.innerWidth < 1280) {
                this.chatHistoryOpen = false;
            }
        },

        syncActiveChatSession() {
            const session = this.chatSessions.find((item) => item.id === this.activeChatSessionId);
            if (!session) return;

            session.sourceId = this.chatSourceId || '';
            session.model = this.chatModel || 'gpt-5.2';
            session.systemPrompt = this.chatSystemPrompt || '';
            session.messages = [...this.chatMessages];
            session.title = this.buildChatSessionTitle(session.messages);
            session.updatedAt = new Date().toISOString();

            this.chatSessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            this.persistChatSessions();
        },

        removeChatSession(sessionId) {
            const index = this.chatSessions.findIndex((item) => item.id === sessionId);
            if (index < 0) return;

            this.chatSessions.splice(index, 1);

            if (this.activeChatSessionId === sessionId) {
                if (this.chatSessions.length === 0) {
                    this.activeChatSessionId = '';
                    this.chatMessages = [];
                    this.chatSystemPrompt = '';
                    this.chatInput = '';
                    this.newChatSession();
                    return;
                }
                this.openChatSession(this.chatSessions[0].id);
            }

            this.persistChatSessions();
        },

        async sendChatMessage() {
            if (this.chatLoading || !this.chatInput.trim() || !this.chatSourceId) return;

            const userMessage = {
                role: 'user',
                content: this.chatInput.trim()
            };

            this.chatMessages.push(userMessage);
            this.chatInput = '';
            this.syncActiveChatSession();
            this.chatLoading = true;

            const assistantMessage = {
                role: 'assistant',
                content: '',
                usage: null,
                model: this.chatModel.trim() || 'gpt-5.2',
                mappedModel: null,
                sourceLabel: this.chatSourceLabel(this.chatSourceId)
            };
            this.chatMessages.push(assistantMessage);
            this.syncActiveChatSession();

            const requestMessages = [];
            if (this.chatSystemPrompt.trim()) {
                requestMessages.push({ role: 'system', content: this.chatSystemPrompt.trim() });
            }
            for (const message of this.chatMessages) {
                if (message === assistantMessage) continue;
                requestMessages.push({ role: message.role, content: message.content });
            }

            this.chatStreamController = new AbortController();

            try {
                const response = await fetch('/api/chat/stream', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sourceId: this.chatSourceId,
                        model: this.chatModel.trim() || 'gpt-5.2',
                        messages: requestMessages
                    }),
                    signal: this.chatStreamController.signal
                });

                if (!response.ok || !response.body) {
                    const errorText = await response.text();
                    throw new Error(errorText || this.t('requestFailed'));
                }

                const streamResult = await this.consumeChatStream(response.body, assistantMessage);
                if (!assistantMessage.content && !assistantMessage.isError) {
                    await this.fetchChatCompletionFallback(requestMessages, assistantMessage);
                } else if (!streamResult.seenDelta && !streamResult.seenDone && !assistantMessage.isError) {
                    await this.fetchChatCompletionFallback(requestMessages, assistantMessage);
                }
            } catch (error) {
                assistantMessage.content = error.message || this.t('requestFailed');
                assistantMessage.isError = true;
                this.showToast(assistantMessage.content, 'error');
            } finally {
                this.chatLoading = false;
                this.chatStreamController = null;
                this.chatMessages = [...this.chatMessages];
                this.syncActiveChatSession();
            }
        },

        async consumeChatStream(stream, assistantMessage) {
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let seenDelta = false;
            let seenDone = false;
            const msgIndex = this.chatMessages.indexOf(assistantMessage);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const chunks = buffer.split('\n\n');
                buffer = chunks.pop() || '';

                let needsUpdate = false;
                for (const chunk of chunks) {
                    const payload = this.parseChatSseChunk(chunk);
                    if (!payload) continue;

                    if (payload.type === 'start') {
                        assistantMessage.mappedModel = payload.mappedModel || null;
                        assistantMessage.sourceLabel = payload.source?.label || assistantMessage.sourceLabel;
                        needsUpdate = true;
                    } else if (payload.type === 'delta') {
                        seenDelta = true;
                        assistantMessage.content += payload.text || '';
                        needsUpdate = true;
                    } else if (payload.type === 'done') {
                        seenDone = true;
                        assistantMessage.usage = payload.usage || null;
                        assistantMessage.model = payload.model || assistantMessage.model;
                        assistantMessage.mappedModel = payload.mappedModel || assistantMessage.mappedModel;
                        needsUpdate = true;
                    } else if (payload.type === 'error') {
                        assistantMessage.content = payload.error || this.t('requestFailed');
                        assistantMessage.isError = true;
                        throw new Error(assistantMessage.content);
                    }
                }

                if (needsUpdate && msgIndex >= 0) {
                    // Replace the message object to trigger Alpine.js reactivity
                    this.chatMessages[msgIndex] = { ...assistantMessage };
                    this.chatMessages = [...this.chatMessages];
                }
            }

            return { seenDelta, seenDone };
        },

        async fetchChatCompletionFallback(requestMessages, assistantMessage) {
            const { ok, data, error } = await this.api('/api/chat/complete', {
                method: 'POST',
                body: JSON.stringify({
                    sourceId: this.chatSourceId,
                    model: this.chatModel.trim() || 'gpt-5.2',
                    messages: requestMessages
                })
            });

            if (ok && data?.reply) {
                assistantMessage.content = data.reply.content || '';
                assistantMessage.usage = data.reply.usage || null;
                assistantMessage.model = data.model || assistantMessage.model;
                assistantMessage.mappedModel = data.mappedModel || null;
                assistantMessage.sourceLabel = data.source?.label || assistantMessage.sourceLabel;
                assistantMessage.isError = false;
                this.chatMessages = [...this.chatMessages];
                return;
            }

            throw new Error(data?.error || error || this.t('requestFailed'));
        },

        parseChatSseChunk(chunk) {
            const lines = chunk.split('\n');
            let dataLine = '';

            for (const line of lines) {
                if (line.startsWith('data:')) {
                    dataLine += line.slice(5).trim();
                }
            }

            if (!dataLine) return null;

            try {
                return JSON.parse(dataLine);
            } catch {
                return null;
            }
        },

        chatSourceLabel(sourceId) {
            return this.chatSources.find((source) => source.id === sourceId)?.label || sourceId;
        },

        toggleChatHistory() {
            this.chatHistoryOpen = !this.chatHistoryOpen;
        },

        toggleSystemPrompt() {
            this.chatSystemPromptOpen = !this.chatSystemPromptOpen;
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
            return [];
        },

        bindingOptionLabel(bindingType, option) {
            if (!option) return '';
            if (bindingType === 'api-key') return `${option.name} (${option.type})`;
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
                const allProviders = Object.keys(data.providers || {});
                const configuredTypes = new Set();

                try {
                    // Check API keys
                    const keysResp = await this.api('/api/keys');
                    const keys = keysResp.ok ? (Array.isArray(keysResp.data) ? keysResp.data : keysResp.data?.keys || []) : [];
                    for (const k of keys) configuredTypes.add(k.type);

                    // Check ChatGPT accounts → openai provider
                    if (this.accounts.length > 0) configuredTypes.add('openai');

                    // Check Claude accounts → anthropic provider
                    if (this.claudeAccounts.length > 0) configuredTypes.add('anthropic');
                    if (this.antigravityAccounts.length > 0) configuredTypes.add('google');
                } catch {
                    // fallback: still include account-based providers
                    if (this.accounts.length > 0) configuredTypes.add('openai');
                    if (this.claudeAccounts.length > 0) configuredTypes.add('anthropic');
                    if (this.antigravityAccounts.length > 0) configuredTypes.add('google');
                }

                this.modelMappingProviders = configuredTypes.size > 0
                    ? allProviders.filter(p => configuredTypes.has(p))
                    : [];
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

        async refreshProxyStatus() {
            const [claude, codex, gemini, openclaw] = await Promise.all([
                this.api('/claude/config'),
                this.api('/codex/config'),
                this.api('/gemini-cli/config'),
                this.api('/openclaw/config'),
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
                openclaw: 'OpenClaw',
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
                method: 'POST',
            });

            if (ok && data?.success) {
                this.proxyStatus.codex = true;
                this.showToast(this.t('codexSettingsUpdated'), 'success');
            } else {
                this.showToast(data?.error || data?.warning || error || this.t('codexSettingsFailed'), 'error');
            }
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
                method: 'POST',
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
                method: 'POST',
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
            // Refresh real proxy status from server before deciding
            await this.refreshProxyStatus();
            if (!this.proxyStatus[toolId]) {
                const configMethods = {
                    claude: () => this.setClaudeCodeProxyTestConfig(),
                    codex: () => this.setCodexProxyConfig(),
                    gemini: () => this.setGeminiCliProxyConfig(),
                    openclaw: () => this.setOpenClawProxyConfig(),
                };
                await configMethods[toolId]?.();
            }
            await this.launchTool(toolId);
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
        newKeyExtra: { deploymentName: '', apiVersion: '2024-10-21', projectId: '', location: 'global' },

        async loadApiKeys() {
            const { ok, data } = await this.api('/api/keys');
            if (ok) {
                this.apiKeysList = (data.keys || []).map(k => ({ ...k, _testing: false }));
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

        // ─── Test & Edit API Key ──────────────────────────────────────────

        async testApiKey(id) {
            const key = this.apiKeysList.find(k => k.id === id);
            if (key) key._testing = true;
            const { ok, data } = await this.api(`/api/keys/${id}/validate`, { method: 'POST' });
            if (key) key._testing = false;
            if (ok && data?.valid) {
                this.showToast(this.t('apiKeyValid'), 'success');
            } else {
                this.showToast(data?.error || this.t('apiKeyInvalid'), 'error');
            }
        },

        showEditKeyModal: false,
        editKeyData: { id: '', name: '', type: '', apiKey: '', baseUrl: '', maskedKey: '', deploymentName: '', apiVersion: '', projectId: '', location: '', loading: false },
        editKeyTesting: false,

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
                loading: true,
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
            const d = this.editKeyData;
            const patch = { name: d.name.trim() };
            if (d.apiKey.trim()) patch.apiKey = d.apiKey.trim();
            patch.baseUrl = d.baseUrl.trim() || undefined;
            if (d.type === 'azure-openai') {
                patch.deploymentName = d.deploymentName.trim();
                patch.apiVersion = d.apiVersion.trim() || '2024-10-21';
            }
            if (d.type === 'vertex-ai') {
                patch.projectId = d.projectId.trim();
                patch.location = d.location.trim() || 'global';
            }
            return patch;
        },

        async submitEditKey() {
            const patch = this._buildEditPatch();
            const { ok, data } = await this.api(`/api/keys/${this.editKeyData.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
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

            // Save changes first, then validate
            const patch = this._buildEditPatch();
            await this.api(`/api/keys/${this.editKeyData.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });

            const { ok, data } = await this.api(`/api/keys/${this.editKeyData.id}/validate`, { method: 'POST' });
            this.editKeyTesting = false;

            if (ok && data?.valid) {
                this.showToast(this.t('apiKeyValid'), 'success');
            } else {
                this.showToast(data?.error || this.t('apiKeyInvalid'), 'error');
            }
        },

        // ─── Usage & Costs ────────────────────────────────────────────────
        usageOverview: { today: {}, allTime: {}, keys: {} },
        dailyStats: [],
        dailyDays: 7,
        usageHistory: [],
        providerStats: {},
        modelStats: {},
        accountStats: {},

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

        accountKeyNameMap: {},

        get accountStatsEntries() {
            const entries = Object.entries(this.accountStats)
                .map(([name, s]) => ({ name, displayName: this.accountKeyNameMap[name] || name, ...s }))
                .sort((a, b) => b.requests - a.requests);
            const max = Math.max(1, ...entries.map(e => e.requests));
            return entries.map(e => ({ ...e, pct: (e.requests / max) * 100 }));
        },

        async loadUsageData() {
            const [overviewRes, dailyRes, historyRes, providerRes, modelRes, accountRes, keysRes] = await Promise.all([
                this.api('/api/usage/overview'),
                this.api(`/api/usage/daily?days=${this.dailyDays}`),
                this.api('/api/usage/history?limit=50'),
                this.api('/api/usage/providers'),
                this.api('/api/usage/models'),
                this.api('/api/usage/accounts'),
                this.api('/api/keys')
            ]);
            // Build key ID → display name map
            if (keysRes.ok && keysRes.data?.keys) {
                const map = {};
                for (const key of keysRes.data.keys) {
                    map[key.id] = `${key.id}（${key.name || key.type}）`;
                }
                this.accountKeyNameMap = map;
            }
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
            if (accountRes.ok && accountRes.data?.stats) {
                this.accountStats = accountRes.data.stats;
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

        // ─── Pricing ─────────────────────────────────────────────────────
        pricingSummary: { providers: 0, models: 0, customOverrides: 0, unit: 'USD / 1M tokens' },
        pricingEntries: [],
        pricingFilter: '',
        pricingProviderFilter: '',
        pricingSaving: {},

        get pricingProviders() {
            return [...new Set(this.pricingEntries.map(entry => entry.provider))].sort();
        },

        get filteredPricingEntries() {
            const q = this.pricingFilter.trim().toLowerCase();
            return this.pricingEntries.filter(entry => {
                if (this.pricingProviderFilter && entry.provider !== this.pricingProviderFilter) return false;
                if (!q) return true;
                return entry.provider.toLowerCase().includes(q) || entry.model.toLowerCase().includes(q);
            });
        },

        async loadPricingData() {
            const res = await this.api('/api/pricing');
            if (res.ok && res.data?.success) {
                this.pricingSummary = res.data.summary || this.pricingSummary;
                this.pricingEntries = (res.data.entries || []).map(entry => ({
                    ...entry,
                    form: {
                        input: entry.effective?.input ?? 0,
                        output: entry.effective?.output ?? 0,
                        cacheRead: entry.effective?.cacheRead ?? 0,
                        cacheWrite: entry.effective?.cacheWrite ?? 0
                    }
                }));
            }
        },

        pricingKey(entry) {
            return `${entry.provider}:${entry.model}`;
        },

        async savePricingEntry(entry) {
            const key = this.pricingKey(entry);
            this.pricingSaving[key] = true;
            const payload = {
                provider: entry.provider,
                model: entry.model,
                input: entry.form.input,
                output: entry.form.output,
                cacheRead: entry.form.cacheRead,
                cacheWrite: entry.form.cacheWrite
            };
            const res = await this.api('/api/pricing', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            this.pricingSaving[key] = false;
            if (res.ok && res.data?.success) {
                await this.loadPricingData();
                this.showToast(this.t('pricingSaved'), 'success');
            } else {
                this.showToast(res.data?.error || this.t('pricingSaveFailed'), 'error');
            }
        },

        async resetPricingEntry(entry) {
            const key = this.pricingKey(entry);
            this.pricingSaving[key] = true;
            const res = await this.api('/api/pricing/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider: entry.provider, model: entry.model })
            });
            this.pricingSaving[key] = false;
            if (res.ok && res.data?.success) {
                await this.loadPricingData();
                this.showToast(this.t('pricingReset'), 'success');
            } else {
                this.showToast(res.data?.error || this.t('pricingResetFailed'), 'error');
            }
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
        },

        // ─── Tool Installer ──────────────────────────────────────────────────
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

        async loadToolsStatus() {
            const res = await this.api('/api/tools/status');
            if (res.ok && res.data) {
                this.toolsList = res.data.tools || {};
                this.toolsOS = res.data.os || '';
            }
            // Load node install info if node is not installed
            if (this.toolsList.node && !this.toolsList.node.installed) {
                const infoRes = await this.api('/api/tools/node-info');
                if (infoRes.ok && infoRes.data) {
                    this.nodeInstallInfo = infoRes.data;
                }
            }
            // Async check for updates (fire-and-forget)
            this.checkToolUpdates();
        },

        async installNodeJs() {
            this.toolsInstalling.node = true;
            this.toolsErrors.node = null;
            const res = await this.api('/api/tools/install-node', { method: 'POST' });
            this.toolsInstalling.node = false;
            if (res.ok && res.data?.success) {
                this.showToast('Node.js ' + this.t('installSuccess'), 'success');
                await this.loadToolsStatus();
            } else {
                const errMsg = res.data?.error || this.t('installFailed');
                this.toolsErrors.node = errMsg;
                // If auto-install fails, show instructions
                if (res.data?.command) {
                    this.toolsErrors.node = errMsg + '\n' + this.t('tryManually') + ': ' + res.data.command;
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
                this.showToast((this.toolsList[toolId]?.name || toolId) + ' ' + this.t('installSuccess'), 'success');
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
            return ['claude', 'codex', 'gemini', 'openclaw'].filter(id => this.isUpdateAvailable(id)).length;
        },

        async updateCliTool(toolId) {
            this.toolsUpdating[toolId] = true;
            this.toolsErrors[toolId] = null;
            const res = await this.api(`/api/tools/update/${toolId}`, { method: 'POST' });
            this.toolsUpdating[toolId] = false;
            if (res.ok && res.data?.success) {
                this.showToast((this.toolsList[toolId]?.name || toolId) + ' ' + this.t('updateSuccess'), 'success');
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
    }));
});
