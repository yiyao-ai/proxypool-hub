import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { mergeJsonRecords } from '../assistant-core/merge-json-records.js';

function nowIso() {
  return new Date().toISOString();
}

function toText(value) {
  return String(value || '').trim();
}

function toNullableText(value) {
  const normalized = toText(value);
  return normalized || null;
}

function normalizeExecutionIds(value, primaryExecutionId = '') {
  const ids = [];
  const seen = new Set();
  for (const entry of [primaryExecutionId].concat(Array.isArray(value) ? value : [])) {
    const normalized = toText(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ids.push(normalized);
  }
  return ids;
}

export function createSupervisorTask({
  id = '',
  conversationId = '',
  title = '',
  goal = '',
  status = 'starting',
  owner = 'cligate',
  executorStrategy = '',
  primaryExecutionId = '',
  executionIds = [],
  summary = '',
  result = '',
  error = '',
  awaitingKind = '',
  awaitingPayload = null,
  startedAt = '',
  lastUpdateAt = '',
  lastUserTurnAt = '',
  lastAssistantTurnAt = '',
  sourceTaskId = '',
  metadata = {}
} = {}) {
  const now = nowIso();
  const normalizedPrimaryExecutionId = toText(primaryExecutionId);
  return {
    id: toText(id) || crypto.randomUUID(),
    conversationId: toText(conversationId),
    title: toText(title) || 'Untitled supervisor task',
    goal: toText(goal),
    status: toText(status) || 'starting',
    owner: toText(owner) || 'cligate',
    executorStrategy: toText(executorStrategy),
    primaryExecutionId: normalizedPrimaryExecutionId || null,
    executionIds: normalizeExecutionIds(executionIds, normalizedPrimaryExecutionId),
    summary: toText(summary),
    result: toText(result),
    error: toText(error),
    awaitingKind: toText(awaitingKind),
    awaitingPayload: awaitingPayload && typeof awaitingPayload === 'object' ? awaitingPayload : null,
    startedAt: toText(startedAt) || now,
    lastUpdateAt: toText(lastUpdateAt) || now,
    lastUserTurnAt: toText(lastUserTurnAt) || '',
    lastAssistantTurnAt: toText(lastAssistantTurnAt) || '',
    sourceTaskId: toNullableText(sourceTaskId),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: now,
    updatedAt: now
  };
}

export class SupervisorTaskStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-orchestrator');
    this.file = join(this.rootDir, 'supervisor-tasks.json');
    this.ensureDirs();
    this.records = this._load();
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
      return Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    let diskTasks = [];
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        diskTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
      } catch {
        diskTasks = [];
      }
    }
    this.records = mergeJsonRecords({
      currentRecords: this.records,
      diskRecords: diskTasks,
      keyOf: (entry) => entry?.id
    });
    writeFileSync(
      this.file,
      JSON.stringify({ tasks: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ conversationId = '', runtimeSessionId = '', status = '', limit = 100 } = {}) {
    const normalizedConversationId = toText(conversationId);
    const normalizedRuntimeSessionId = toText(runtimeSessionId);
    const normalizedStatus = toText(status);
    return this.records
      .filter((entry) => !normalizedConversationId || entry.conversationId === normalizedConversationId)
      .filter((entry) => !normalizedRuntimeSessionId || normalizeExecutionIds(entry.executionIds, entry.primaryExecutionId).includes(normalizedRuntimeSessionId))
      .filter((entry) => !normalizedStatus || entry.status === normalizedStatus)
      .sort((left, right) => String(right.updatedAt || right.lastUpdateAt || '').localeCompare(String(left.updatedAt || left.lastUpdateAt || '')))
      .slice(0, Math.max(1, limit));
  }

  listByConversationId(conversationId, { limit = 100 } = {}) {
    return this.list({ conversationId, limit });
  }

  get(taskId) {
    return this.records.find((entry) => entry.id === toText(taskId)) || null;
  }

  findByRuntimeSessionId(runtimeSessionId) {
    const normalized = toText(runtimeSessionId);
    if (!normalized) return null;
    return this.records.find((entry) => normalizeExecutionIds(entry.executionIds, entry.primaryExecutionId).includes(normalized)) || null;
  }

  save(task = {}) {
    const normalizedPrimaryExecutionId = toText(task.primaryExecutionId);
    const updated = {
      ...task,
      id: toText(task.id) || crypto.randomUUID(),
      conversationId: toText(task.conversationId),
      title: toText(task.title) || 'Untitled supervisor task',
      goal: toText(task.goal),
      status: toText(task.status) || 'starting',
      owner: toText(task.owner) || 'cligate',
      executorStrategy: toText(task.executorStrategy),
      primaryExecutionId: normalizedPrimaryExecutionId || null,
      executionIds: normalizeExecutionIds(task.executionIds, normalizedPrimaryExecutionId),
      summary: toText(task.summary),
      result: toText(task.result),
      error: toText(task.error),
      awaitingKind: toText(task.awaitingKind),
      awaitingPayload: task.awaitingPayload && typeof task.awaitingPayload === 'object' ? task.awaitingPayload : null,
      startedAt: toText(task.startedAt) || nowIso(),
      lastUpdateAt: toText(task.lastUpdateAt) || nowIso(),
      lastUserTurnAt: toText(task.lastUserTurnAt),
      lastAssistantTurnAt: toText(task.lastAssistantTurnAt),
      sourceTaskId: toNullableText(task.sourceTaskId),
      metadata: task.metadata && typeof task.metadata === 'object' ? task.metadata : {},
      createdAt: toText(task.createdAt) || nowIso(),
      updatedAt: nowIso()
    };
    const index = this.records.findIndex((entry) => entry.id === updated.id);
    if (index >= 0) {
      this.records[index] = updated;
    } else {
      this.records.push(updated);
    }
    this._save();
    return updated;
  }

  create(payload = {}) {
    return this.save(createSupervisorTask(payload));
  }

  upsertForRuntime({
    taskId = '',
    conversationId = '',
    runtimeSessionId = '',
    provider = '',
    title = '',
    goal = '',
    status = '',
    summary,
    result,
    error,
    awaitingKind,
    awaitingPayload,
    lastUserTurnAt,
    lastAssistantTurnAt,
    sourceTaskId,
    metadata = {}
  } = {}) {
    const normalizedRuntimeSessionId = toText(runtimeSessionId);
    const existing = this.get(taskId) || this.findByRuntimeSessionId(normalizedRuntimeSessionId);
    const next = existing || createSupervisorTask({
      id: toText(taskId),
      conversationId,
      title: title || goal || normalizedRuntimeSessionId,
      goal,
      status: status || 'starting',
      executorStrategy: provider,
      primaryExecutionId: normalizedRuntimeSessionId,
      executionIds: normalizedRuntimeSessionId ? [normalizedRuntimeSessionId] : [],
      sourceTaskId,
      metadata
    });

    const patch = {
      ...next,
      conversationId: toText(conversationId || next.conversationId),
      title: toText(title || next.title),
      goal: toText(goal || next.goal),
      status: toText(status || next.status),
      executorStrategy: toText(provider || next.executorStrategy),
      primaryExecutionId: toText(next.primaryExecutionId || normalizedRuntimeSessionId) || null,
      executionIds: normalizeExecutionIds(
        (next.executionIds || []).concat(normalizedRuntimeSessionId ? [normalizedRuntimeSessionId] : []),
        next.primaryExecutionId || normalizedRuntimeSessionId
      ),
      metadata: {
        ...(next.metadata || {}),
        ...(metadata && typeof metadata === 'object' ? metadata : {}),
        runtimeSessionId: normalizedRuntimeSessionId || next.metadata?.runtimeSessionId || '',
        provider: toText(provider || next.metadata?.provider || '')
      }
    };

    if (summary !== undefined) patch.summary = toText(summary);
    if (result !== undefined) patch.result = toText(result);
    if (error !== undefined) patch.error = toText(error);
    if (awaitingKind !== undefined) patch.awaitingKind = toText(awaitingKind);
    if (awaitingPayload !== undefined) {
      patch.awaitingPayload = awaitingPayload && typeof awaitingPayload === 'object' ? awaitingPayload : null;
    }
    if (lastUserTurnAt !== undefined) patch.lastUserTurnAt = toText(lastUserTurnAt);
    if (lastAssistantTurnAt !== undefined) patch.lastAssistantTurnAt = toText(lastAssistantTurnAt);
    if (sourceTaskId !== undefined) patch.sourceTaskId = toNullableText(sourceTaskId);
    patch.lastUpdateAt = nowIso();

    return this.save(patch);
  }
}

export const supervisorTaskStore = new SupervisorTaskStore();

export default supervisorTaskStore;
