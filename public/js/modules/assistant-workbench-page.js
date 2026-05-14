export function createAssistantWorkbenchPageModule() {
  return {
    assistantWorkbenchLoading: false,
    assistantWorkbenchProjects: [],
    assistantWorkbenchTasks: [],
    assistantWorkbenchDashboard: null,
    assistantWorkbenchEpisodes: [],
    assistantWorkbenchTranscript: null,
    assistantWorkbenchConversationContext: null,
    selectedAssistantWorkbenchProjectId: '',
    selectedAssistantWorkbenchTaskId: '',
    assistantWorkbenchProjectStateFilter: 'active',
    assistantWorkbenchTaskStateFilter: 'open',
    assistantWorkbenchEpisodeFilter: 'all',

    async loadAssistantWorkbench(options = {}) {
      if (!options.silent) {
        this.assistantWorkbenchLoading = true;
      }
      await this.loadAssistantWorkbenchProjects({ silent: true });
      if (this.selectedAssistantWorkbenchProjectId) {
        await this.loadAssistantWorkbenchTasks(this.selectedAssistantWorkbenchProjectId, { silent: true });
      }
      if (this.selectedAssistantWorkbenchTaskId) {
        await this.loadAssistantWorkbenchTaskDashboard(this.selectedAssistantWorkbenchTaskId, { silent: true });
      }
      if (!options.silent) {
        this.assistantWorkbenchLoading = false;
      }
    },

    async loadAssistantWorkbenchProjects(options = {}) {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (this.assistantWorkbenchProjectStateFilter) {
        params.set('state', this.assistantWorkbenchProjectStateFilter);
      }
      const { ok, data } = await this.api(`/api/assistant/projects?${params.toString()}`);
      if (!ok || !Array.isArray(data?.projects)) return;
      this.assistantWorkbenchProjects = data.projects;
      if (!this.selectedAssistantWorkbenchProjectId && this.assistantWorkbenchProjects.length > 0) {
        this.selectedAssistantWorkbenchProjectId = this.assistantWorkbenchProjects[0].id;
      }
    },

    async selectAssistantWorkbenchProject(projectId) {
      this.selectedAssistantWorkbenchProjectId = String(projectId || '');
      this.selectedAssistantWorkbenchTaskId = '';
      this.assistantWorkbenchDashboard = null;
      this.assistantWorkbenchEpisodes = [];
      this.assistantWorkbenchTranscript = null;
      this.assistantWorkbenchConversationContext = null;
      this.assistantWorkbenchEpisodeFilter = 'all';
      await this.loadAssistantWorkbenchTasks(projectId);
    },

    async loadAssistantWorkbenchTasks(projectId = this.selectedAssistantWorkbenchProjectId, options = {}) {
      const normalizedProjectId = String(projectId || '').trim();
      if (!normalizedProjectId) return;
      if (!options.silent) {
        this.assistantWorkbenchLoading = true;
      }
      const params = new URLSearchParams();
      params.set('limit', '80');
      if (this.assistantWorkbenchTaskStateFilter && this.assistantWorkbenchTaskStateFilter !== 'all') {
        params.set('lifecycleState', this.assistantWorkbenchTaskStateFilter);
      }
      const { ok, data } = await this.api(`/api/assistant/projects/${encodeURIComponent(normalizedProjectId)}/tasks?${params.toString()}`);
      if (ok && Array.isArray(data?.tasks)) {
        this.assistantWorkbenchTasks = data.tasks;
        if (!this.selectedAssistantWorkbenchTaskId && this.assistantWorkbenchTasks.length > 0) {
          this.selectedAssistantWorkbenchTaskId = this.assistantWorkbenchTasks[0].id;
        }
        if (this.selectedAssistantWorkbenchTaskId) {
          await this.loadAssistantWorkbenchTaskDashboard(this.selectedAssistantWorkbenchTaskId, { silent: true });
        }
      }
      if (!options.silent) {
        this.assistantWorkbenchLoading = false;
      }
    },

    async selectAssistantWorkbenchTask(taskId) {
      this.selectedAssistantWorkbenchTaskId = String(taskId || '');
      await this.loadAssistantWorkbenchTaskDashboard(taskId);
    },

    async loadAssistantWorkbenchTaskDashboard(taskId = this.selectedAssistantWorkbenchTaskId, options = {}) {
      const normalizedTaskId = String(taskId || '').trim();
      if (!normalizedTaskId) return;
      if (!options.silent) {
        this.assistantWorkbenchLoading = true;
      }
      const { ok, data } = await this.api(`/api/assistant/tasks/${encodeURIComponent(normalizedTaskId)}/dashboard`);
      if (ok && data?.dashboard) {
        this.assistantWorkbenchDashboard = data.dashboard;
        await Promise.all([
          this.loadAssistantWorkbenchEpisodes(normalizedTaskId, { silent: true }),
          this.loadAssistantWorkbenchTranscript(data.dashboard, { silent: true }),
          this.loadAssistantWorkbenchConversationContext(data.dashboard, { silent: true })
        ]);
      }
      if (!options.silent) {
        this.assistantWorkbenchLoading = false;
      }
    },

    async loadAssistantWorkbenchEpisodes(taskId = this.selectedAssistantWorkbenchTaskId, _options = {}) {
      const normalizedTaskId = String(taskId || '').trim();
      if (!normalizedTaskId) {
        this.assistantWorkbenchEpisodes = [];
        return;
      }
      const params = new URLSearchParams();
      params.set('taskId', normalizedTaskId);
      params.set('limit', '40');
      const { ok, data } = await this.api(`/api/assistant/episodes?${params.toString()}`);
      this.assistantWorkbenchEpisodes = ok && Array.isArray(data?.episodes) ? data.episodes : [];
    },

    async loadAssistantWorkbenchTranscript(dashboard = this.assistantWorkbenchDashboard, _options = {}) {
      const executionId = String(dashboard?.executions?.[0]?.id || '').trim();
      if (!executionId) {
        this.assistantWorkbenchTranscript = null;
        return;
      }
      const { ok, data } = await this.api(`/api/assistant/executions/${encodeURIComponent(executionId)}/transcript`);
      this.assistantWorkbenchTranscript = ok ? data?.transcript || null : null;
    },

    async loadAssistantWorkbenchConversationContext(dashboard = this.assistantWorkbenchDashboard, _options = {}) {
      const conversationId = String(dashboard?.task?.lastConversationId || '').trim();
      if (!conversationId) {
        this.assistantWorkbenchConversationContext = null;
        return;
      }
      const { ok, data } = await this.api(`/api/assistant/conversations/${encodeURIComponent(conversationId)}`);
      this.assistantWorkbenchConversationContext = ok ? data?.detail || null : null;
    },

    assistantWorkbenchProjectClass(project) {
      return project?.id === this.selectedAssistantWorkbenchProjectId
        ? 'border-neon-cyan/40 bg-neon-cyan/10'
        : 'border-space-border/30 bg-space-900/40 hover:bg-space-800/50';
    },

    assistantWorkbenchTaskClass(task) {
      return task?.id === this.selectedAssistantWorkbenchTaskId
        ? 'border-neon-purple/40 bg-neon-purple/10'
        : 'border-space-border/30 bg-space-900/40 hover:bg-space-800/50';
    },

    assistantWorkbenchTaskStateClass(task) {
      const state = String(task?.lifecycleState || '').trim();
      if (state === 'completed') return 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan';
      if (state === 'failed' || state === 'cancelled') return 'border-red-500/30 bg-red-500/10 text-red-300';
      if (state === 'paused') return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400';
      return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
    },

    assistantWorkbenchExecutionStateClass(execution) {
      const state = String(execution?.status || '').trim();
      if (state === 'waiting_approval' || state === 'waiting_user') return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-400';
      if (state === 'failed' || state === 'cancelled') return 'border-red-500/30 bg-red-500/10 text-red-300';
      if (state === 'done' || state === 'ready') return 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan';
      return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
    },

    assistantWorkbenchEpisodeSummary(episode) {
      const payload = episode?.payload || {};
      return payload.summary
        || payload.title
        || payload.objective
        || payload.provider
        || payload.status
        || '-';
    },

    assistantWorkbenchList(value) {
      return Array.isArray(value) ? value : [];
    },

    assistantWorkbenchSetEpisodeFilter(filter = 'all') {
      this.assistantWorkbenchEpisodeFilter = String(filter || 'all').trim() || 'all';
    },

    assistantWorkbenchEpisodeFilterClass(filter) {
      return this.assistantWorkbenchEpisodeFilter === filter
        ? 'border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan'
        : 'border-space-border/30 bg-space-900/35 text-gray-400 hover:bg-space-800/50';
    },

    assistantWorkbenchEpisodeMatchesFilter(episode, filter = this.assistantWorkbenchEpisodeFilter) {
      const normalizedFilter = String(filter || 'all').trim();
      if (!normalizedFilter || normalizedFilter === 'all') {
        return true;
      }
      const kind = String(episode?.kind || '').trim().toLowerCase();
      if (!kind) {
        return false;
      }
      if (normalizedFilter === 'task') {
        return kind.startsWith('task.') || kind === 'task.moved';
      }
      if (normalizedFilter === 'execution') {
        return kind.startsWith('execution.') || kind.startsWith('execution_');
      }
      if (normalizedFilter === 'runtime') {
        return kind.startsWith('runtime.');
      }
      if (normalizedFilter === 'approval') {
        return kind.includes('approval');
      }
      if (normalizedFilter === 'question') {
        return kind.includes('question');
      }
      if (normalizedFilter === 'delivery') {
        return kind.startsWith('delivery.');
      }
      if (normalizedFilter === 'user_assistant') {
        return kind.includes('message') || kind.includes('delivery') || kind.includes('question') || kind.includes('approval');
      }
      return true;
    },

    assistantWorkbenchFilteredEpisodes() {
      return this.assistantWorkbenchList(this.assistantWorkbenchEpisodes)
        .filter((episode) => this.assistantWorkbenchEpisodeMatchesFilter(episode));
    }
  };
}
