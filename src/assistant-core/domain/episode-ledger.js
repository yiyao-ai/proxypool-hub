import { createEpisode, toText } from './models.js';
import { JsonEntityStore } from './store-utils.js';

export class EpisodeLedger extends JsonEntityStore {
  constructor(options = {}) {
    super({
      ...options,
      fileName: 'episodes.json',
      rootKey: 'episodes'
    });
  }

  append(payload = {}) {
    return super.save(createEpisode(payload));
  }

  listByEntity({
    personId = '',
    projectId = '',
    taskId = '',
    executionId = '',
    runtimeSessionId = '',
    conversationId = '',
    kind = '',
    limit = 100
  } = {}) {
    const normalized = {
      personId: toText(personId),
      projectId: toText(projectId),
      taskId: toText(taskId),
      executionId: toText(executionId),
      runtimeSessionId: toText(runtimeSessionId),
      conversationId: toText(conversationId),
      kind: toText(kind)
    };
    return this.list({
      limit,
      sortBy: 'createdAt',
      predicate: (entry) => (
        (!normalized.personId || entry.personId === normalized.personId)
        && (!normalized.projectId || entry.projectId === normalized.projectId)
        && (!normalized.taskId || entry.taskId === normalized.taskId)
        && (!normalized.executionId || entry.executionId === normalized.executionId)
        && (!normalized.runtimeSessionId || entry.runtimeSessionId === normalized.runtimeSessionId)
        && (!normalized.conversationId || entry.conversationId === normalized.conversationId)
        && (!normalized.kind || entry.kind === normalized.kind)
      )
    });
  }
}

export const episodeLedger = new EpisodeLedger();

export default episodeLedger;
