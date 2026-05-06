import assistantReflectionStore from './reflection-store.js';
import assistantWorkspaceStore from './workspace-store.js';
import assistantClarificationStore from './clarification-store.js';
import agentPreferenceStore from '../agent-core/preference-store.js';
import supervisorTaskStoreSingleton from '../agent-orchestrator/supervisor-task-store.js';
import { logger } from '../utils/logger.js';

// 由 §11 / v2.5 P3 引入：后台周期性整理三件事
//   1. 清理过期 PendingClarification（让长时间没人回答的澄清自动作废）
//   2. 用最近的 task postmortem 刷新对应 workspace.summary（喂给 prompt <known_cwds> 用）
//   3. 把出现 ≥ N 次的稳定偏好从 conversation/workspace/runtime_session scope 提升到 global_user
//      （形成可跨对话共享的 UserProfile）
//
// 默认 30 分钟跑一轮；server 启动时立即跑一次再进入定时。
// 失败容忍：每个 job 独立 try/catch，单个 job 失败不影响其他。

function nowIso() {
  return new Date().toISOString();
}

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_WORKSPACE_STALE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WORKSPACE_MIN_TASKS = 1;
const DEFAULT_PROFILE_MIN_OCCURRENCES = 3;
const DEFAULT_PROFILE_KEYS = Object.freeze([
  'reply_language',
  'response_style',
  'preferred_runtime_provider',
  'execution_style'
]);
const DEFAULT_GLOBAL_USER_REF = 'default-user';

