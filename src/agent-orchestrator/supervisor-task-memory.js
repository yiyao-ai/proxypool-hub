function toIso(value) {
  return String(value || '').trim() || new Date().toISOString();
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTaskId(value, fallback = '') {
  const normalized = String(value || fallback || '').trim();
  return normalized || '';
}

function normalizeTaskRecord(record = {}) {
  if (!isObject(record)) return null;
  const sessionId = String(record.sessionId || '').trim();
  if (!sessionId) return null;
  const taskId = normalizeTaskId(record.taskId, sessionId);
  return {
    ...record,
    taskId,
    sessionId,
    provider: String(record.provider || '').trim(),
    title: String(record.title || '').trim(),
    status: String(record.status || '').trim(),
    startedAt: toIso(record.startedAt),
    lastUpdateAt: toIso(record.lastUpdateAt),
    summary: String(record.summary || '').trim(),
    result: String(record.result || '').trim(),
    error: String(record.error || '').trim(),
    originKind: String(record.originKind || '').trim(),
    sourceTitle: String(record.sourceTitle || '').trim(),
    sourceProvider: String(record.sourceProvider || '').trim(),
    sourceStatus: String(record.sourceStatus || '').trim(),
    pendingApprovalTitle: String(record.pendingApprovalTitle || '').trim(),
    pendingQuestion: String(record.pendingQuestion || '').trim()
  };
}

function normalizeTerminalRecord(record = null, fallbackTask = null) {
  if (!isObject(record)) return null;
  const taskId = normalizeTaskId(record.taskId, fallbackTask?.taskId || fallbackTask?.sessionId || record.sessionId || '');
  if (!taskId) return null;
  const hasOwn = (key) => Object.prototype.hasOwnProperty.call(record, key);
  return {
    ...record,
    taskId,
    sessionId: String(record.sessionId || fallbackTask?.sessionId || '').trim(),
    provider: String(record.provider || fallbackTask?.provider || '').trim(),
    title: String(record.title || fallbackTask?.title || '').trim(),
    summary: String(hasOwn('summary') ? record.summary : (fallbackTask?.summary || '')).trim(),
    result: String(hasOwn('result') ? record.result : (fallbackTask?.result || '')).trim(),
    error: String(hasOwn('error') ? record.error : (fallbackTask?.error || '')).trim(),
    completedAt: record.completedAt ? toIso(record.completedAt) : undefined,
    failedAt: record.failedAt ? toIso(record.failedAt) : undefined
  };
}

function buildTaskKeyOrder(next = {}) {
  const order = [];
  const seen = new Set();

  const push = (value) => {
    const normalized = normalizeTaskId(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    order.push(normalized);
  };

  if (Array.isArray(next.taskOrder)) {
    for (const taskId of next.taskOrder) {
      push(taskId);
    }
  }

  if (Array.isArray(next.order)) {
    for (const entry of next.order) {
      push(entry);
    }
  }

  const byTask = isObject(next.byTask) ? next.byTask : {};
  for (const [taskId] of Object.entries(byTask)) {
    push(taskId);
  }

  return order;
}

export function normalizeSupervisorTaskMemory(taskMemory = null) {
  const next = isObject(taskMemory) ? { ...taskMemory } : {};
  const bySession = {};
  const byTask = {};
  const sessionOrder = [];

  const existingBySession = isObject(next.bySession) ? next.bySession : {};
  for (const [sessionId, record] of Object.entries(existingBySession)) {
    const normalized = normalizeTaskRecord({
      ...(isObject(record) ? record : {}),
      sessionId: record?.sessionId || sessionId
    });
    if (!normalized) continue;
    bySession[normalized.sessionId] = normalized;
    byTask[normalized.taskId] = normalized;
    sessionOrder.push(normalized.sessionId);
  }

  const existingByTask = isObject(next.byTask) ? next.byTask : {};
  for (const [taskId, record] of Object.entries(existingByTask)) {
    const normalized = normalizeTaskRecord({
      ...(isObject(record) ? record : {}),
      taskId: record?.taskId || taskId,
      sessionId: record?.sessionId || taskId
    });
    if (!normalized) continue;
    byTask[normalized.taskId] = {
      ...(byTask[normalized.taskId] || {}),
      ...normalized
    };
    bySession[normalized.sessionId] = {
      ...(bySession[normalized.sessionId] || {}),
      ...normalized
    };
    if (!sessionOrder.includes(normalized.sessionId)) {
      sessionOrder.push(normalized.sessionId);
    }
  }

  const legacyCurrent = normalizeTaskRecord(next.current);
  if (legacyCurrent) {
    bySession[legacyCurrent.sessionId] = {
      ...legacyCurrent,
      ...(bySession[legacyCurrent.sessionId] || {})
    };
    byTask[legacyCurrent.taskId] = {
      ...legacyCurrent,
      ...(byTask[legacyCurrent.taskId] || {})
    };
    if (!sessionOrder.includes(legacyCurrent.sessionId)) {
      sessionOrder.push(legacyCurrent.sessionId);
    }
  }

  const currentTask = (normalizeTaskId(next.activeTaskId) ? byTask[normalizeTaskId(next.activeTaskId)] : null)
    || (String(next.activeSessionId || '').trim() ? bySession[String(next.activeSessionId || '').trim()] : null)
    || normalizeTaskRecord(next.currentTask)
    || legacyCurrent
    || null;

  const lastCompletedTask = normalizeTerminalRecord(next.lastCompletedTask, currentTask)
    || normalizeTerminalRecord(next.lastCompleted, currentTask)
    || null;
  const lastFailedTask = normalizeTerminalRecord(next.lastFailedTask, currentTask)
    || normalizeTerminalRecord(next.lastFailed, currentTask)
    || null;

  const taskOrder = buildTaskKeyOrder({
    ...next,
    byTask
  });

  return {
    ...next,
    bySession,
    byTask,
    order: [...new Set((Array.isArray(next.order) ? next.order : []).concat(sessionOrder).filter(Boolean))],
    taskOrder,
    activeSessionId: String(next.activeSessionId || currentTask?.sessionId || '').trim() || null,
    activeTaskId: normalizeTaskId(next.activeTaskId, currentTask?.taskId || currentTask?.sessionId || '') || null,
    lastCompleted: lastCompletedTask
      ? {
          taskId: lastCompletedTask.taskId,
          sessionId: lastCompletedTask.sessionId,
          provider: lastCompletedTask.provider,
          title: lastCompletedTask.title,
          completedAt: toIso(lastCompletedTask.completedAt || lastCompletedTask.lastUpdateAt),
          summary: lastCompletedTask.summary,
          result: lastCompletedTask.result
        }
      : null,
    lastFailed: lastFailedTask
      ? {
          taskId: lastFailedTask.taskId,
          sessionId: lastFailedTask.sessionId,
          provider: lastFailedTask.provider,
          title: lastFailedTask.title,
          failedAt: toIso(lastFailedTask.failedAt || lastFailedTask.lastUpdateAt),
          error: lastFailedTask.error
        }
      : null,
    lastCompletedTask,
    lastFailedTask,
    current: currentTask,
    currentTask
  };
}

export function listSupervisorTaskRecords(taskMemory = null) {
  const normalized = normalizeSupervisorTaskMemory(taskMemory);
  const ids = normalized.taskOrder.filter((taskId) => normalized.byTask[taskId]);
  const missingIds = Object.keys(normalized.byTask).filter((taskId) => !ids.includes(taskId));
  return ids
    .concat(missingIds)
    .map((taskId) => normalized.byTask[taskId])
    .filter(Boolean);
}

export function pickCurrentSupervisorTask(taskMemory = null) {
  const normalized = normalizeSupervisorTaskMemory(taskMemory);
  const byTask = normalized.byTask || {};
  const active = normalized.activeTaskId ? byTask[normalized.activeTaskId] : null;
  if (active) return active;

  const records = listSupervisorTaskRecords(normalized);
  const nonTerminal = records.filter((record) => !['completed', 'failed', 'cancelled'].includes(String(record.status || '')));
  const pool = nonTerminal.length > 0 ? nonTerminal : records;
  return [...pool].sort((left, right) => String(right.lastUpdateAt || '').localeCompare(String(left.lastUpdateAt || '')))[0] || null;
}

export function countOtherActiveSupervisorTasks(taskMemory = null, currentTaskId = '') {
  return listSupervisorTaskRecords(taskMemory)
    .filter((record) => record.taskId !== normalizeTaskId(currentTaskId))
    .filter((record) => !['completed', 'failed', 'cancelled'].includes(String(record.status || '')))
    .length;
}

export function buildTrackedSupervisorSessionIds(taskMemory = null) {
  return listSupervisorTaskRecords(taskMemory).map((record) => record.sessionId);
}

export function buildTrackedSupervisorTaskIds(taskMemory = null) {
  return listSupervisorTaskRecords(taskMemory).map((record) => record.taskId);
}

export function upsertSupervisorTaskRecord(taskMemory = null, sessionId, patch = {}, { activate = false } = {}) {
  const normalized = normalizeSupervisorTaskMemory(taskMemory);
  const id = String(sessionId || patch?.sessionId || '').trim();
  if (!id) {
    return normalized;
  }

  const previous = normalized.bySession[id] || null;
  const taskId = normalizeTaskId(patch?.taskId, previous?.taskId || id);
  const merged = normalizeTaskRecord({
    ...(previous || {}),
    ...patch,
    taskId,
    sessionId: id,
    startedAt: patch?.startedAt || previous?.startedAt || new Date().toISOString(),
    lastUpdateAt: patch?.lastUpdateAt || new Date().toISOString()
  });
  normalized.bySession[id] = merged;
  normalized.byTask[merged.taskId] = merged;
  normalized.order = [...new Set([...(normalized.order || []), id])];
  normalized.taskOrder = [...new Set([...(normalized.taskOrder || []), merged.taskId])];
  if (activate) {
    normalized.activeSessionId = id;
    normalized.activeTaskId = merged.taskId;
  }
  normalized.current = pickCurrentSupervisorTask(normalized);
  normalized.currentTask = normalized.current;
  return normalizeSupervisorTaskMemory(normalized);
}

export function finalizeSupervisorTaskMemory(taskMemory = null, sessionId, patch = {}, terminalKind = '') {
  const next = upsertSupervisorTaskRecord(taskMemory, sessionId, patch);
  const record = next.bySession[String(sessionId || '')] || null;
  if (!record) {
    return next;
  }

  if (terminalKind === 'completed') {
    next.lastCompletedTask = {
      taskId: record.taskId,
      sessionId: record.sessionId,
      provider: record.provider,
      title: record.title,
      completedAt: toIso(record.lastUpdateAt),
      summary: record.summary,
      result: record.result
    };
  }

  if (terminalKind === 'failed') {
    next.lastFailedTask = {
      taskId: record.taskId,
      sessionId: record.sessionId,
      provider: record.provider,
      title: record.title,
      failedAt: toIso(record.lastUpdateAt),
      error: record.error
    };
  }

  next.current = pickCurrentSupervisorTask(next);
  next.currentTask = next.current;
  return normalizeSupervisorTaskMemory(next);
}
