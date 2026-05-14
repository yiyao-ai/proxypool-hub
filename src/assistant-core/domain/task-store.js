import { appendUniqueId, createTask, nowIso, toText } from './models.js';
import { JsonEntityStore } from './store-utils.js';

export class TaskStore extends JsonEntityStore {
  constructor(options = {}) {
    super({
      ...options,
      fileName: 'tasks.json',
      rootKey: 'tasks'
    });
  }

  listByProject(projectId, { limit = 100, lifecycleState = '' } = {}) {
    const normalizedProjectId = toText(projectId);
    const normalizedLifecycleState = toText(lifecycleState);
    return this.list({
      limit,
      predicate: (entry) => (
        (!normalizedProjectId || entry.projectId === normalizedProjectId)
        && (!normalizedLifecycleState || entry.lifecycleState === normalizedLifecycleState)
      )
    });
  }

  create(payload = {}) {
    return this.save(createTask(payload));
  }

  save(task = {}) {
    const normalized = createTask({
      ...task,
      id: task.id,
      createdAt: task.createdAt,
      updatedAt: nowIso()
    });
    return super.save(normalized);
  }

  attachExecution(taskId, executionId, { active = true } = {}) {
    const current = this.get(taskId);
    if (!current) return null;
    return this.save({
      ...current,
      allExecutionIds: appendUniqueId(current.allExecutionIds, executionId),
      activeExecutionIds: active
        ? appendUniqueId(current.activeExecutionIds, executionId)
        : current.activeExecutionIds,
      lastActiveAt: nowIso()
    });
  }
}

export const taskStore = new TaskStore();

export default taskStore;
