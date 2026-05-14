import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { StateCoordinator } from '../../src/assistant-core/domain/state-coordinator.js';
import { PersonStore } from '../../src/assistant-core/domain/person-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ScheduledTaskStore } from '../../src/assistant-core/domain/scheduled-task-store.js';
import { EpisodeLedger } from '../../src/assistant-core/domain/episode-ledger.js';
import { LocalScheduler } from '../../src/assistant-core/local-scheduler.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createCoordinator() {
  const configDir = createTempDir('cligate-local-scheduler-');
  const conversationStore = new AgentChannelConversationStore({ configDir });
  const coordinator = new StateCoordinator({
    conversationStore,
    personStore: new PersonStore({ configDir }),
    projectStore: new ProjectStore({ configDir }),
    taskStore: new TaskStore({ configDir }),
    executionStore: new ExecutionStore({ configDir }),
    scheduledTaskStore: new ScheduledTaskStore({ configDir }),
    episodeLedger: new EpisodeLedger({ configDir })
  });
  return { conversationStore, coordinator };
}

test('LocalScheduler runs due tasks and records success lifecycle episodes', async () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'local-scheduler-success',
    externalUserId: 'user-1',
    title: 'local scheduler success'
  });
  const person = coordinator.findOrCreatePersonByConversation(conversation);
  const project = coordinator.resolveProject({
    personId: person.id,
    conversationId: conversation.id
  });
  const task = coordinator.createTask({
    personId: person.id,
    projectId: project.id,
    title: 'Scheduled runner',
    goal: 'Verify local scheduler',
    conversationId: conversation.id
  });
  const scheduledTask = coordinator.createScheduledTask({
    personId: person.id,
    projectId: project.id,
    taskId: task.id,
    kind: 'check_in',
    title: 'Run now',
    schedule: {
      type: 'once',
      triggerAt: '2026-05-13T00:00:00.000Z'
    },
    metadata: {
      conversationId: conversation.id
    }
  });
  coordinator.updateScheduledTaskState({
    id: scheduledTask.id,
    state: 'scheduled',
    patch: {
      nextRunAt: '2026-05-13T00:00:00.000Z'
    },
    reason: 'prepare_due_task'
  });

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => ({
      summary: 'scheduler success'
    })
  });
  const results = await scheduler.runDueTasks({
    now: Date.parse('2026-05-13T00:00:01.000Z')
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].task.state, 'completed');

  const triggered = coordinator.episodeLedger.listByEntity({
    taskId: task.id,
    kind: 'scheduled_task.triggered',
    limit: 10
  });
  const completed = coordinator.episodeLedger.listByEntity({
    taskId: task.id,
    kind: 'scheduled_task.completed',
    limit: 10
  });
  assert.equal(triggered.length >= 1, true);
  assert.equal(completed.length >= 1, true);
});

test('LocalScheduler records failed lifecycle when runner throws', async () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'local-scheduler-failed',
    externalUserId: 'user-2',
    title: 'local scheduler failed'
  });
  const person = coordinator.findOrCreatePersonByConversation(conversation);
  const project = coordinator.resolveProject({
    personId: person.id,
    conversationId: conversation.id
  });
  const task = coordinator.createTask({
    personId: person.id,
    projectId: project.id,
    title: 'Scheduled runner fail',
    goal: 'Verify failed lifecycle',
    conversationId: conversation.id
  });
  const scheduledTask = coordinator.createScheduledTask({
    personId: person.id,
    projectId: project.id,
    taskId: task.id,
    kind: 'check_in',
    title: 'Run and fail',
    schedule: {
      type: 'once',
      triggerAt: '2026-05-13T00:00:00.000Z'
    }
  });
  coordinator.updateScheduledTaskState({
    id: scheduledTask.id,
    state: 'scheduled',
    patch: {
      nextRunAt: '2026-05-13T00:00:00.000Z'
    },
    reason: 'prepare_due_task'
  });

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    runner: async () => {
      throw new Error('boom');
    }
  });
  const [result] = await scheduler.runDueTasks({
    now: Date.parse('2026-05-13T00:00:01.000Z')
  });

  assert.equal(result.task.state, 'failed');
  const failed = coordinator.episodeLedger.listByEntity({
    taskId: task.id,
    kind: 'scheduled_task.failed',
    limit: 10
  });
  assert.equal(failed.length >= 1, true);
  assert.equal(failed[0].payload.reason, 'local_scheduler_failed');
});

test('LocalScheduler defaults to messageService.runScheduledTask when no custom runner is provided', async () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'local-scheduler-default-runner',
    externalUserId: 'user-3',
    title: 'local scheduler default runner'
  });
  const person = coordinator.findOrCreatePersonByConversation(conversation);
  const project = coordinator.resolveProject({
    personId: person.id,
    conversationId: conversation.id
  });
  const task = coordinator.createTask({
    personId: person.id,
    projectId: project.id,
    title: 'Scheduled default runner',
    goal: 'Verify messageService bridge',
    conversationId: conversation.id
  });
  const scheduledTask = coordinator.createScheduledTask({
    personId: person.id,
    projectId: project.id,
    taskId: task.id,
    kind: 'check_in',
    title: 'Run via message service',
    schedule: {
      type: 'once',
      triggerAt: '2026-05-13T00:00:00.000Z'
    }
  });
  coordinator.updateScheduledTaskState({
    id: scheduledTask.id,
    state: 'scheduled',
    patch: {
      nextRunAt: '2026-05-13T00:00:00.000Z'
    },
    reason: 'prepare_due_task'
  });

  const scheduler = new LocalScheduler({
    stateCoordinator: coordinator,
    messageService: {
      async runScheduledTask(taskInput) {
        assert.equal(taskInput.id, scheduledTask.id);
        return {
          summary: 'message service runner ok'
        };
      }
    }
  });

  const [result] = await scheduler.runDueTasks({
    now: Date.parse('2026-05-13T00:00:01.000Z')
  });

  assert.equal(result.task.state, 'completed');
  assert.equal(result.result.summary, 'message service runner ok');
});
