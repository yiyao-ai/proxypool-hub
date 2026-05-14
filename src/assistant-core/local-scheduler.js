import stateCoordinator from './domain/state-coordinator.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';

function toText(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function isDue(task = {}, now = Date.now()) {
  const nextRunAt = Date.parse(toText(task?.nextRunAt));
  if (!Number.isFinite(nextRunAt)) {
    return false;
  }
  return nextRunAt <= now && toText(task?.state) === 'scheduled';
}

export class LocalScheduler {
  constructor({
    stateCoordinator: stateCoordinatorArg = stateCoordinator,
    runner = null,
    messageService = agentOrchestratorMessageService
  } = {}) {
    this.stateCoordinator = stateCoordinatorArg;
    this.messageService = messageService;
    this.runner = typeof runner === 'function'
      ? runner
      : async (task) => this.messageService.runScheduledTask(task);
  }

  listDueTasks({ now = Date.now(), limit = 50 } = {}) {
    return this.stateCoordinator.scheduledTaskStore.list({ limit: Math.max(1, limit) })
      .filter((task) => isDue(task, now))
      .slice(0, Math.max(1, limit));
  }

  async runDueTasks({ now = Date.now(), limit = 50 } = {}) {
    const tasks = this.listDueTasks({ now, limit });
    const results = [];
    for (const task of tasks) {
      results.push(await this.runTask(task.id));
    }
    return results;
  }

  async runTask(id = '') {
    const scheduledTask = this.stateCoordinator.scheduledTaskStore.get(toText(id));
    if (!scheduledTask?.id) {
      throw new Error('scheduled task not found');
    }

    this.stateCoordinator.updateScheduledTaskState({
      id: scheduledTask.id,
      state: 'running',
      patch: {
        lastError: ''
      },
      reason: 'local_scheduler_triggered'
    });

    try {
      const result = await this.runner(scheduledTask);
      const updated = this.stateCoordinator.updateScheduledTaskState({
        id: scheduledTask.id,
        state: scheduledTask.schedule?.type === 'once' ? 'completed' : 'scheduled',
        patch: {
          lastRunAt: nowIso(),
          lastResultPreview: toText(result?.summary || result?.result || 'scheduled task completed'),
          nextRunAt: scheduledTask.schedule?.type === 'once'
            ? ''
            : toText(result?.nextRunAt || scheduledTask.nextRunAt)
        },
        reason: 'local_scheduler_success'
      });
      return {
        task: updated,
        result
      };
    } catch (error) {
      const updated = this.stateCoordinator.updateScheduledTaskState({
        id: scheduledTask.id,
        state: 'failed',
        patch: {
          lastRunAt: nowIso(),
          lastError: toText(error?.message || 'scheduled task failed')
        },
        reason: 'local_scheduler_failed'
      });
      return {
        task: updated,
        error
      };
    }
  }
}

export const localScheduler = new LocalScheduler();

export default localScheduler;
