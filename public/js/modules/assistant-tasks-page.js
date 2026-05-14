export function createAssistantTasksPageModule() {
  return {
    assistantTasks: [],
    assistantTasksLoading: false,
    selectedAssistantTaskId: '',
    selectedAssistantTask: null,
    assistantTaskLoading: false,
    assistantTaskResuming: false,
    assistantTaskTurnDetail: null,
    assistantTaskTurnLoading: false,
    assistantTaskQuery: '',
    assistantTaskStateFilter: 'all',

    get filteredAssistantTasks() {
      const query = String(this.assistantTaskQuery || '').trim().toLowerCase();
      const stateFilter = String(this.assistantTaskStateFilter || 'all');
      return this.assistantTasks.filter((task) => {
        if (stateFilter !== 'all' && String(task?.state || '') !== stateFilter) {
          return false;
        }
        if (!query) return true;
        return [
          task?.id,
          task?.summary,
          task?.resultPreview,
          task?.waitingReason,
          task?.conversation?.title,
          task?.runtimeSession?.providerLabel,
          task?.latestTurn?.input
        ].some((value) => String(value || '').toLowerCase().includes(query));
      });
    },

    async loadAssistantTasks(options = {}) {
      if (!options.silent) {
        this.assistantTasksLoading = true;
      }
      const params = new URLSearchParams();
      params.set('limit', '80');
      if (this.assistantTaskStateFilter && this.assistantTaskStateFilter !== 'all') {
        params.set('state', this.assistantTaskStateFilter);
      }
      const { ok, data } = await this.api(`/api/assistant/tasks?${params.toString()}`);
      if (ok && Array.isArray(data?.tasks)) {
        this.assistantTasks = data.tasks;
        if (!this.selectedAssistantTaskId && this.assistantTasks.length > 0) {
          this.selectedAssistantTaskId = this.assistantTasks[0].id;
        }
        if (this.selectedAssistantTaskId) {
          const selected = this.assistantTasks.find((item) => item.id === this.selectedAssistantTaskId) || null;
          if (selected) {
            this.selectedAssistantTask = {
              ...(this.selectedAssistantTask || {}),
              ...selected
            };
          } else if (this.assistantTasks.length > 0) {
            this.selectedAssistantTaskId = this.assistantTasks[0].id;
            this.selectedAssistantTask = this.assistantTasks[0];
          } else {
            this.selectedAssistantTaskId = '';
            this.selectedAssistantTask = null;
          }
        }
      }
      if (!options.silent) {
        this.assistantTasksLoading = false;
      }
    },

    async selectAssistantTask(taskId) {
      if (!taskId) return;
      this.selectedAssistantTaskId = taskId;
      await this.loadAssistantTaskDetail(taskId);
    },

    async loadAssistantTaskDetail(taskId = this.selectedAssistantTaskId, options = {}) {
      if (!taskId) return;
      if (!options.silent) {
        this.assistantTaskLoading = true;
      }
      const { ok, data } = await this.api(`/api/assistant/tasks/${encodeURIComponent(taskId)}`);
      if (ok && data?.task) {
        this.selectedAssistantTask = data.task;
        await this.loadAssistantTaskTurnDetail(data.task, options);
      }
      if (!options.silent) {
        this.assistantTaskLoading = false;
      }
    },

    async loadAssistantTaskTurnDetail(task = this.selectedAssistantTask, options = {}) {
      const runtimeSessionId = String(task?.runtimeSession?.id || '');
      const turnId = String(task?.latestTurn?.id || '');
      if (!runtimeSessionId || !turnId) {
        this.assistantTaskTurnDetail = null;
        return;
      }
      if (!options.silent) {
        this.assistantTaskTurnLoading = true;
      }
      const { ok, data } = await this.api(`/api/assistant/runtime-sessions/${encodeURIComponent(runtimeSessionId)}/turns/${encodeURIComponent(turnId)}`);
      if (ok && data?.detail) {
        this.assistantTaskTurnDetail = data.detail;
      }
      if (!options.silent) {
        this.assistantTaskTurnLoading = false;
      }
    },

    assistantTaskCardClass(task) {
      const isSelected = task?.id && task.id === this.selectedAssistantTaskId;
      return isSelected
        ? 'border-neon-purple/40 bg-neon-purple/10'
        : 'border-space-border/30 bg-space-900/40 hover:bg-space-800/50';
    },

    assistantTaskStateLabel(task) {
      const state = String(task?.state || 'idle');
      if (state === 'waiting_approval') return this.t('agentRuntimeStatusWaitingApproval');
      if (state === 'waiting_runtime') return this.t('agentRuntimeStatusRunning');
      if (state === 'waiting_user') return this.t('agentRuntimeStatusWaitingUser');
      if (state === 'running' || state === 'starting') return this.t('agentRuntimeStatusRunning');
      if (state === 'completed' || state === 'ready') return this.t('agentRuntimeStatusReady');
      if (state === 'failed' || state === 'cancelled') return this.t('failedLabel');
      return this.t('idleStatus');
    },

    assistantTaskStatePillClass(task) {
      const state = String(task?.state || 'idle');
      if (state === 'waiting_approval') {
        return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400';
      }
      if (state === 'waiting_runtime') {
        return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
      }
      if (state === 'waiting_user') {
        return 'border-blue-500/30 bg-blue-500/10 text-blue-400';
      }
      if (state === 'running' || state === 'starting') {
        return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
      }
      if (state === 'completed' || state === 'ready') {
        return 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan';
      }
      if (state === 'failed' || state === 'cancelled') {
        return 'border-red-500/30 bg-red-500/10 text-red-300';
      }
      return 'border-space-border/40 bg-space-900/70 text-gray-400';
    },

    assistantTaskPreview(task) {
      return task?.summary || task?.resultPreview || task?.waitingReason || '';
    },

    assistantTaskIdentityEntries(task = this.selectedAssistantTask) {
      return [
        { label: this.t('assistantTaskIdentifierTask'), value: task?.id || '' },
        { label: this.t('assistantTaskIdentifierConversation'), value: task?.conversation?.id || '' },
        { label: this.t('assistantTaskIdentifierRun'), value: task?.assistantRun?.id || '' },
        { label: this.t('assistantTaskIdentifierRuntime'), value: task?.runtimeSession?.id || '' },
        { label: this.t('assistantTaskIdentifierTurn'), value: task?.latestTurn?.id || '' }
      ].filter((entry) => entry.value);
    },

    canResumeAssistantRun(task = this.selectedAssistantTask) {
      return task?.assistantRun?.checkpoint?.resumable === true && task?.assistantRun?.status === 'failed';
    },

    assistantRunCheckpointLabel(task = this.selectedAssistantTask) {
      const checkpoint = task?.assistantRun?.checkpoint;
      if (!checkpoint) return '';
      return this.t('assistantRunCheckpointSummary', checkpoint.completedStepCount || 0, checkpoint.pendingStepCount || 0);
    },

    async resumeAssistantRun(task = this.selectedAssistantTask) {
      const runId = String(task?.assistantRun?.id || '');
      if (!runId || this.assistantTaskResuming) return;
      this.assistantTaskResuming = true;
      const { ok, data } = await this.api(`/api/assistant/runs/${encodeURIComponent(runId)}/resume`, {
        method: 'POST'
      });
      this.assistantTaskResuming = false;
      if (!ok || !data?.run) {
        this.showToast(data?.error || this.t('requestFailed'), 'error');
        return;
      }
      this.showToast(this.t('assistantRunResumed'), 'success');
      await this.loadAssistantTasks({ silent: true });
      await this.loadAssistantTaskDetail(this.selectedAssistantTaskId || task?.id, { silent: true });
    },

    assistantTaskPendingItems(task = this.selectedAssistantTask, turnDetail = this.assistantTaskTurnDetail) {
      const approvals = Array.isArray(turnDetail?.pendingApprovals) ? turnDetail.pendingApprovals : [];
      const questions = Array.isArray(turnDetail?.pendingQuestions) ? turnDetail.pendingQuestions : [];
      return [
        ...approvals.map((entry) => ({
          kind: 'approval',
          id: entry.approvalId,
          text: entry.title || entry.summary || this.t('agentRuntimeStatusWaitingApproval')
        })),
        ...questions.map((entry) => ({
          kind: 'question',
          id: entry.questionId,
          text: entry.text || this.t('agentRuntimeStatusWaitingUser')
        }))
      ];
    },

    assistantTaskEventTypeLabel(event) {
      const type = String(event?.type || '');
      if (type === 'worker.started') return this.t('assistantTaskEventStarted');
      if (type === 'worker.progress') return this.t('assistantTaskEventProgress');
      if (type === 'worker.message') return this.t('assistantTaskEventMessage');
      if (type === 'worker.command') return this.t('assistantTaskEventCommand');
      if (type === 'worker.file_change') return this.t('assistantTaskEventFileChange');
      if (type === 'worker.question') return this.t('assistantTaskEventQuestion');
      if (type === 'worker.approval_request') return this.t('assistantTaskEventApproval');
      if (type === 'worker.approval_resolved') return this.t('assistantTaskEventApproved');
      if (type === 'worker.completed') return this.t('assistantTaskEventCompleted');
      if (type === 'worker.failed') return this.t('assistantTaskEventFailed');
      return type || this.t('assistantTaskEventGeneric');
    },

    assistantTaskEventPillClass(event) {
      const type = String(event?.type || '');
      if (type === 'worker.message') return 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan';
      if (type === 'worker.command') return 'border-purple-500/30 bg-purple-500/10 text-purple-400';
      if (type === 'worker.file_change') return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
      if (type === 'worker.question') return 'border-blue-500/30 bg-blue-500/10 text-blue-400';
      if (type === 'worker.approval_request' || type === 'worker.approval_resolved') return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400';
      if (type === 'worker.failed') return 'border-red-500/30 bg-red-500/10 text-red-300';
      if (type === 'worker.completed') return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
      return 'border-space-border/40 bg-space-900/70 text-gray-400';
    },

    assistantTaskEventSummary(event) {
      if (!event) return '';
      const payload = event.payload || {};
      return payload.text
        || payload.message
        || payload.command
        || payload.path
        || payload.title
        || payload.summary
        || payload.error
        || '';
    },

    assistantTaskRecentEvents() {
      return Array.isArray(this.assistantTaskTurnDetail?.recentEvents)
        ? this.assistantTaskTurnDetail.recentEvents
        : [];
    },

    openAssistantTaskRuntime(task = this.selectedAssistantTask) {
      const runtimeSession = task?.runtimeSession;
      if (!runtimeSession?.id) {
        this.showToast(this.t('assistantTaskRuntimeMissing'), 'warning');
        return;
      }
      this.setActiveTab('chat');
      this.openAgentRuntimeMonitorSession({
        id: runtimeSession.id,
        provider: runtimeSession.provider,
        model: task?.task?.provider || '',
        status: runtimeSession.status,
        title: task?.conversation?.title || runtimeSession.title || runtimeSession.id,
        updatedAt: runtimeSession.updatedAt
      });
    },

    async copyAssistantTaskValue(value) {
      if (!value) return;
      try {
        await navigator.clipboard.writeText(String(value));
        this.showToast(this.t('copiedToClipboard'), 'success');
      } catch {
        this.showToast(this.t('failedToCopy'), 'error');
      }
    }
  };
}
