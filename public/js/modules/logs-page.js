export function createLogsPageModule() {
  return {
    logs: [],
    logSearchQuery: '',
    logFilters: { INFO: true, SUCCESS: true, WARN: true, ERROR: true, DEBUG: false },
    logEventSource: null,
    reqLogEntries: [],
    reqLogDates: [],
    reqLogTotal: 0,
    reqLogOffset: 0,
    reqLogFilter: { date: '', provider: '', errorsOnly: false },
    reqLogSettings: { enabled: true, retentionDays: 7 },

    get filteredLogs() {
      const query = this.logSearchQuery.trim().toLowerCase();
      return this.logs.filter((log) => {
        if (!this.logFilters[log.level]) return false;
        if (query && !log.message.toLowerCase().includes(query)) return false;
        return true;
      });
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
        } catch {}
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

    async loadRequestLogs() {
      if (this.reqLogDates.length === 0) {
        const datesRes = await this.api('/api/request-logs/dates');
        if (datesRes.ok && datesRes.data?.dates) {
          this.reqLogDates = datesRes.data.dates;
          if (!this.reqLogFilter.date && this.reqLogDates.length > 0) {
            this.reqLogFilter.date = this.reqLogDates[0];
          }
        }
      }

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
        this.reqLogEntries = (res.data.entries || []).map((entry) => ({ ...entry, _expanded: false }));
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
  };
}
