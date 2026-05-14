import { appendUniqueId, createExecution, nowIso, toText } from './models.js';
import { JsonEntityStore } from './store-utils.js';

export class ExecutionStore extends JsonEntityStore {
  constructor(options = {}) {
    super({
      ...options,
      fileName: 'executions.json',
      rootKey: 'executions'
    });
  }

  listByTask(taskId, { limit = 100, status = '' } = {}) {
    const normalizedTaskId = toText(taskId);
    const normalizedStatus = toText(status);
    return this.list({
      limit,
      predicate: (entry) => (
        (!normalizedTaskId || entry.taskId === normalizedTaskId)
        && (!normalizedStatus || entry.status === normalizedStatus)
      )
    });
  }

  findByRuntimeSessionId(runtimeSessionId) {
    const normalizedRuntimeSessionId = toText(runtimeSessionId);
    if (!normalizedRuntimeSessionId) return null;
    return this.records.find((entry) => (
      entry.currentRuntimeSessionId === normalizedRuntimeSessionId
      || (Array.isArray(entry.runtimeSessionHistory) && entry.runtimeSessionHistory.includes(normalizedRuntimeSessionId))
    )) || null;
  }

  create(payload = {}) {
    return this.save(createExecution(payload));
  }

  save(execution = {}) {
    const normalized = createExecution({
      ...execution,
      id: execution.id,
      createdAt: execution.createdAt,
      updatedAt: nowIso()
    });
    return super.save(normalized);
  }

  bindRuntimeSession(executionId, runtimeSessionId, patch = {}) {
    const current = this.get(executionId);
    if (!current) return null;
    return this.save({
      ...current,
      ...patch,
      currentRuntimeSessionId: toText(runtimeSessionId),
      runtimeSessionHistory: appendUniqueId(current.runtimeSessionHistory, runtimeSessionId),
      updatedAt: nowIso()
    });
  }
}

export const executionStore = new ExecutionStore();

export default executionStore;
