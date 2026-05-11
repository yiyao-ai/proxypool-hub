export function createUsagePricingPageModule() {
  return {
    usageOverview: { today: {}, allTime: {}, keys: {} },
    dailyStats: [],
    dailyDays: 7,
    usageHistory: [],
    providerStats: {},
    modelStats: {},
    accountStats: {},
    accountKeyNameMap: {},
    pricingSummary: { providers: 0, models: 0, customOverrides: 0, unit: 'USD / 1M tokens' },
    pricingEntries: [],
    pricingFilter: '',
    pricingProviderFilter: '',
    pricingSaving: {},

    get dailyChartMax() {
      if (!this.dailyStats.length) return 1;
      return Math.max(1, ...this.dailyStats.map((day) => day.requests));
    },

    get providerStatsEntries() {
      const entries = Object.entries(this.providerStats)
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.requests - a.requests);
      const max = Math.max(1, ...entries.map((entry) => entry.requests));
      return entries.map((entry) => ({ ...entry, pct: (entry.requests / max) * 100 }));
    },

    get modelStatsEntries() {
      const entries = Object.entries(this.modelStats)
        .map(([name, stats]) => ({ name, ...stats }))
        .sort((a, b) => b.requests - a.requests);
      const max = Math.max(1, ...entries.map((entry) => entry.requests));
      return entries.map((entry) => ({ ...entry, pct: (entry.requests / max) * 100 }));
    },

    get accountStatsEntries() {
      const entries = Object.entries(this.accountStats)
        .map(([name, stats]) => ({ name, displayName: this.accountKeyNameMap[name] || name, ...stats }))
        .sort((a, b) => b.requests - a.requests);
      const max = Math.max(1, ...entries.map((entry) => entry.requests));
      return entries.map((entry) => ({ ...entry, pct: (entry.requests / max) * 100 }));
    },

    get pricingProviders() {
      return [...new Set(this.pricingEntries.map((entry) => entry.provider))].sort();
    },

    get filteredPricingEntries() {
      const query = this.pricingFilter.trim().toLowerCase();
      return this.pricingEntries.filter((entry) => {
        if (this.pricingProviderFilter && entry.provider !== this.pricingProviderFilter) return false;
        if (!query) return true;
        return entry.provider.toLowerCase().includes(query) || entry.model.toLowerCase().includes(query);
      });
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

    async loadPricingData() {
      const res = await this.api('/api/pricing');
      if (res.ok && res.data?.success) {
        this.pricingSummary = res.data.summary || this.pricingSummary;
        this.pricingEntries = (res.data.entries || []).map((entry) => ({
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
    }
  };
}
