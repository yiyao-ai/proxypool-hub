import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { CHANNEL_CONVERSATION_MODE, createChannelConversation } from './models.js';
import { buildTrackedSupervisorTaskIds, normalizeSupervisorTaskMemory } from '../agent-orchestrator/supervisor-task-memory.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeTrackedRuntimeSessionIds(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function normalizeTrackedTaskIds(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((entry) => String(entry || '').trim()).filter(Boolean))];
}

function resolveConversationTaskBindings(conversation = {}) {
  const supervisor = conversation?.metadata?.supervisor;
  const taskMemory = normalizeSupervisorTaskMemory(supervisor?.taskMemory || null);
  const activeTaskId = String(
    taskMemory?.activeTaskId
    || conversation?.activeTaskId
    || ''
  ).trim() || null;
  const trackedTaskIds = normalizeTrackedTaskIds([
    ...(Array.isArray(conversation?.trackedTaskIds) ? conversation.trackedTaskIds : []),
    ...buildTrackedSupervisorTaskIds(taskMemory),
    activeTaskId || ''
  ]);

  return {
    activeTaskId,
    trackedTaskIds
  };
}

export class AgentChannelConversationStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-channels');
    this.file = join(this.rootDir, 'conversations.json');
    this.ensureDirs();
    this.conversations = this._load();
  }

  ensureDirs() {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  _load() {
    this.ensureDirs();
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed?.conversations) ? parsed.conversations : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    writeFileSync(
      this.file,
      JSON.stringify({ conversations: this.conversations }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ limit = 100 } = {}) {
    return [...this.conversations]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  get(conversationId) {
    return this.conversations.find((entry) => entry.id === conversationId) || null;
  }

  save(conversation) {
    const index = this.conversations.findIndex((entry) => entry.id === conversation.id);
    const taskBindings = resolveConversationTaskBindings(conversation);
    const updated = {
      ...conversation,
      trackedRuntimeSessionIds: normalizeTrackedRuntimeSessionIds([
        ...(Array.isArray(conversation?.trackedRuntimeSessionIds) ? conversation.trackedRuntimeSessionIds : []),
        conversation?.activeRuntimeSessionId || ''
      ]),
      activeTaskId: taskBindings.activeTaskId,
      trackedTaskIds: taskBindings.trackedTaskIds,
      updatedAt: nowIso()
    };

    if (index >= 0) {
      this.conversations[index] = updated;
    } else {
      this.conversations.push(updated);
    }

    this._save();
    return updated;
  }

  patch(conversationId, patch = {}) {
    const current = this.get(conversationId);
    if (!current) return null;
    return this.save({
      ...current,
      ...patch
    });
  }

  findByExternal(channel, accountId, externalConversationId, externalUserId, externalThreadId = '') {
    return this.conversations.find((entry) => (
      entry.channel === String(channel || '')
      && entry.accountId === String(accountId || 'default')
      && entry.externalConversationId === String(externalConversationId || '')
      && entry.externalUserId === String(externalUserId || '')
      && String(entry.externalThreadId || '') === String(externalThreadId || '')
    )) || null;
  }

  findOrCreateByExternal({
    channel,
    accountId = 'default',
    externalConversationId,
    externalUserId,
    externalThreadId = '',
    title = '',
    metadata = {}
  } = {}) {
    const existing = this.findByExternal(
      channel,
      accountId,
      externalConversationId,
      externalUserId,
      externalThreadId
    );
    if (existing) {
      return this.patch(existing.id, {
        metadata: {
          ...(existing.metadata || {}),
          ...(metadata || {})
        },
        title: title || existing.title
      });
    }

    return this.save(createChannelConversation({
      channel,
      accountId,
      externalConversationId,
      externalUserId,
      externalThreadId,
      title,
      metadata
    }));
  }

  listByRuntimeSessionId(sessionId) {
    return this.listByTrackedRuntimeSessionId(sessionId);
  }

  listByTrackedTaskId(taskId) {
    const normalized = String(taskId || '').trim();
    if (!normalized) return [];
    return this.conversations.filter((entry) => {
      const trackedTaskIds = normalizeTrackedTaskIds([
        ...(Array.isArray(entry?.trackedTaskIds) ? entry.trackedTaskIds : []),
        entry?.activeTaskId || ''
      ]);
      return trackedTaskIds.includes(normalized);
    });
  }

  listByTrackedRuntimeSessionId(sessionId) {
    const normalized = String(sessionId || '').trim();
    if (!normalized) return [];
    return this.conversations.filter((entry) => {
      const tracked = normalizeTrackedRuntimeSessionIds([
        ...(Array.isArray(entry?.trackedRuntimeSessionIds) ? entry.trackedRuntimeSessionIds : []),
        entry?.activeRuntimeSessionId || ''
      ]);
      return tracked.includes(normalized);
    });
  }

  bindRuntimeSession(conversationId, sessionId, patch = {}) {
    return this.patch(conversationId, {
      activeRuntimeSessionId: sessionId,
      trackedRuntimeSessionIds: normalizeTrackedRuntimeSessionIds([
        ...(Array.isArray(this.get(conversationId)?.trackedRuntimeSessionIds)
          ? this.get(conversationId).trackedRuntimeSessionIds
          : []),
        sessionId,
        ...(Array.isArray(patch?.trackedRuntimeSessionIds) ? patch.trackedRuntimeSessionIds : [])
      ]),
      ...patch
    });
  }

  bindSupervisorTask(conversationId, taskId, patch = {}) {
    const current = this.get(conversationId);
    if (!current) return null;
    return this.patch(conversationId, {
      activeTaskId: String(taskId || '').trim() || null,
      trackedTaskIds: normalizeTrackedTaskIds([
        ...(Array.isArray(current?.trackedTaskIds) ? current.trackedTaskIds : []),
        current?.activeTaskId || '',
        taskId
      ]),
      ...patch
    });
  }

  trackSupervisorTasks(conversationId, taskIds = [], patch = {}) {
    const current = this.get(conversationId);
    if (!current) return null;
    return this.patch(conversationId, {
      trackedTaskIds: normalizeTrackedTaskIds([
        ...(Array.isArray(current?.trackedTaskIds) ? current.trackedTaskIds : []),
        current?.activeTaskId || '',
        ...(Array.isArray(taskIds) ? taskIds : [])
      ]),
      ...patch
    });
  }

  trackRuntimeSessions(conversationId, sessionIds = [], patch = {}) {
    const current = this.get(conversationId);
    if (!current) return null;
    return this.patch(conversationId, {
      trackedRuntimeSessionIds: normalizeTrackedRuntimeSessionIds([
        ...(Array.isArray(current?.trackedRuntimeSessionIds) ? current.trackedRuntimeSessionIds : []),
        current?.activeRuntimeSessionId || '',
        ...(Array.isArray(sessionIds) ? sessionIds : [])
      ]),
      ...patch
    });
  }

  untrackRuntimeSession(conversationId, sessionId, patch = {}) {
    const current = this.get(conversationId);
    if (!current) return null;
    const normalized = String(sessionId || '').trim();
    const tracked = normalizeTrackedRuntimeSessionIds(current?.trackedRuntimeSessionIds)
      .filter((entry) => entry !== normalized);
    return this.patch(conversationId, {
      trackedRuntimeSessionIds: tracked,
      ...patch
    });
  }

  clearActiveRuntimeSession(conversationId) {
    const current = this.get(conversationId);
    return this.patch(conversationId, {
      mode: CHANNEL_CONVERSATION_MODE.ASSISTANT,
      activeRuntimeSessionId: null,
      trackedRuntimeSessionIds: normalizeTrackedRuntimeSessionIds(current?.trackedRuntimeSessionIds),
      lastPendingApprovalId: null,
      lastPendingQuestionId: null,
      lastPendingClarificationId: null
    });
  }
}

export const agentChannelConversationStore = new AgentChannelConversationStore();

export default agentChannelConversationStore;
