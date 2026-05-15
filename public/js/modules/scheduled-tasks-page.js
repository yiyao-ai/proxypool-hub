export function createScheduledTasksPageModule() {
  return {
    // List + filter state
    scheduledTasks: [],
    scheduledTasksLoading: false,
    scheduledTaskStateFilter: 'active',
    scheduledTaskConversationFilter: '',
    scheduledTaskQuery: '',
    // All conversations the user could plausibly use as notify targets
    // (excludes scheduled-task-scope ones, which are internal).
    scheduledTaskUserConversations: [],

    // Selection + run history
    selectedScheduledTask: null,
    scheduledTaskRuns: [],
    scheduledTaskRunsLoading: false,

    // Form state
    scheduledTaskFormOpen: false,
    scheduledTaskFormSubmitting: false,
    scheduledTaskFormError: '',
    scheduledTaskForm: {
      id: '',
      title: '',
      message: '',
      action: 'notify_user',
      notifyConversationIds: [],
      sharedContext: false,
      cwd: '',
      recurrence: 'daily',
      timezone: 'Asia/Shanghai',
      localTime: '20:00',
      dayOfWeek: [],
      dayOfMonth: 1,
      month: 1,
      date: '',
      delayMinutes: 5,
      useDelay: false
    },

    scheduledTaskWeekdayLabels: [
      { value: 'mon' },
      { value: 'tue' },
      { value: 'wed' },
      { value: 'thu' },
      { value: 'fri' },
      { value: 'sat' },
      { value: 'sun' }
    ],

    get filteredScheduledTasks() {
      const q = String(this.scheduledTaskQuery || '').trim().toLowerCase();
      const tasks = Array.isArray(this.scheduledTasks) ? this.scheduledTasks : [];
      if (!q) return tasks;
      return tasks.filter((task) => [
        task?.title,
        task?.payload?.message,
        task?.payload?.action,
        task?.schedule?.recurrence,
        task?.schedule?.localTime,
        task?.lastError
      ].some((v) => String(v || '').toLowerCase().includes(q)));
    },

    async loadScheduledTasksConversations() {
      const { ok, data } = await this.api('/api/agent-channels/conversations?limit=200');
      if (ok && Array.isArray(data?.conversations)) {
        // Hide internal scope conversations from user-facing pickers.
        this.scheduledTaskUserConversations = data.conversations.filter(
          (c) => String(c?.channel || '') !== 'scheduled-task-scope'
        );
      }
    },

    async loadScheduledTasks() {
      this.scheduledTasksLoading = true;
      try {
        await this.loadScheduledTasksConversations();
        const params = new URLSearchParams();
        params.set('limit', '200');
        if (this.scheduledTaskStateFilter && this.scheduledTaskStateFilter !== 'all') {
          if (this.scheduledTaskStateFilter === 'active') {
            params.set('state', 'scheduled,running,paused');
          } else {
            params.set('state', this.scheduledTaskStateFilter);
          }
        }
        if (this.scheduledTaskConversationFilter) {
          params.set('conversationId', this.scheduledTaskConversationFilter);
        }
        const { ok, data } = await this.api(`/api/assistant/scheduled-tasks?${params.toString()}`);
        if (ok && Array.isArray(data?.scheduledTasks)) {
          this.scheduledTasks = data.scheduledTasks;
          if (this.selectedScheduledTask?.id) {
            const refreshed = this.scheduledTasks.find((t) => t.id === this.selectedScheduledTask.id);
            this.selectedScheduledTask = refreshed || null;
            if (!refreshed) this.scheduledTaskRuns = [];
          }
        }
      } finally {
        this.scheduledTasksLoading = false;
      }
    },

    async selectScheduledTask(task) {
      this.selectedScheduledTask = task;
      this.scheduledTaskRuns = [];
      if (task?.id) await this.loadScheduledTaskRuns(task.id);
    },

    async loadScheduledTaskRuns(id) {
      if (!id) return;
      this.scheduledTaskRunsLoading = true;
      try {
        const { ok, data } = await this.api(`/api/assistant/scheduled-tasks/${encodeURIComponent(id)}/runs?limit=30`);
        if (ok && Array.isArray(data?.runs)) {
          this.scheduledTaskRuns = data.runs;
        }
      } finally {
        this.scheduledTaskRunsLoading = false;
      }
    },

    // --- formatting helpers ---

    scheduledTaskConversationLabel(conv) {
      if (!conv) return '';
      const channel = String(conv.channel || '').trim();
      const title = String(conv.title || conv.externalConversationId || conv.id || '').trim();
      return channel ? `[${channel}] ${title}` : title;
    },

    scheduledTaskConversationLabelById(id) {
      if (!id) return '';
      const conv = this.scheduledTaskUserConversations.find((entry) => entry.id === id);
      if (!conv) return id;
      return this.scheduledTaskConversationLabel(conv);
    },

    scheduledTaskNotifyTargetsSummary(task) {
      const targets = Array.isArray(task?.notifyTargets) ? task.notifyTargets : [];
      if (targets.length === 0) return this.t('scheduledTaskBackgroundOnly');
      return targets
        .map((t) => this.scheduledTaskConversationLabelById(t?.conversationId))
        .filter(Boolean)
        .join(' · ');
    },

    scheduledTaskRecurrenceLabel(task) {
      const rec = String(task?.schedule?.recurrence || 'once');
      return this.t(`scheduledTaskRecurrence_${rec}`) || rec;
    },

    scheduledTaskStateLabel(task) {
      const state = String(task?.state || 'scheduled');
      const key = `scheduledTaskState${state.charAt(0).toUpperCase()}${state.slice(1)}`;
      const localized = this.t(key);
      return localized && localized !== key ? localized : state;
    },

    scheduledTaskStatePillClass(task) {
      const state = String(task?.state || '');
      if (state === 'scheduled') return 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300';
      if (state === 'running') return 'border-yellow-500/40 bg-yellow-500/10 text-yellow-300';
      if (state === 'completed') return 'border-green-500/40 bg-green-500/10 text-green-300';
      if (state === 'cancelled') return 'border-gray-500/40 bg-gray-500/10 text-gray-400';
      if (state === 'failed') return 'border-red-500/40 bg-red-500/10 text-red-300';
      return 'border-space-border/30 bg-space-800/60 text-gray-400';
    },

    scheduledTaskCardClass(task) {
      const isSelected = task?.id && this.selectedScheduledTask?.id === task.id;
      return isSelected
        ? 'border-neon-purple/40 bg-neon-purple/10'
        : 'border-space-border/30 bg-space-900/40 hover:bg-space-800/50';
    },

    scheduledTaskRunStatePillClass(run) {
      const s = String(run?.state || '');
      if (s === 'completed') return 'border-green-500/40 bg-green-500/10 text-green-300';
      if (s.startsWith('failed')) return 'border-red-500/40 bg-red-500/10 text-red-300';
      return 'border-space-border/30 bg-space-800/60 text-gray-400';
    },

    scheduledTaskActionLabel(task) {
      const action = String(task?.payload?.action || 'notify_user');
      if (action === 'invoke_assistant') return this.t('scheduledTaskActionInvokeAssistant');
      return this.t('scheduledTaskActionNotifyUser');
    },

    scheduledTaskWeekdayShortFromNumber(n) {
      const map = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const key = map[n];
      if (!key) return String(n);
      return this.scheduledTaskWeekdayShortLabel(key);
    },

    scheduledTaskWeekdayShortLabel(value) {
      const key = String(value || '').trim().toLowerCase();
      if (!key) return '';
      const localized = this.t(`scheduledTaskWeekdayShort_${key}`);
      return localized || key;
    },

    scheduledTaskLocaleTag() {
      return String(this.lang || 'en').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
    },

    scheduledTaskRunStateLabel(run) {
      const state = String(run?.state || '');
      if (!state) return '';
      const key = `scheduledTaskRunState_${state}`;
      const localized = this.t(key);
      return localized && localized !== key ? localized : state;
    },

    scheduledTaskWhenDescription(task) {
      const s = task?.schedule || {};
      const rec = String(s.recurrence || 'once');
      const tz = String(s.timezone || 'Asia/Shanghai');
      const localTime = String(s.localTime || '');
      if (rec === 'once') {
        if (s.date && localTime) return `${this.t('scheduledTaskRecurrence_once')} • ${s.date} ${localTime} (${tz})`;
        if (localTime) return `${this.t('scheduledTaskRecurrence_once')} • ${localTime} (${tz})`;
        return this.t('scheduledTaskRecurrence_once');
      }
      if (rec === 'daily') return `${this.t('scheduledTaskRecurrence_daily')} • ${localTime} (${tz})`;
      if (rec === 'weekly') {
        const dows = Array.isArray(s.dayOfWeek)
          ? s.dayOfWeek.map((n) => this.scheduledTaskWeekdayShortFromNumber(n)).join('/')
          : '';
        return `${this.t('scheduledTaskRecurrence_weekly')} • ${dows} • ${localTime} (${tz})`;
      }
      if (rec === 'monthly') return `${this.t('scheduledTaskRecurrence_monthly')} • ${this.t('scheduledTaskDayOfMonthShort', s.dayOfMonth)} • ${localTime} (${tz})`;
      if (rec === 'yearly') return `${this.t('scheduledTaskRecurrence_yearly')} • ${this.t('scheduledTaskMonthDayShort', s.month, s.dayOfMonth)} • ${localTime} (${tz})`;
      return rec;
    },

    _formatIsoInTz(iso, tz) {
      if (!iso) return '';
      try {
        const ms = Date.parse(iso);
        if (!Number.isFinite(ms)) return iso;
        const fmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        });
        const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
        return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${tz})`;
      } catch {
        return iso;
      }
    },

    scheduledTaskFireDescription(task) {
      if (!task?.nextRunAt) return '';
      const tz = String(task?.schedule?.timezone || 'Asia/Shanghai');
      return this._formatIsoInTz(task.nextRunAt, tz);
    },

    scheduledTaskFireDescriptionForIso(iso) {
      const tz = String(this.selectedScheduledTask?.schedule?.timezone || 'Asia/Shanghai');
      return this._formatIsoInTz(iso, tz);
    },

    // --- form lifecycle ---

    openScheduledTaskCreate() {
      this.scheduledTaskFormError = '';
      this.scheduledTaskForm = {
        id: '',
        title: '',
        message: '',
        action: 'notify_user',
        notifyConversationIds: [],
        sharedContext: false,
        cwd: '',
        recurrence: 'daily',
        timezone: 'Asia/Shanghai',
        localTime: '20:00',
        dayOfWeek: [],
        dayOfMonth: 1,
        month: 1,
        date: '',
        delayMinutes: 5,
        useDelay: false
      };
      this.scheduledTaskFormOpen = true;
    },

    openScheduledTaskEdit(task) {
      if (!task) return;
      this.scheduledTaskFormError = '';
      const s = task.schedule || {};
      const targets = Array.isArray(task.notifyTargets) ? task.notifyTargets : [];
      this.scheduledTaskForm = {
        id: task.id,
        title: task.title || '',
        message: task.payload?.message || '',
        action: task.payload?.action || 'notify_user',
        notifyConversationIds: targets.map((t) => String(t?.conversationId || '')).filter(Boolean),
        sharedContext: Boolean(task.sharedContext),
        cwd: task.cwd || '',
        recurrence: s.recurrence || 'once',
        timezone: s.timezone || 'Asia/Shanghai',
        localTime: s.localTime || '20:00',
        dayOfWeek: Array.isArray(s.dayOfWeek)
          ? s.dayOfWeek.map((n) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][n]).filter(Boolean)
          : [],
        dayOfMonth: s.dayOfMonth || 1,
        month: s.month || 1,
        date: s.date || '',
        delayMinutes: 5,
        useDelay: false
      };
      this.scheduledTaskFormOpen = true;
    },

    closeScheduledTaskForm() {
      this.scheduledTaskFormOpen = false;
      this.scheduledTaskFormError = '';
    },

    scheduledTaskFormPreview() {
      const f = this.scheduledTaskForm;
      const action = f.action === 'invoke_assistant' ? this.t('scheduledTaskActionInvokeAssistant') : this.t('scheduledTaskActionNotifyUser');
      const rec = this.t(`scheduledTaskRecurrence_${f.recurrence}`);
      const when = (() => {
        if (f.recurrence === 'once') {
          if (f.useDelay) return `${this.t('scheduledTaskFormDelayMinutesLabel')}: ${f.delayMinutes || 0}`;
          if (f.date && f.localTime) return `${f.date} ${f.localTime} (${f.timezone})`;
          if (f.localTime) return `${f.localTime} (${f.timezone})`;
          return '?';
        }
        if (f.recurrence === 'daily') return `${f.localTime} (${f.timezone})`;
        if (f.recurrence === 'weekly') {
          const dows = Array.isArray(f.dayOfWeek)
            ? f.dayOfWeek.map((value) => this.scheduledTaskWeekdayShortLabel(value)).join('/')
            : '';
          return `${dows} ${f.localTime} (${f.timezone})`;
        }
        if (f.recurrence === 'monthly') return `${this.t('scheduledTaskDayOfMonthShort', f.dayOfMonth)} ${f.localTime} (${f.timezone})`;
        if (f.recurrence === 'yearly') return `${this.t('scheduledTaskMonthDayShort', f.month, f.dayOfMonth)} ${f.localTime} (${f.timezone})`;
        return '?';
      })();
      const targets = f.notifyConversationIds.length === 0
        ? this.t('scheduledTaskBackgroundOnly')
        : this.t('scheduledTaskFormNotifyTargetsHint', f.notifyConversationIds.length);
      return `[${action}] ${rec} • ${when} → ${targets}`;
    },

    buildScheduledTaskPayload() {
      const f = this.scheduledTaskForm;
      const schedule = {
        recurrence: f.recurrence,
        timezone: String(f.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai'
      };
      if (f.recurrence === 'once') {
        if (f.useDelay) {
          const m = Number(f.delayMinutes);
          if (!Number.isFinite(m) || m <= 0) {
            throw new Error(this.t('scheduledTaskFormErrorDelayMinutes'));
          }
          schedule.delayMinutes = m;
        } else {
          if (!f.localTime) throw new Error(this.t('scheduledTaskFormErrorLocalTime'));
          schedule.localTime = f.localTime;
          if (f.date) schedule.date = f.date;
        }
      } else {
        if (!f.localTime) throw new Error(this.t('scheduledTaskFormErrorLocalTime'));
        schedule.localTime = f.localTime;
        if (f.recurrence === 'weekly') {
          if (!Array.isArray(f.dayOfWeek) || f.dayOfWeek.length === 0) {
            throw new Error(this.t('scheduledTaskFormErrorDayOfWeek'));
          }
          schedule.dayOfWeek = f.dayOfWeek;
        } else if (f.recurrence === 'monthly') {
          const d = Number(f.dayOfMonth);
          if (!Number.isInteger(d) || d < 1 || d > 31) {
            throw new Error(this.t('scheduledTaskFormErrorDayOfMonth'));
          }
          schedule.dayOfMonth = d;
        } else if (f.recurrence === 'yearly') {
          const d = Number(f.dayOfMonth);
          const mo = Number(f.month);
          if (!Number.isInteger(d) || d < 1 || d > 31) throw new Error(this.t('scheduledTaskFormErrorDayOfMonth'));
          if (!Number.isInteger(mo) || mo < 1 || mo > 12) throw new Error(this.t('scheduledTaskFormErrorMonth'));
          schedule.dayOfMonth = d;
          schedule.month = mo;
        }
      }
      const title = String(f.title || '').trim();
      const message = String(f.message || '').trim();
      if (!title && !message) {
        throw new Error(this.t('scheduledTaskFormErrorTitleOrMessage'));
      }
      if (f.action === 'invoke_assistant' && !message) {
        throw new Error(this.t('scheduledTaskFormErrorInstruction'));
      }
      if (f.action === 'notify_user' && f.notifyConversationIds.length === 0) {
        throw new Error(this.t('scheduledTaskFormErrorNotifyRequired'));
      }
      return {
        title: title || message.slice(0, 80),
        kind: 'reminder',
        action: f.action,
        message,
        schedule,
        notifyConversationIds: f.notifyConversationIds.slice(),
        sharedContext: Boolean(f.sharedContext),
        cwd: f.action === 'invoke_assistant' ? String(f.cwd || '').trim() : '',
        source: 'manual_ui'
      };
    },

    async submitScheduledTaskForm() {
      this.scheduledTaskFormError = '';
      let body;
      try {
        body = this.buildScheduledTaskPayload();
      } catch (err) {
        this.scheduledTaskFormError = String(err?.message || err);
        return;
      }
      this.scheduledTaskFormSubmitting = true;
      try {
        const isUpdate = Boolean(this.scheduledTaskForm.id);
        const url = isUpdate
          ? `/api/assistant/scheduled-tasks/${encodeURIComponent(this.scheduledTaskForm.id)}`
          : '/api/assistant/scheduled-tasks';
        const method = isUpdate ? 'PATCH' : 'POST';
        const { ok, data } = await this.api(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (ok && data?.success) {
          this.scheduledTaskFormOpen = false;
          await this.loadScheduledTasks();
          this.showToast?.(isUpdate ? this.t('scheduledTaskUpdated') : this.t('scheduledTaskCreated'), 'success');
        } else {
          this.scheduledTaskFormError = data?.error || `${method} ${url} failed`;
        }
      } catch (err) {
        this.scheduledTaskFormError = String(err?.message || err);
      } finally {
        this.scheduledTaskFormSubmitting = false;
      }
    },

    async confirmCancelScheduledTask(task) {
      if (!task?.id) return;
      const confirmText = `${this.t('scheduledTaskCancelConfirm')}\n\n${task.title || task.id}`;
      if (!window.confirm(confirmText)) return;
      const { ok, data } = await this.api(`/api/assistant/scheduled-tasks/${encodeURIComponent(task.id)}`, {
        method: 'DELETE'
      });
      if (ok && data?.success) {
        this.showToast?.(this.t('scheduledTaskCancelled'), 'success');
        await this.loadScheduledTasks();
      } else {
        this.showToast?.(data?.error || this.t('scheduledTaskCancelFailed'), 'error');
      }
    },

    async runScheduledTaskNow(id) {
      if (!id) return;
      const { ok, data } = await this.api(`/api/assistant/scheduled-tasks/${encodeURIComponent(id)}/run`, {
        method: 'POST'
      });
      if (ok && data?.success) {
        this.showToast?.(this.t('scheduledTaskRunQueued'), 'success');
        await this.loadScheduledTasks();
        if (this.selectedScheduledTask?.id) await this.loadScheduledTaskRuns(this.selectedScheduledTask.id);
      } else {
        this.showToast?.(data?.error || this.t('scheduledTaskRunFailed'), 'error');
      }
    }
  };
}
