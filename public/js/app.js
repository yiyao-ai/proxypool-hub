document.addEventListener('alpine:init', () => {
    Alpine.data('app', () => ({
        version: '1.0.5',
        connectionStatus: 'connecting',
        activeTab: 'dashboard',
        sidebarOpen: window.innerWidth >= 1024,
        loading: false,
        toast: null,
        currentTime: '',
        
        accounts: [],
        searchQuery: '',
        stats: { total: 0, active: 0, expired: 0, planType: '-' },

        haikuKiloModel: 'minimax/minimax-m2.5:free',
        accountStrategy: 'sticky',
        haikuModelSaving: false,
        strategySaving: false,
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
                this.haikuTestResponse = data?.error?.message || 'Request failed';
            }
        },
        
        configPath: '~/.codex-claude-proxy/accounts.json',
        
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
            this.updateTime();
            setInterval(() => this.updateTime(), 1000);
            this.refreshAccounts();
            this.checkHealth();
            setInterval(() => this.checkHealth(), 30000);
            this.startLogStream();
            this.loadHaikuModelSetting();
            this.loadAccountStrategySetting();
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
            if (deltaSec === 0) return 'Reset due now';

            const days = Math.floor(deltaSec / 86400);
            const hours = Math.floor((deltaSec % 86400) / 3600);
            const minutes = Math.floor((deltaSec % 3600) / 60);

            if (days > 0) return `Resets in ${days}d ${hours}h`;
            if (hours > 0) return `Resets in ${hours}h ${minutes}m`;
            return `Resets in ${minutes}m`;
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
                this.showToast(data?.message || 'Failed to start OAuth', 'error');
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
                this.showToast(data?.message || 'Failed to start OAuth', 'error');
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
                this.showToast(data?.error || 'Failed to add account', 'error');
            }
        },

        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.showToast('Copied to clipboard', 'success');
            } catch (e) {
                this.showToast('Failed to copy', 'error');
            }
        },

        async importFromCodex() {
            const { ok, data } = await this.api('/accounts/import', { method: 'POST' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.showAddModal = false;
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || 'Import failed', 'error');
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
                this.showToast(data?.message || 'Failed to switch', 'error');
            }
        },

        async refreshToken(email) {
            const { ok, data } = await this.api(`/accounts/${encodeURIComponent(email)}/refresh`, { method: 'POST' });
            if (ok && data.success) {
                this.showToast(data.message, 'success');
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || 'Refresh failed', 'error');
            }
        },

        async refreshAllTokens() {
            this.showToast('Refreshing all tokens...', 'info');
            const { ok, data } = await this.api('/accounts/refresh/all', { method: 'POST' });
            if (ok) {
                this.showToast(data.message, 'success');
                this.refreshAccounts();
            } else {
                this.showToast(data?.message || 'Failed', 'error');
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
                this.showToast(data?.message || 'Delete failed', 'error');
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
                this.testResponse = data?.error?.message || 'Request failed';
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
                this.showToast(`Haiku routed to ${data.haikuKiloModel.toUpperCase()}`, 'success');
            } else {
                this.showToast(data?.error || 'Failed to update Haiku model', 'error');
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
                this.showToast(`Account strategy set to ${data.accountStrategy === 'sticky' ? 'Sticky' : 'Round-Robin'}`, 'success');
            } else {
                this.showToast(data?.error || 'Failed to update strategy', 'error');
            }
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
                this.showToast('Updated Claude Code settings.json (API URL + API key).', 'success');
            } else {
                this.showToast(data?.error || error || 'Failed to update Claude Code settings.json', 'error');
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
        }
    }));
});