function buildWorkspaceSummary({ workspace, postmortems = [] } = {}) {
  if (!workspace?.workspaceRef) return '';
  const lines = [...postmortems]
    .filter(Boolean)
    .sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')))
    .slice(0, 5)
    .map((entry) => {
      const purpose = String(entry?.payload?.purpose || '').trim();
      const outcome = String(entry?.payload?.outcome || '').trim();
      if (!purpose && !outcome) return '';
      if (purpose && outcome) {
        return `- ${purpose} → ${outcome.slice(0, 140)}`;
      }
      return `- ${(purpose || outcome).slice(0, 180)}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return '';
  const header = `Recent work in ${workspace.workspaceRef}:`;
  return [header, ...lines].join('\n');
}

export class AssistantConsolidator {
  constructor({
    reflectionStore = assistantReflectionStore,
    workspaceStore = assistantWorkspaceStore,
    clarificationStore = assistantClarificationStore,
    preferenceStore = agentPreferenceStore,
    supervisorTaskStore = supervisorTaskStoreSingleton,
    intervalMs = DEFAULT_INTERVAL_MS,
    workspaceStaleMs = DEFAULT_WORKSPACE_STALE_MS,
    workspaceMinTasks = DEFAULT_WORKSPACE_MIN_TASKS,
    profileMinOccurrences = DEFAULT_PROFILE_MIN_OCCURRENCES,
    profileKeys = DEFAULT_PROFILE_KEYS,
    globalUserScopeRef = DEFAULT_GLOBAL_USER_REF
  } = {}) {
    this.reflectionStore = reflectionStore;
    this.workspaceStore = workspaceStore;
    this.clarificationStore = clarificationStore;
    this.preferenceStore = preferenceStore;
    this.supervisorTaskStore = supervisorTaskStore;
    this.intervalMs = Math.max(60 * 1000, Number(intervalMs || DEFAULT_INTERVAL_MS));
    this.workspaceStaleMs = Math.max(0, Number(workspaceStaleMs || 0));
    this.workspaceMinTasks = Math.max(1, Number(workspaceMinTasks || 1));
    this.profileMinOccurrences = Math.max(1, Number(profileMinOccurrences || 1));
    this.profileKeys = Array.isArray(profileKeys) && profileKeys.length > 0
      ? profileKeys
      : DEFAULT_PROFILE_KEYS;
    this.globalUserScopeRef = String(globalUserScopeRef || DEFAULT_GLOBAL_USER_REF);
    this._timer = null;
    this._running = false;
  }

  async runOnce() {
    if (this._running) {
      // 防重入：如果上一轮还没跑完，跳过本轮
      return { skipped: true };
    }
    this._running = true;
    const startedAt = nowIso();
    const result = {
      startedAt,
      finishedAt: '',
      expiredClarifications: false,
      refreshedWorkspaces: [],
      promotedProfileEntries: [],
      errors: []
    };
    try {
      try {
        result.expiredClarifications = this.cleanupExpiredClarifications();
      } catch (error) {
        result.errors.push({ job: 'cleanupExpiredClarifications', message: error?.message || String(error) });
      }
      try {
        result.refreshedWorkspaces = this.refreshWorkspaceSummaries();
      } catch (error) {
        result.errors.push({ job: 'refreshWorkspaceSummaries', message: error?.message || String(error) });
      }
      try {
        result.promotedProfileEntries = this.extractUserProfile();
      } catch (error) {
        result.errors.push({ job: 'extractUserProfile', message: error?.message || String(error) });
      }
    } finally {
      this._running = false;
      result.finishedAt = nowIso();
    }
    return result;
  }

  cleanupExpiredClarifications() {
    return this.clarificationStore?.expirePending?.() || false;
  }

  refreshWorkspaceSummaries() {
    const refreshed = [];
    if (!this.workspaceStore?.list || !this.reflectionStore?.getLatestPostmortemByTaskId) {
      return refreshed;
    }
    const workspaces = this.workspaceStore.list({ limit: 200 });
    const nowMs = Date.now();
    for (const workspace of workspaces) {
      try {
        const entry = this._refreshWorkspaceSummary(workspace, nowMs);
        if (entry) refreshed.push(entry);
      } catch (error) {
        // 单个 workspace 失败不影响其他
        logger.warn?.(`[Consolidator] workspace summary refresh failed for ${workspace?.workspaceRef}: ${error?.message || error}`);
      }
    }
    return refreshed;
  }

  _refreshWorkspaceSummary(workspace, nowMs) {
    const taskIds = Array.isArray(workspace?.taskIds) ? workspace.taskIds : [];
    if (taskIds.length < this.workspaceMinTasks) {
      return null;
    }
    const summaryRefreshedAt = workspace?.metadata?.summaryRefreshedAt
      ? Date.parse(workspace.metadata.summaryRefreshedAt)
      : 0;
    const lastTouchedAt = workspace?.lastTouchedAt
      ? Date.parse(workspace.lastTouchedAt)
      : Date.parse(workspace?.updatedAt || '');
    const isStale = !summaryRefreshedAt
      || (Number.isFinite(lastTouchedAt) && lastTouchedAt > summaryRefreshedAt)
      || (this.workspaceStaleMs > 0 && (nowMs - summaryRefreshedAt) > this.workspaceStaleMs);
    if (!isStale) return null;

    const postmortems = taskIds
      .map((taskId) => this.reflectionStore.getLatestPostmortemByTaskId(taskId))
      .filter(Boolean);
    if (postmortems.length === 0) return null;

    const summary = buildWorkspaceSummary({ workspace, postmortems });
    if (!summary) return null;

    const updated = this.workspaceStore.upsert({
      workspaceRef: workspace.workspaceRef,
      patch: {
        summary,
        metadata: {
          summaryRefreshedAt: nowIso(),
          summaryPostmortemCount: postmortems.length
        }
      }
    });
    return {
      workspaceId: updated?.id || workspace?.id,
      workspaceRef: workspace.workspaceRef,
      taskCount: postmortems.length
    };
  }

  extractUserProfile() {
    const promoted = [];
    if (!this.preferenceStore?.listPreferences || !this.preferenceStore?.upsertPreference) {
      return promoted;
    }
    for (const key of this.profileKeys) {
      try {
        const entry = this._promoteProfileKey(key);
        if (entry) promoted.push(entry);
      } catch (error) {
        logger.warn?.(`[Consolidator] profile promote failed for ${key}: ${error?.message || error}`);
      }
    }
    return promoted;
  }

  _promoteProfileKey(key) {
    const allRecords = this.preferenceStore.listPreferences({ key });
    if (!Array.isArray(allRecords) || allRecords.length === 0) return null;

    const candidates = allRecords.filter((entry) => entry?.scope !== 'global_user');
    if (candidates.length < this.profileMinOccurrences) return null;

    // 用 Map 计数候选值
    const counts = new Map();
    for (const record of candidates) {
      const value = String(record?.value || '').trim();
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
    if (counts.size === 0) return null;

    const [winnerValue, winnerCount] = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])[0];
    if (!winnerValue || winnerCount < this.profileMinOccurrences) return null;

    const existing = this.preferenceStore.getPreference({
      scope: 'global_user',
      scopeRef: this.globalUserScopeRef,
      key
    });
    if (existing && String(existing.value || '').trim() === winnerValue) {
      return null;
    }

    this.preferenceStore.upsertPreference({
      scope: 'global_user',
      scopeRef: this.globalUserScopeRef,
      key,
      value: winnerValue,
      metadata: {
        source: 'consolidator',
        occurrences: winnerCount,
        promotedAt: nowIso()
      }
    });
    return { key, value: winnerValue, occurrences: winnerCount };
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.runOnce().catch((error) => {
        logger.warn?.(`[Consolidator] periodic run failed: ${error?.message || error}`);
      });
    }, this.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') {
      this._timer.unref();
    }
    // boot 时立刻跑一次（不阻塞 server 启动）
    this.runOnce().catch((error) => {
      logger.warn?.(`[Consolidator] boot run failed: ${error?.message || error}`);
    });
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

export const assistantConsolidator = new AssistantConsolidator();

export default assistantConsolidator;
