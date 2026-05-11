export function createDashboardPageModule() {
  return {
    get dashboardTotalAccounts() {
      return this.accounts.length + this.claudeAccounts.length + this.antigravityAccounts.length;
    },

    get dashboardProxyReadyCount() {
      return Object.values(this.proxyStatus).filter(Boolean).length;
    }
  };
}
