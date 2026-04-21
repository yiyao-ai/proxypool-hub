document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({
        version: '1.0.9',
        connectionStatus: 'connecting',
        activeTab: 'dashboard',
        isSmallScreen: window.innerWidth < 1024,
        sidebarOpen: false,
        sidebarCollapsed: localStorage.getItem('proxy-sidebar-collapsed') === 'true' && window.innerWidth >= 1024,
        navSections: {
            main: true,
            api: false,
            system: false
        },
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
        appRoutingTargets: { appIds: [], bindingTypes: [], chatgptAccounts: [], claudeAccounts: [], antigravityAccounts: [], apiKeys: [], localModels: [] },
        appRoutingSaving: {},
        selectedAppRoutingId: '',
        appRoutingForm: { enabled: true, fallbackToDefault: true, bindings: [], currentType: null, currentTargetIds: [], targetQuery: '', targetPickerOpen: false },
        enableFreeModels: true,
        freeModelsSaving: false,
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
        chatStorageKey: 'cligate-chat-sessions-v1',
        chatHistoryOpen: false,
        chatSidebarTab: 'history',
        chatSystemPromptOpen: false,
        chatMode: 'assistant',
        chatAssistantMode: true,
        agentRuntimeProviders: [],
        agentRuntimeSessions: [],
        agentRuntimeSessionsLoading: false,
        chatRuntimeProvider: 'codex',
        chatRuntimeEventSource: null,
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
        
        configPath: '~/.cligate/accounts.json',
        
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

        init() {
            document.documentElement.classList.toggle('light', !this.darkMode);
            document.documentElement.classList.toggle('dark', this.darkMode);
            this.loadNavSections();
            this.syncResponsiveLayout();
            this.ensureActiveNavSection();
            this.updateTime();
            setInterval(() => this.updateTime(), 1000);
            this.refreshAccounts();
            this.refreshClaudeAccounts();
            this.refreshAntigravityAccounts();
            this.checkHealth();
            setInterval(() => this.checkHealth(), 30000);
            setInterval(() => {
                if (this.activeTab === 'chat') {
                    this.loadAgentRuntimeSessions();
                }
            }, 15000);
            setInterval(() => {
                if (this.activeTab === 'conversationRecords') {
                    this.loadChannelConversations({ silent: true });
                    if (this.selectedChannelConversationId) {
                        this.loadChannelConversationDetail(this.selectedChannelConversationId, { silent: true });
                    }
                }
            }, 5000);
            this.startLogStream();
            this.loadHaikuModelSetting();
            this.loadAccountStrategySetting();
            this.loadRoutingPrioritySetting();
            this.loadRoutingModeSetting();
            this.loadAppRoutingSettings();
            this.loadFreeModelsSetting();
            this.loadLocalModelRoutingSetting();
            this.loadLocalRuntimeStatus();
            this.loadKiloModels();
            this.refreshProxyStatus();
            this.loadChatSessions();
            this.loadChatSources();
            this.loadChatModels();
            this.loadAgentRuntimeProviders();
            this.loadAgentRuntimeSessions();
            this.initConfigViewerFromUrl();

            window.addEventListener('resize', () => {
                this.syncResponsiveLayout();
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

        loadNavSections() {
            try {
                const saved = JSON.parse(localStorage.getItem('proxy-nav-sections') || '{}');
                this.navSections = {
                    main: saved.main !== undefined ? !!saved.main : true,
                    api: saved.api !== undefined ? !!saved.api : false,
                    system: saved.system !== undefined ? !!saved.system : false
                };
            } catch {
                this.navSections = { main: true, api: false, system: false };
            }
        },

        saveNavSections() {
            localStorage.setItem('proxy-nav-sections', JSON.stringify(this.navSections));
        },

        sectionForTab(tab) {
            if (['dashboard', 'chat', 'channels', 'conversationRecords', 'accounts'].includes(tab)) return 'main';
            if (['apikeys', 'usage', 'pricing', 'apiExplorer', 'requestLogs'].includes(tab)) return 'api';
            if (['tools', 'localModels', 'logs', 'settings', 'resources'].includes(tab)) return 'system';
            return 'main';
        },

        isSectionExpanded(section) {
            return this.sidebarCollapsed || !!this.navSections[section];
        },

        toggleNavSection(section) {
            this.navSections[section] = !this.navSections[section];
            this.saveNavSections();
        },

        ensureActiveNavSection() {
            const section = this.sectionForTab(this.activeTab);
            if (!this.navSections[section]) {
                this.navSections[section] = true;
                this.saveNavSections();
            }
        },

        syncResponsiveLayout() {
            this.isSmallScreen = window.innerWidth < 1024;
            if (this.isSmallScreen) {
                this.sidebarOpen = false;
                return;
            }
            this.sidebarOpen = false;
            this.sidebarCollapsed = localStorage.getItem('proxy-sidebar-collapsed') === 'true';
        },

        toggleSidebar() {
            if (this.isSmallScreen) {
                this.sidebarOpen = !this.sidebarOpen;
                return;
            }
            this.sidebarCollapsed = !this.sidebarCollapsed;
            localStorage.setItem('proxy-sidebar-collapsed', this.sidebarCollapsed);
        },

        setActiveTab(tab) {
            this.activeTab = tab;
            this.ensureActiveNavSection();
            if (this.isSmallScreen) {
                this.sidebarOpen = false;
            }
            if (tab === 'accounts') { this.refreshAccounts(); this.refreshClaudeAccounts(); this.refreshAntigravityAccounts(); }
            if (tab === 'apikeys') this.loadApiKeys();
            if (tab === 'usage') this.loadUsageData();
            if (tab === 'pricing') this.loadPricingData();
            if (tab === 'apiExplorer' && !this.apiExplorerResponse) this.loadApiExplorerPreset(this.apiExplorerPresetIndex);
            if (tab === 'dashboard') this.refreshProxyStatus();
            if (tab === 'localModels') this.loadLocalRuntimeStatus();
            if (tab === 'chat') {
                this.loadChatSources();
                this.loadChatModels();
                this.loadAgentRuntimeProviders();
                this.loadAgentRuntimeSessions();
            }
            if (tab === 'channels') {
                this.loadChannelProviders();
                this.loadChannelCatalog();
                this.loadChannelSettings();
            }
            if (tab === 'conversationRecords') {
                this.loadChannelProviders();
                this.loadChannelCatalog();
                this.loadChannelConversations().then(() => {
                    if (this.selectedChannelConversationId) {
                        this.loadChannelConversationDetail(this.selectedChannelConversationId, { silent: true });
                    }
                });
            }
            if (tab === 'settings') {
                if (!this.modelMappingData) this.loadModelMappings();
                this.refreshProxyStatus();
                this.loadLocalModelRoutingSetting();
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

        async loadAgentRuntimeProviders() {
            const { ok, data } = await this.api('/api/agent-runtimes/providers');
            if (!ok || !Array.isArray(data?.providers)) return;

            this.agentRuntimeProviders = data.providers;
            if (!this.chatRuntimeProvider || !this.agentRuntimeProviders.some((provider) => provider.id === this.chatRuntimeProvider)) {
                this.chatRuntimeProvider = this.agentRuntimeProviders[0]?.id || 'codex';
                this.syncActiveChatSession();
            }
        },

        async loadAgentRuntimeSessions() {
            this.agentRuntimeSessionsLoading = true;
            const { ok, data } = await this.api('/api/agent-runtimes/sessions?limit=40');
            if (ok && Array.isArray(data?.sessions)) {
                this.agentRuntimeSessions = data.sessions;
                for (const runtimeSession of data.sessions) {
                    const localSession = this.findLocalChatSessionByRuntimeId(runtimeSession.id);
                    if (!localSession) continue;
                    localSession.runtimeStatus = runtimeSession.status || localSession.runtimeStatus || '';
                    localSession.title = runtimeSession.title || localSession.title || this.t('newChat');
                    localSession.model = runtimeSession.model || localSession.model || '';
                    localSession.attachedRuntimeProvider = runtimeSession.provider || localSession.attachedRuntimeProvider || '';
                    localSession.attachedRuntimeModel = runtimeSession.model || localSession.attachedRuntimeModel || '';
                    localSession.updatedAt = runtimeSession.updatedAt || localSession.updatedAt;
                }
                this.persistChatSessions();
            }
            this.agentRuntimeSessionsLoading = false;
        },

        chatModeLabel(mode) {
            if (mode === 'agent-runtime') return this.t('chatModeAgent');
            return this.t('chatModeAssistant');
        },

        chatRuntimeProviderLabel(providerId) {
            if (!providerId) return '';
            const provider = this.agentRuntimeProviders.find((item) => item.id === providerId);
            return provider?.label || provider?.name || providerId;
        },

        agentRuntimeStatusPillClass(status) {
            if (status === 'running') return 'bg-cyan-500/10 text-cyan-300 border-cyan-500/30';
            if (status === 'waiting_user') return 'bg-blue-500/10 text-blue-300 border-blue-500/30';
            if (status === 'waiting_approval') return 'bg-amber-500/10 text-amber-300 border-amber-500/30';
            if (status === 'ready') return 'bg-green-500/10 text-green-300 border-green-500/30';
            if (status === 'failed') return 'bg-red-500/10 text-red-300 border-red-500/30';
            if (status === 'cancelled') return 'bg-gray-500/10 text-gray-300 border-gray-500/30';
            return 'bg-space-800 text-gray-300 border-space-border/40';
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
                .map(section => ({
                    section,
                    fields: fields.filter(field => (field?.section || 'advanced') === section)
                }))
                .filter(group => group.fields.length > 0);
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
            if (instance?.enabled === true) {
                parts.push(this.t('channelStatusEnabled'));
            } else {
                parts.push(this.t('channelStatusDisabled'));
            }
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

        formatRelativeTime(value) {
            if (!value) return '-';
            const time = new Date(value).getTime();
            if (!Number.isFinite(time)) return '-';
            const diffMs = Date.now() - time;
            const diffMin = Math.max(0, Math.floor(diffMs / 60000));
            if (diffMin < 1) return this.t('justNow');
            if (diffMin < 60) return this.t('minutesAgo', diffMin);
            const diffHour = Math.floor(diffMin / 60);
            if (diffHour < 24) return this.t('hoursAgo', diffHour);
            const diffDay = Math.floor(diffHour / 24);
            return this.t('daysAgo', diffDay);
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
                mode: this.chatMode || 'assistant',
                sourceId: this.chatSourceId || this.chatSources[0]?.id || '',
                runtimeProvider: this.chatRuntimeProvider || 'codex',
                runtimeSessionId: '',
                attachedRuntimeProvider: '',
                attachedRuntimeModel: '',
                runtimeStatus: '',
                runtimeLastEventSeq: 0,
                runtimePendingQuestion: null,
                runtimePendingApprovals: [],
                runtimeUnread: false,
                model: this.chatModel || 'gpt-5.2',
                assistantMode: this.chatAssistantMode === true,
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

            this.closeAgentRuntimeStream();
            this.activeChatSessionId = session.id;
            this.chatMode = session.mode || 'assistant';
            this.chatSourceId = session.sourceId || this.chatSources[0]?.id || '';
            this.chatRuntimeProvider = session.runtimeProvider || 'codex';
            this.chatModel = session.model || 'gpt-5.2';
            this.chatAssistantMode = session.assistantMode !== false;
            this.chatSystemPrompt = session.systemPrompt || '';
            this.chatMessages = Array.isArray(session.messages) ? session.messages : [];
            this.chatInput = '';
            session.runtimeLastEventSeq = Number(session.runtimeLastEventSeq || 0);
            session.runtimeUnread = false;
            if (!Array.isArray(session.runtimePendingApprovals)) {
                session.runtimePendingApprovals = [];
            }
            if (window.innerWidth < 1280) {
                this.chatHistoryOpen = false;
            }
            this.scrollChatToBottom();
            if (this.chatMode === 'agent-runtime' && session.runtimeSessionId) {
                this.connectAgentRuntimeStream(session);
            }
        },

        shouldStickChatToBottom(threshold = 96) {
            const container = this.$refs?.chatMessagesContainer;
            if (!container) return true;
            const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
            return distanceToBottom <= threshold;
        },

        scrollChatToBottom(force = false) {
            const container = this.$refs?.chatMessagesContainer;
            if (!container) return;
            if (!force && !this.shouldStickChatToBottom()) return;
            requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
            });
        },

        getActiveChatSession() {
            return this.chatSessions.find((item) => item.id === this.activeChatSessionId) || null;
        },

        closeAgentRuntimeStream() {
            if (this.chatRuntimeEventSource) {
                this.chatRuntimeEventSource.close();
                this.chatRuntimeEventSource = null;
            }
        },

        connectAgentRuntimeStream(session) {
            if (!session?.runtimeSessionId) return;

            const isCurrentSession = session.id === this.activeChatSessionId;
            if (!isCurrentSession) return;

            this.closeAgentRuntimeStream();

            const afterSeq = Number(session.runtimeLastEventSeq || 0);
            const url = `/api/agent-runtimes/sessions/${encodeURIComponent(session.runtimeSessionId)}/stream?history=true&afterSeq=${afterSeq}`;
            const source = new EventSource(url);
            this.chatRuntimeEventSource = source;

            source.onmessage = (event) => {
                let payload = null;
                try {
                    payload = JSON.parse(event.data);
                } catch {
                    return;
                }
                this.applyAgentRuntimeEvent(session.id, payload);
            };

            source.onerror = () => {
                const active = this.getActiveChatSession();
                if (!active || active.id !== session.id) {
                    this.closeAgentRuntimeStream();
                }
            };
        },

        ensureAgentRuntimeSessionDefaults(session) {
            if (!session) return;
            session.runtimeProvider = session.runtimeProvider || this.chatRuntimeProvider || 'codex';
            session.runtimeSessionId = session.runtimeSessionId || '';
            session.attachedRuntimeProvider = session.attachedRuntimeProvider || '';
            session.attachedRuntimeModel = session.attachedRuntimeModel || '';
            session.runtimeStatus = session.runtimeStatus || '';
            session.runtimeLastEventSeq = Number(session.runtimeLastEventSeq || 0);
            session.runtimePendingQuestion = session.runtimePendingQuestion || null;
            session.runtimeUnread = session.runtimeUnread === true;
            if (!Array.isArray(session.runtimePendingApprovals)) {
                session.runtimePendingApprovals = [];
            }
        },

        appendAgentRuntimeMessage(sessionId, message) {
            const session = this.chatSessions.find((item) => item.id === sessionId);
            if (!session) return;

            const nextMessage = {
                role: 'assistant',
                kind: 'agent-message',
                ...message
            };
            session.messages = [...(session.messages || []), nextMessage];
            if (session.id === this.activeChatSessionId) {
                this.chatMessages = [...session.messages];
                this.scrollChatToBottom(true);
            }
        },

        updateAgentRuntimeMessage(sessionId, predicate, updater) {
            const session = this.chatSessions.find((item) => item.id === sessionId);
            if (!session || !Array.isArray(session.messages)) return false;

            const index = session.messages.findIndex(predicate);
            if (index < 0) return false;
            session.messages[index] = updater({ ...session.messages[index] });
            if (session.id === this.activeChatSessionId) {
                this.chatMessages = [...session.messages];
            }
            return true;
        },

        activeRuntimeSessionBadge(session = this.getActiveChatSession()) {
            if (!session?.runtimeSessionId) {
                return this.t('agentRuntimeNoAttachedSession');
            }
            return `${this.t('agentRuntimeSessionShort')} ${String(session.runtimeSessionId).slice(0, 8)}`;
        },

        runtimeSessionConfigChanged(session) {
            if (!session?.runtimeSessionId) return false;
            const selectedProvider = String(this.chatRuntimeProvider || session.runtimeProvider || 'codex').trim();
            const selectedModel = String(this.chatModel || session.model || '').trim();
            const attachedProvider = String(session.attachedRuntimeProvider || '').trim();
            const attachedModel = String(session.attachedRuntimeModel || '').trim();

            if (attachedProvider && selectedProvider && attachedProvider !== selectedProvider) {
                return true;
            }

            return attachedModel !== selectedModel;
        },

        buildRuntimeSessionRestartNotice(session) {
            const reasons = [];
            const selectedProvider = String(this.chatRuntimeProvider || session?.runtimeProvider || 'codex').trim();
            const selectedModel = String(this.chatModel || session?.model || '').trim();
            const attachedProvider = String(session?.attachedRuntimeProvider || '').trim();
            const attachedModel = String(session?.attachedRuntimeModel || '').trim();

            if (attachedProvider && selectedProvider && attachedProvider !== selectedProvider) {
                reasons.push(this.t('agentRuntimeProviderChanged'));
            }
            if (attachedModel !== selectedModel) {
                reasons.push(this.t('agentRuntimeModelChanged'));
            }

            const detail = reasons.length > 0
                ? `${this.t('agentRuntimeStartedFreshBecause')} ${reasons.join(', ')}.`
                : this.t('agentRuntimeDetachedNotice');

            return `${this.t('agentRuntimeFreshSessionReady')} ${detail}`;
        },

        resetActiveRuntimeBinding({ mode = 'agent-runtime', notice = '' } = {}) {
            const session = this.getActiveChatSession();
            if (!session) return;

            this.ensureAgentRuntimeSessionDefaults(session);

            if (session.id === this.activeChatSessionId) {
                this.closeAgentRuntimeStream();
            }

            session.mode = mode;
            session.runtimeSessionId = '';
            session.attachedRuntimeProvider = '';
            session.attachedRuntimeModel = '';
            session.runtimeStatus = '';
            session.runtimeLastEventSeq = 0;
            session.runtimePendingQuestion = null;
            session.runtimePendingApprovals = [];
            session.runtimeUnread = false;

            if (notice) {
                this.appendAgentRuntimeMessage(session.id, {
                    kind: 'agent-status',
                    content: notice
                });
            }

            this.syncActiveChatSession();
        },

        startFreshAgentRuntimeSession() {
            this.resetActiveRuntimeBinding({
                mode: 'agent-runtime',
                notice: this.t('agentRuntimeFreshSessionReady')
            });
        },

        detachAgentRuntimeSession() {
            const session = this.getActiveChatSession();
            if (!session?.runtimeSessionId) return;
            this.resetActiveRuntimeBinding({
                mode: 'agent-runtime',
                notice: this.t('agentRuntimeDetachedNotice')
            });
        },

        applyAgentRuntimeEvent(chatSessionId, event) {
            const session = this.chatSessions.find((item) => item.id === chatSessionId);
            if (!session || !event) return;

            this.ensureAgentRuntimeSessionDefaults(session);
            const seq = Number(event.seq || 0);
            if (seq && seq <= Number(session.runtimeLastEventSeq || 0)) {
                return;
            }
            if (seq) {
                session.runtimeLastEventSeq = seq;
            }

            const payload = event.payload || {};
            const isActiveSession = session.id === this.activeChatSessionId;
            const isForegroundSession = isActiveSession && this.activeTab === 'chat';
            if (event.type === 'worker.started') {
                session.runtimeStatus = 'running';
            } else if (event.type === 'worker.message') {
                this.appendAgentRuntimeMessage(chatSessionId, {
                    content: payload.text || '',
                    itemType: payload.itemType || 'assistant'
                });
            } else if (event.type === 'worker.command') {
                this.appendAgentRuntimeMessage(chatSessionId, {
                    kind: 'agent-command',
                    content: payload.command || '',
                    commandOutput: payload.output || '',
                    commandStatus: payload.status || '',
                    exitCode: payload.exitCode
                });
            } else if (event.type === 'worker.file_change') {
                const changes = Array.isArray(payload.changes) ? payload.changes : [];
                this.appendAgentRuntimeMessage(chatSessionId, {
                    kind: 'agent-file-change',
                    content: changes.join('\n') || this.t('agentRuntimeFilesChanged'),
                    fileChangeStatus: payload.status || ''
                });
            } else if (event.type === 'worker.question') {
                session.runtimeStatus = 'waiting_user';
                session.runtimePendingQuestion = payload;
                if (!isForegroundSession) {
                    session.runtimeUnread = true;
                    this.showToast(this.t('agentRuntimeQuestionToast', this.chatSessionTitle(session)), 'warning');
                }
                this.appendAgentRuntimeMessage(chatSessionId, {
                    kind: 'agent-question',
                    content: payload.text || this.t('agentRuntimeQuestion'),
                    questionId: payload.questionId,
                    questionStatus: payload.status || 'pending'
                });
            } else if (event.type === 'worker.approval_request') {
                session.runtimeStatus = 'waiting_approval';
                session.runtimePendingApprovals = [...session.runtimePendingApprovals, payload];
                if (!isForegroundSession) {
                    session.runtimeUnread = true;
                    this.showToast(this.t('agentRuntimeApprovalToast', this.chatSessionTitle(session)), 'warning');
                }
                this.appendAgentRuntimeMessage(chatSessionId, {
                    kind: 'agent-approval',
                    content: payload.title || this.t('agentRuntimeApproval'),
                    approvalId: payload.approvalId,
                    approvalSummary: payload.summary || '',
                    approvalStatus: payload.status || 'pending'
                });
            } else if (event.type === 'worker.approval_resolved') {
                const approvalId = payload.approvalId;
                session.runtimePendingApprovals = session.runtimePendingApprovals.filter((item) => item.approvalId !== approvalId);
                session.runtimeStatus = session.runtimePendingApprovals.length > 0
                    ? 'waiting_approval'
                    : (session.runtimePendingQuestion ? 'waiting_user' : 'running');
                this.updateAgentRuntimeMessage(
                    chatSessionId,
                    (message) => message.kind === 'agent-approval' && message.approvalId === approvalId,
                    (message) => ({
                        ...message,
                        approvalStatus: payload.decision || 'resolved'
                    })
                );
            } else if (event.type === 'worker.completed') {
                session.runtimeStatus = 'ready';
                session.runtimePendingQuestion = null;
                session.runtimePendingApprovals = [];
                if (!isForegroundSession) {
                    session.runtimeUnread = true;
                    this.showToast(this.t('agentRuntimeCompletedToast', this.chatSessionTitle(session)), 'success');
                }
                if (isActiveSession) {
                    this.closeAgentRuntimeStream();
                }
                this.appendAgentRuntimeMessage(chatSessionId, {
                    kind: 'agent-status',
                    content: this.t('agentRuntimeCompleted')
                });
            } else if (event.type === 'worker.failed') {
                session.runtimeStatus = 'failed';
                if (!isForegroundSession) {
                    session.runtimeUnread = true;
                    this.showToast(this.t('agentRuntimeFailedToast', this.chatSessionTitle(session)), 'error');
                }
                if (isActiveSession) {
                    this.closeAgentRuntimeStream();
                }
                this.appendAgentRuntimeMessage(chatSessionId, {
                    kind: 'agent-status',
                    content: payload.message || this.t('requestFailed'),
                    isError: true
                });
            }

            this.syncActiveChatSession();
        },

        chatSendDisabled() {
            if (this.chatLoading) return true;
            if (this.chatMode === 'assistant') {
                return !this.chatSourceId;
            }
            const session = this.getActiveChatSession();
            if (session?.runtimePendingApprovals?.length) {
                return true;
            }
            return !this.chatRuntimeProvider;
        },

        syncActiveChatSession() {
            const session = this.chatSessions.find((item) => item.id === this.activeChatSessionId);
            if (!session) return;

            session.mode = this.chatMode || 'assistant';
            session.sourceId = this.chatSourceId || '';
            session.runtimeProvider = this.chatRuntimeProvider || 'codex';
            session.model = this.chatModel || 'gpt-5.2';
            session.assistantMode = this.chatAssistantMode === true;
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

            if (this.activeChatSessionId === sessionId) {
                this.closeAgentRuntimeStream();
            }
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
            if (this.chatLoading || !this.chatInput.trim()) return;
            if (this.chatMode === 'agent-runtime') {
                await this.sendAgentRuntimeMessage();
                return;
            }
            if (!this.chatSourceId) return;

            const shouldAutoScroll = this.shouldStickChatToBottom();

            const userMessage = {
                role: 'user',
                content: this.chatInput.trim()
            };

            this.chatMessages.push(userMessage);
            this.chatInput = '';
            this.syncActiveChatSession();
            this.chatLoading = true;
            this.scrollChatToBottom(shouldAutoScroll);

            const assistantMessage = {
                role: 'assistant',
                content: '',
                usage: null,
                model: this.chatModel.trim() || 'gpt-5.2',
                mappedModel: null,
                sourceLabel: this.chatSourceLabel(this.chatSourceId),
                citations: [],
                pendingAction: null,
                _confirming: false
            };
            this.chatMessages.push(assistantMessage);
            this.syncActiveChatSession();
            this.scrollChatToBottom(true);

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
                        messages: requestMessages,
                        assistantMode: this.chatAssistantMode === true,
                        uiLang: this.lang
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

        async sendAgentRuntimeMessage() {
            const input = this.chatInput.trim();
            const session = this.getActiveChatSession();
            if (!input || !session) return;

            this.ensureAgentRuntimeSessionDefaults(session);
            if (session.runtimePendingApprovals.length > 0) {
                this.showToast(this.t('agentRuntimeApprovalPending'), 'warning');
                return;
            }

            const shouldAutoScroll = this.shouldStickChatToBottom();
            this.chatMessages.push({
                role: 'user',
                content: input
            });
            this.chatInput = '';
            this.chatLoading = true;
            this.syncActiveChatSession();
            this.scrollChatToBottom(shouldAutoScroll);

            try {
                if (this.runtimeSessionConfigChanged(session)) {
                    this.resetActiveRuntimeBinding({
                        mode: 'agent-runtime',
                        notice: this.buildRuntimeSessionRestartNotice(session)
                    });
                }

                const pendingQuestionId = session.runtimePendingQuestion?.questionId || null;
                const { ok, data, error } = await this.api('/api/chat/agent-message', {
                    method: 'POST',
                    body: JSON.stringify({
                        sessionId: session.id,
                        input,
                        provider: this.chatRuntimeProvider,
                        model: this.chatModel.trim() || ''
                    })
                });
                const result = data?.result;
                if (!ok || !result) {
                    throw new Error(data?.error || error || this.t('requestFailed'));
                }

                if (result.type === 'question_answered' && pendingQuestionId) {
                    this.updateAgentRuntimeMessage(
                        session.id,
                        (message) => message.kind === 'agent-question' && message.questionId === pendingQuestionId,
                        (message) => ({
                            ...message,
                            questionStatus: result?.question?.status || 'answered'
                        })
                    );
                    session.runtimePendingQuestion = null;
                    session.runtimeStatus = 'running';
                }

                if (result.type === 'command_error' || result.type === 'supervisor_status' || result.type === 'preference_saved') {
                    this.appendAgentRuntimeMessage(session.id, {
                        kind: 'agent-status',
                        content: result.message || this.t('requestFailed'),
                        isError: result.type === 'command_error'
                    });
                    if (result.type === 'command_error') {
                        this.showToast(result.message || this.t('requestFailed'), 'warning');
                    }
                }

                if (result.type === 'conversation_reset') {
                    session.runtimeSessionId = null;
                    session.runtimeStatus = 'ready';
                    session.runtimePendingApprovals = [];
                    session.runtimePendingQuestion = null;
                    if (result.message) {
                        this.appendAgentRuntimeMessage(session.id, {
                            kind: 'agent-status',
                            content: result.message,
                            isError: false
                        });
                    }
                }

                if (result.type === 'approval_resolved' && session.runtimePendingApprovals.length > 0) {
                    session.runtimePendingApprovals = [];
                    session.runtimeStatus = session.runtimePendingQuestion ? 'waiting_user' : 'running';
                    if (result.message) {
                        this.appendAgentRuntimeMessage(session.id, {
                            kind: 'agent-status',
                            content: result.message,
                            isError: false
                        });
                    }
                }

                if (result.session?.id) {
                    session.runtimeSessionId = result.session.id;
                    session.runtimeProvider = result.session.provider || this.chatRuntimeProvider;
                    session.attachedRuntimeProvider = result.session.provider || this.chatRuntimeProvider;
                    session.attachedRuntimeModel = result.session.model || (this.chatModel.trim() || '');
                    session.runtimeStatus = result.session.status || 'running';
                    session.model = this.chatModel.trim() || session.model;
                    if (result.message && (result.type === 'runtime_started' || result.type === 'runtime_continued')) {
                        this.appendAgentRuntimeMessage(session.id, {
                            kind: 'agent-status',
                            content: result.message,
                            isError: false
                        });
                    }
                    this.connectAgentRuntimeStream(session);
                }
            } catch (error) {
                this.appendAgentRuntimeMessage(session.id, {
                    kind: 'agent-status',
                    content: error.message || this.t('requestFailed'),
                    isError: true
                });
                this.showToast(error.message || this.t('requestFailed'), 'error');
            } finally {
                this.chatLoading = false;
                this.loadAgentRuntimeSessions();
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
            let stickToBottom = true;

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
                        assistantMessage.citations = Array.isArray(payload.assistant?.citations) ? payload.assistant.citations : [];
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
                        assistantMessage.citations = Array.isArray(payload.citations) ? payload.citations : assistantMessage.citations;
                        needsUpdate = true;
                    } else if (payload.type === 'action_confirmation') {
                        assistantMessage.pendingAction = payload.pendingAction || null;
                        assistantMessage._confirming = false;
                        needsUpdate = true;
                    } else if (payload.type === 'error') {
                        assistantMessage.content = payload.error || this.t('requestFailed');
                        assistantMessage.isError = true;
                        throw new Error(assistantMessage.content);
                    }
                }

                if (needsUpdate && msgIndex >= 0) {
                    stickToBottom = this.shouldStickChatToBottom();
                    // Replace the message object to trigger Alpine.js reactivity
                    this.chatMessages[msgIndex] = { ...assistantMessage };
                    this.chatMessages = [...this.chatMessages];
                    this.scrollChatToBottom(stickToBottom);
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
                    messages: requestMessages,
                    assistantMode: this.chatAssistantMode === true,
                    uiLang: this.lang
                })
            });

            if (ok && data?.reply) {
                assistantMessage.content = data.reply.content || '';
                assistantMessage.usage = data.reply.usage || null;
                assistantMessage.model = data.model || assistantMessage.model;
                assistantMessage.mappedModel = data.mappedModel || null;
                assistantMessage.sourceLabel = data.source?.label || assistantMessage.sourceLabel;
                assistantMessage.citations = Array.isArray(data.reply.citations) ? data.reply.citations : [];
                assistantMessage.pendingAction = data.reply.pendingAction || null;
                assistantMessage._confirming = false;
                assistantMessage.isError = false;
                this.chatMessages = [...this.chatMessages];
                this.scrollChatToBottom(true);
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

        agentRuntimeStatusLabel(session = this.getActiveChatSession()) {
            const status = session?.runtimeStatus || '';
            if (status === 'running') return this.t('agentRuntimeStatusRunning');
            if (status === 'waiting_user') return this.t('agentRuntimeStatusWaitingUser');
            if (status === 'waiting_approval') return this.t('agentRuntimeStatusWaitingApproval');
            if (status === 'ready') return this.t('agentRuntimeStatusReady');
            if (status === 'failed') return this.t('failedLabel');
            return this.t('agentRuntimeStatusIdle');
        },

        async respondAgentRuntimeApproval(message, decision) {
            const session = this.getActiveChatSession();
            if (!session?.runtimeSessionId || !message?.approvalId) return;

            message._approving = true;
            this.chatMessages = [...this.chatMessages];

            const { ok, data, error } = await this.api(`/api/agent-runtimes/sessions/${encodeURIComponent(session.runtimeSessionId)}/approval`, {
                method: 'POST',
                body: JSON.stringify({
                    approvalId: message.approvalId,
                    decision
                })
            });

            message._approving = false;
            if (ok && data?.approval) {
                message.approvalStatus = data.approval.status || decision;
                session.runtimePendingApprovals = session.runtimePendingApprovals.filter((item) => item.approvalId !== message.approvalId);
                session.runtimeStatus = session.runtimePendingApprovals.length > 0
                    ? 'waiting_approval'
                    : (session.runtimePendingQuestion ? 'waiting_user' : 'running');
                this.chatMessages = [...this.chatMessages];
                this.syncActiveChatSession();
                this.loadAgentRuntimeSessions();
                return;
            }

            this.showToast(data?.error || error || this.t('requestFailed'), 'error');
            this.chatMessages = [...this.chatMessages];
        },

        openChatSidebar(tab = 'history') {
            this.chatSidebarTab = tab;
            this.chatHistoryOpen = true;
            if (tab === 'runtime') {
                this.loadAgentRuntimeSessions();
            }
        },

        findLocalChatSessionByRuntimeId(runtimeSessionId) {
            return this.chatSessions.find((item) => item.runtimeSessionId === runtimeSessionId) || null;
        },

        ensureChatSessionForRuntime(runtimeSession) {
            const existing = this.findLocalChatSessionByRuntimeId(runtimeSession.id);
            if (existing) {
                existing.mode = 'agent-runtime';
                existing.runtimeProvider = runtimeSession.provider;
                existing.runtimeStatus = runtimeSession.status || existing.runtimeStatus || '';
                existing.model = runtimeSession.model || existing.model || '';
                existing.attachedRuntimeProvider = runtimeSession.provider || existing.attachedRuntimeProvider || '';
                existing.attachedRuntimeModel = runtimeSession.model || existing.attachedRuntimeModel || '';
                existing.title = runtimeSession.title || existing.title || this.chatSessionTitle(existing);
                return existing;
            }

            const sessionId = 'chat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const next = {
                id: sessionId,
                title: runtimeSession.title || this.t('newChat'),
                mode: 'agent-runtime',
                sourceId: '',
                runtimeProvider: runtimeSession.provider || 'codex',
                runtimeSessionId: runtimeSession.id,
                attachedRuntimeProvider: runtimeSession.provider || 'codex',
                attachedRuntimeModel: runtimeSession.model || '',
                runtimeStatus: runtimeSession.status || '',
                runtimeLastEventSeq: 0,
                runtimePendingQuestion: null,
                runtimePendingApprovals: [],
                runtimeUnread: false,
                model: runtimeSession.model || '',
                assistantMode: true,
                systemPrompt: '',
                messages: [],
                updatedAt: runtimeSession.updatedAt || new Date().toISOString()
            };
            this.chatSessions.unshift(next);
            this.persistChatSessions();
            return next;
        },

        openAgentRuntimeMonitorSession(runtimeSession) {
            if (!runtimeSession?.id) return;
            const session = this.ensureChatSessionForRuntime(runtimeSession);
            this.openChatSession(session.id);
            this.chatHistoryOpen = false;
        },

        async cancelAgentRuntimeTask(runtimeSessionId) {
            if (!runtimeSessionId) return;
            const { ok, data, error } = await this.api(`/api/agent-runtimes/sessions/${encodeURIComponent(runtimeSessionId)}/cancel`, {
                method: 'POST'
            });

            if (!ok) {
                this.showToast(data?.error || error || this.t('requestFailed'), 'error');
                return;
            }

            const localSession = this.findLocalChatSessionByRuntimeId(runtimeSessionId);
            if (localSession) {
                localSession.runtimeStatus = data?.session?.status || 'cancelled';
                this.syncActiveChatSession();
            }
            await this.loadAgentRuntimeSessions();
            this.showToast(this.t('agentRuntimeCancelled'), 'success');
        },

        formatChatCitation(citation) {
            if (!citation) return '';
            if (Array.isArray(citation.titlePath) && citation.titlePath.length > 0) {
                return citation.titlePath.join(' / ');
            }
            return citation.title || '';
        },

        async confirmChatPendingAction(message) {
            if (!message?.pendingAction?.confirmToken || message._confirming) return;

            message._confirming = true;
            this.chatMessages = [...this.chatMessages];

            const { ok, data, error } = await this.api('/api/chat/tool-confirm', {
                method: 'POST',
                body: JSON.stringify({
                    confirmToken: message.pendingAction.confirmToken
                })
            });

            message._confirming = false;

            if (ok && data?.success) {
                const suffix = data.configPath ? `\n${data.configPath}` : '';
                message.content = `${message.content}\n\n${data.result || ''}${suffix}`.trim();
                message.pendingAction = null;
                this.chatMessages = [...this.chatMessages];
                this.syncActiveChatSession();
                this.scrollChatToBottom(true);
                return;
            }

            const errorMessage = data?.error || error || this.t('requestFailed');
            this.showToast(errorMessage, 'error');
            this.chatMessages = [...this.chatMessages];
        },

        dismissChatPendingAction(message) {
            if (!message) return;
            message.pendingAction = null;
            this.chatMessages = [...this.chatMessages];
            this.syncActiveChatSession();
            this.scrollChatToBottom(true);
        },

        toggleChatHistory() {
            if (this.chatHistoryOpen && this.chatSidebarTab === 'history') {
                this.chatHistoryOpen = false;
                return;
            }
            this.openChatSidebar('history');
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
                this.channelConversationMessages = Array.isArray(data.deliveries)
                    ? data.deliveries
                    : [];
            }
            if (!options.silent) {
                this.channelConversationLoading = false;
            }
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
            if (state === 'pending') {
                return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
            }
            if (state === 'waiting_approval') {
                return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400';
            }
            if (state === 'waiting_user') {
                return 'border-blue-500/30 bg-blue-500/10 text-blue-400';
            }
            if (state === 'active') {
                return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
            }
            if (state === 'failed') {
                return 'border-red-500/30 bg-red-500/10 text-red-300';
            }
            if (state === 'completed') {
                return 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan';
            }
            return 'border-space-border/40 bg-space-900/70 text-gray-400';
        },

        channelMessageRoleLabel(record) {
            return record?.direction === 'inbound'
                ? this.t('you')
                : this.t('assistant');
        },

        channelMessageBubbleClass(record) {
            if (record?.direction === 'inbound') {
                return 'bg-neon-cyan/15 border-neon-cyan/30 text-white';
            }
            if (record?.status === 'failed') {
                return 'bg-red-500/10 border-red-500/30 text-red-200';
            }
            return 'bg-space-800/70 border-space-border/40 text-gray-100';
        },

        channelMessageText(record) {
            if (!record) return '';
            const payload = record.payload || {};
            if (record.direction === 'inbound') {
                return payload.text || '';
            }
            return payload.text || payload.summary || '';
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
            const payload = { ...target };
            const { ok, data } = await this.api(`/api/agent-channels/settings/${encodeURIComponent(channelId)}/${encodeURIComponent(instanceId)}`, {
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
                this.showToast(data?.error || this.t('channelSettingsSaveFailed', channelId), 'error');
            }
            this.channelSettingsSaving[saveKey] = false;
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
