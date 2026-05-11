import { i18n } from '../i18n.js';

export function createAccountsPageModule() {
  return {
    accounts: [],
    accountSubTab: 'chatgpt',
    accountSearchQuery: '',
    stats: { total: 0, available: 0, expired: 0, planType: '-' },
    claudeAccounts: [],
    antigravityAccounts: [],
    selectedChatgptAccounts: [],
    selectedClaudeAccounts: [],
    selectedAntigravityAccounts: [],
    showClaudeUsageModal: false,
    selectedClaudeAccount: null,
    claudeUsageRefreshing: false,
    showAntigravityQuotaModal: false,
    selectedAntigravityAccount: null,
    antigravityQuotaRefreshing: false,
    showAddModal: false,
    showDeleteModal: false,
    deleteMode: 'single',
    deleteAccountType: 'chatgpt',
    deleteTarget: '',
    deleteTargets: [],
    deleteInProgress: false,
    showQuotaModalView: false,
    selectedAccount: null,
    oauthManualMode: false,
    oauthManualUrl: '',
    oauthManualVerifier: '',
    oauthManualCode: '',
    testPrompt: 'Say hello',
    testResponse: '',
    testing: false,

    get filteredAccounts() {
      if (!this.accountSearchQuery) return this.accounts;
      const q = this.accountSearchQuery.toLowerCase();
      return this.accounts.filter((a) => a.email.toLowerCase().includes(q));
    },

    get filteredClaudeAccounts() {
      if (!this.accountSearchQuery) return this.claudeAccounts;
      const q = this.accountSearchQuery.toLowerCase();
      return this.claudeAccounts.filter((a) => a.email.toLowerCase().includes(q) || (a.displayName || '').toLowerCase().includes(q));
    },

    get filteredAntigravityAccounts() {
      if (!this.accountSearchQuery) return this.antigravityAccounts;
      const q = this.accountSearchQuery.toLowerCase();
      return this.antigravityAccounts.filter((a) => a.email.toLowerCase().includes(q) || (a.displayName || '').toLowerCase().includes(q));
    },

    accountItemsByType(type) {
      if (type === 'claude') return this.claudeAccounts;
      if (type === 'antigravity') return this.antigravityAccounts;
      return this.accounts;
    },

    filteredAccountItemsByType(type) {
      if (type === 'claude') return this.filteredClaudeAccounts;
      if (type === 'antigravity') return this.filteredAntigravityAccounts;
      return this.filteredAccounts;
    },

    selectedAccountEmailsByType(type) {
      if (type === 'claude') return this.selectedClaudeAccounts;
      if (type === 'antigravity') return this.selectedAntigravityAccounts;
      return this.selectedChatgptAccounts;
    },

    setSelectedAccountEmailsByType(type, emails) {
      if (type === 'claude') {
        this.selectedClaudeAccounts = emails;
        return;
      }
      if (type === 'antigravity') {
        this.selectedAntigravityAccounts = emails;
        return;
      }
      this.selectedChatgptAccounts = emails;
    },

    syncSelectedAccounts(type) {
      const validEmails = new Set(this.accountItemsByType(type).map((account) => account.email));
      const nextSelection = this.selectedAccountEmailsByType(type).filter((email) => validEmails.has(email));
      this.setSelectedAccountEmailsByType(type, nextSelection);
    },

    toggleAccountSelection(type, email, checked) {
      const selected = new Set(this.selectedAccountEmailsByType(type));
      if (checked) selected.add(email);
      else selected.delete(email);
      this.setSelectedAccountEmailsByType(type, Array.from(selected));
    },

    clearSelectedAccounts(type = this.accountSubTab) {
      this.setSelectedAccountEmailsByType(type, []);
    },

    toggleSelectAllFilteredAccounts(type, checked) {
      const visibleEmails = this.filteredAccountItemsByType(type).map((account) => account.email);
      const selected = new Set(this.selectedAccountEmailsByType(type));
      if (checked) {
        visibleEmails.forEach((email) => selected.add(email));
      } else {
        visibleEmails.forEach((email) => selected.delete(email));
      }
      this.setSelectedAccountEmailsByType(type, Array.from(selected));
    },

    isAccountSelected(type, email) {
      return this.selectedAccountEmailsByType(type).includes(email);
    },

    selectedAccountCount(type = this.accountSubTab) {
      return this.selectedAccountEmailsByType(type).length;
    },

    isAllFilteredAccountsSelected(type) {
      const visible = this.filteredAccountItemsByType(type);
      if (!visible.length) return false;
      const selected = new Set(this.selectedAccountEmailsByType(type));
      return visible.every((account) => selected.has(account.email));
    },

    isSomeFilteredAccountsSelected(type) {
      const visible = this.filteredAccountItemsByType(type);
      if (!visible.length) return false;
      const selected = new Set(this.selectedAccountEmailsByType(type));
      return visible.some((account) => selected.has(account.email));
    },

    isPartiallyFilteredAccountsSelected(type) {
      return this.isSomeFilteredAccountsSelected(type) && !this.isAllFilteredAccountsSelected(type);
    },

    deleteEndpointByType(type, email) {
      const encodedEmail = encodeURIComponent(email);
      if (type === 'claude') return `/claude-accounts/${encodedEmail}`;
      if (type === 'antigravity') return `/antigravity-accounts/${encodedEmail}`;
      return `/accounts/${encodedEmail}`;
    },

    async refreshAccountsByType(type) {
      if (type === 'claude') {
        await this.refreshClaudeAccounts({ refreshUsage: true });
        return;
      }
      if (type === 'antigravity') {
        await this.refreshAntigravityAccounts({ refreshQuota: true });
        return;
      }
      await this.refreshAccounts();
    },

    openDeleteModal(type, emails) {
      const targets = Array.from(new Set((emails || []).filter(Boolean)));
      if (!targets.length) return;
      this.deleteMode = targets.length > 1 ? 'batch' : 'single';
      this.deleteAccountType = type;
      this.deleteTargets = targets;
      this.deleteTarget = targets[0] || '';
      this.showDeleteModal = true;
    },

    confirmBatchDelete(type = this.accountSubTab) {
      const selected = this.selectedAccountEmailsByType(type);
      if (!selected.length) return;
      this.openDeleteModal(type, selected);
    },

    accountStateValue(account) {
      if (account?.enabled === false) return 'disabled';
      if (account?.isActive) return 'active';
      return 'idle';
    },

    accountStateLabel(account) {
      const state = this.accountStateValue(account);
      if (state === 'disabled') return this.t('disabled');
      if (state === 'active') return this.t('activeStatus');
      return this.t('idleStatus');
    },

    accountStateDotClass(account, theme = 'default') {
      const state = this.accountStateValue(account);
      if (state === 'disabled') return 'bg-red-500';
      if (state === 'active') {
        if (theme === 'claude') return 'bg-neon-purple shadow-[0_0_8px_rgba(168,85,247,0.6)] animate-pulse';
        if (theme === 'antigravity') return 'bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,0.6)] animate-pulse';
        return 'bg-neon-green shadow-[0_0_8px_rgba(34,197,94,0.6)]';
      }
      return 'bg-gray-500';
    },

    accountStateTextClass(account, theme = 'default') {
      const state = this.accountStateValue(account);
      if (state === 'disabled') return 'text-red-400';
      if (state === 'active') {
        if (theme === 'claude') return 'text-neon-purple';
        if (theme === 'antigravity') return 'text-cyan-300';
        return 'text-neon-green';
      }
      return 'text-gray-500';
    },

    async refreshAccounts() {
      this.loading = true;
      const { ok, data } = await this.api('/accounts');

      if (ok && data.accounts) {
        this.accounts = data.accounts;
        this.syncSelectedAccounts('chatgpt');
        const enabledAccounts = data.accounts.filter((a) => a.enabled !== false);
        this.stats = {
          total: data.total || data.accounts.length,
          available: enabledAccounts.length,
          expired: data.accounts.filter((a) => a.tokenExpired).length,
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
        const width = 500;
        const height = 700;
        const left = (screen.width - width) / 2;
        const top = (screen.height - height) / 2;
        window.open(data.oauth_url, 'ChatGPT Login', `width=${width},height=${height},left=${left},top=${top}`);

        const checkAdded = setInterval(async () => {
          const { ok: refreshOk, data: refreshData } = await this.api('/accounts');
          if (refreshOk && refreshData.accounts?.length > this.accounts.length) {
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
      } catch {
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

    async forceRefreshToken(email) {
      const { ok, data } = await this.api(`/accounts/${encodeURIComponent(email)}/refresh-token`, { method: 'POST' });
      if (ok && data.success) {
        this.showToast(data.message, 'success');
        this.refreshAccounts();
      } else {
        this.showToast(data?.message || this.t('refreshFailed'), 'error');
      }
    },

    async refreshAllTokens() {
      this.showToast(this.t('refreshingStatuses'), 'info');
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
      this.openDeleteModal('chatgpt', [email]);
    },

    async executeDelete() {
      if (this.deleteInProgress || !this.deleteTargets.length) return;

      this.deleteInProgress = true;
      const targets = [...this.deleteTargets];
      const type = this.deleteAccountType;
      let successCount = 0;
      let failureCount = 0;
      let lastSuccessMessage = '';

      for (const email of targets) {
        const { ok, data } = await this.api(this.deleteEndpointByType(type, email), { method: 'DELETE' });
        if (ok && data?.success) {
          successCount += 1;
          lastSuccessMessage = data.message || '';
        } else {
          failureCount += 1;
        }
      }

      this.deleteInProgress = false;
      this.showDeleteModal = false;

      if (successCount > 0) {
        const deletedEmails = new Set(targets);
        const nextSelection = this.selectedAccountEmailsByType(type).filter((email) => !deletedEmails.has(email));
        this.setSelectedAccountEmailsByType(type, nextSelection);
        await this.refreshAccountsByType(type);
      }

      if (failureCount === 0) {
        this.showToast(
          this.deleteMode === 'single'
            ? (lastSuccessMessage || this.t('deleteSuccessSingle'))
            : this.t('deleteSuccessBatch', successCount),
          'success'
        );
      } else if (successCount > 0) {
        this.showToast(this.t('deletePartialSuccess', successCount, failureCount), 'warning');
      } else {
        this.showToast(this.t('deleteFailed'), 'error');
      }

      this.deleteMode = 'single';
      this.deleteAccountType = 'chatgpt';
      this.deleteTarget = '';
      this.deleteTargets = [];
    },

    async refreshClaudeAccounts({ refreshUsage = false } = {}) {
      const { ok, data } = await this.api('/claude-accounts');
      if (ok) {
        this.claudeAccounts = data.accounts || [];
        this.syncSelectedAccounts('claude');
        await this.refreshClaudeQuotaData({ force: refreshUsage });
      }
    },

    async refreshAntigravityAccounts({ refreshQuota = false } = {}) {
      const { ok, data } = await this.api('/antigravity-accounts');
      if (ok) {
        this.antigravityAccounts = data.accounts || [];
        this.syncSelectedAccounts('antigravity');
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
      return used === null ? fallback : this.t('claudeUsagePercentUsed', used);
    },

    claudeUsageResetLabel(windowData) {
      if (!windowData?.resetsAt) return '-';
      const resetAt = new Date(windowData.resetsAt);
      if (Number.isNaN(resetAt.getTime())) return '-';
      return resetAt.toLocaleString();
    },

    claudeUsageSourceLabel(account) {
      const source = account?.usageSummary?.source;
      if (source === 'oauth_usage') return this.t('claudeUsageSourceOauth');
      if (source === 'response_headers') return this.t('claudeUsageSourceHeaders');
      return this.t('claudeUsageSourceUnavailable');
    },

    claudeUsageUnavailableReason(account) {
      const availability = account?.usageSummary?.availability;
      if (!availability) return null;
      if (availability.fetchError && /does not support this OAuth token/i.test(availability.fetchError)) {
        return this.t('claudeUsageUnsupportedToken');
      }
      if (availability.hasProfileScope === false) {
        return this.t('claudeUsageMissingProfileScope');
      }
      return availability.fetchError || null;
    },

    claudeRuntimeStatusLabel(account) {
      const runtime = account?.usageSummary?.runtime;
      if (!runtime) return this.t('claudeRuntimeStatusUnknown');
      if (runtime.status === 'rejected') return this.t('claudeRuntimeStatusBlocked');
      if (runtime.status === 'allowed_warning') return this.t('claudeRuntimeStatusWarning');
      if (runtime.status === 'allowed') return this.t('claudeRuntimeStatusAvailable');
      return runtime.status || this.t('claudeRuntimeStatusUnknown');
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
      return count > 0 ? this.t('antigravityQuotaSummaryCount', count) : this.t('noQuotaDataYet');
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
      this.openDeleteModal('claude', [email]);
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
      const raw = prompt(this.t('antigravityImportPrompt'));
      if (!raw) return;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.showToast(this.t('invalidJson'), 'error');
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
      this.openDeleteModal('antigravity', [email]);
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
    }
  };
}
