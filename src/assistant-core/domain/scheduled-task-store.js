import { createScheduledTask, nowIso, toText } from './models.js';
import { JsonEntityStore } from './store-utils.js';

export class ScheduledTaskStore extends JsonEntityStore {
  constructor(options = {}) {
    super({
      ...options,
      fileName: 'scheduled-tasks.json',
      rootKey: 'scheduledTasks'
    });
  }

  listByPerson(personId, { limit = 100, state = '', kind = '' } = {}) {
    const normalizedPersonId = toText(personId);
    const normalizedState = toText(state);
    const normalizedKind = toText(kind);
    return this.list({
      limit,
      predicate: (entry) => (
        (!normalizedPersonId || entry.personId === normalizedPersonId)
        && (!normalizedState || entry.state === normalizedState)
        && (!normalizedKind || entry.kind === normalizedKind)
      )
    });
  }

  listByConversation(conversationId, {
    limit = 100,
    states = ['scheduled', 'running', 'paused']
  } = {}) {
    const normalizedConversationId = toText(conversationId);
    if (!normalizedConversationId) return [];
    const stateSet = new Set((states || []).map(toText).filter(Boolean));
    return this.list({
      limit,
      predicate: (entry) => {
        // Match either: the task's legacy payload.conversationId OR any
        // entry in the new notifyTargets[] list. This is what "tasks
        // associated with this conversation" means under the new model.
        const targets = Array.isArray(entry?.notifyTargets) ? entry.notifyTargets : [];
        const matched = targets.some((t) => toText(t?.conversationId) === normalizedConversationId)
          || toText(entry?.payload?.conversationId) === normalizedConversationId
          || toText(entry?.metadata?.conversationId) === normalizedConversationId;
        if (!matched) return false;
        if (stateSet.size === 0) return true;
        return stateSet.has(toText(entry.state));
      }
    });
  }

  create(payload = {}) {
    return this.save(createScheduledTask(payload));
  }

  save(task = {}) {
    const normalized = createScheduledTask({
      ...task,
      id: task.id,
      createdAt: task.createdAt,
      updatedAt: nowIso()
    });
    return super.save(normalized);
  }
}

export const scheduledTaskStore = new ScheduledTaskStore();

export default scheduledTaskStore;
