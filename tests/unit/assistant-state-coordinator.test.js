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

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createCoordinator() {
  const configDir = createTempDir('cligate-assistant-domain-');
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
  return {
    configDir,
    conversationStore,
    coordinator
  };
}

test('StateCoordinator creates person and misc project from conversation and updates conversation binding', () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'session-1',
    externalUserId: 'local-user',
    title: 'Chat UI / session-1'
  });

  const person = coordinator.findOrCreatePersonByConversation(conversation);
  assert.ok(person.id);
  assert.ok(person.miscProjectId);

  const miscProject = coordinator.projectStore.get(person.miscProjectId);
  assert.equal(miscProject.kind, 'misc');
  assert.equal(miscProject.ownerPersonId, person.id);

  const updatedConversation = conversationStore.get(conversation.id);
  assert.equal(updatedConversation.metadata?.assistantDomain?.personId, person.id);
});

test('StateCoordinator creates task and execution, binds runtime, and exposes dashboard snapshot', () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'chat-1',
    externalUserId: 'user-1',
    title: 'telegram / user-1'
  });
  const person = coordinator.findOrCreatePersonByConversation(conversation);
  const project = coordinator.resolveProject({
    personId: person.id,
    conversationId: conversation.id
  });

  const task = coordinator.createTask({
    personId: person.id,
    projectId: project.id,
    title: '天气查询',
    goal: '查上海天气',
    conversationId: conversation.id,
    assistantRationale: {
      routeReason: 'fallback to misc project',
      candidateEvidence: ['no code project matched']
    }
  });
  const execution = coordinator.createExecution({
    taskId: task.id,
    ownerPersonId: person.id,
    provider: 'codex',
    role: 'web-researcher',
    objective: '查上海天气',
    conversationId: conversation.id
  });
  const boundExecution = coordinator.bindExecutionRuntime({
    executionId: execution.id,
    runtimeSessionId: 'runtime-session-1',
    providerSessionId: 'provider-thread-1',
    status: 'running',
    conversationId: conversation.id
  });

  assert.equal(boundExecution.currentRuntimeSessionId, 'runtime-session-1');
  assert.equal(boundExecution.providerSessionId, 'provider-thread-1');

  const dashboard = coordinator.getTaskDashboard(task.id);
  assert.equal(dashboard.task.id, task.id);
  assert.equal(dashboard.executions.length, 1);
  assert.equal(dashboard.activitySnapshot.hasRunningExecution, true);
});

test('StateCoordinator maintains conversation working set and recent messages', () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'ding-1',
    externalUserId: 'user-2',
    title: 'ding / user-2'
  });

  coordinator.updateConversationWorkingSet({
    conversationId: conversation.id,
    patch: {
      primaryProjectId: 'project-1',
      primaryTaskId: 'task-1',
      recentTaskIds: ['task-1', 'task-2'],
      mentionedProjectIds: ['project-1']
    }
  });
  coordinator.appendConversationMessage({
    conversationId: conversation.id,
    role: 'user',
    text: '继续昨天那个任务'
  });

  const updatedConversation = conversationStore.get(conversation.id);
  assert.equal(updatedConversation.metadata?.assistantDomain?.workingSet?.primaryProjectId, 'project-1');
  assert.equal(updatedConversation.metadata?.assistantDomain?.workingSet?.primaryTaskId, 'task-1');
  assert.equal(updatedConversation.metadata?.assistantDomain?.recentMessages?.length, 1);
  assert.equal(updatedConversation.metadata?.assistantDomain?.recentMessages?.[0]?.text, '继续昨天那个任务');
});

test('StateCoordinator ingests a conversation turn through the unified entry', () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'session-ingest-1',
    externalUserId: 'local-user',
    title: 'Chat UI / session-ingest-1'
  });

  const person = coordinator.ingestConversationTurn({
    conversation,
    role: 'user',
    text: '继续处理登录流程'
  });

  const updatedConversation = conversationStore.get(conversation.id);
  assert.ok(person?.id);
  assert.equal(updatedConversation.metadata?.assistantDomain?.personId, person.id);
  assert.equal(updatedConversation.metadata?.assistantDomain?.recentMessages?.length, 1);
  assert.equal(updatedConversation.metadata?.assistantDomain?.recentMessages?.[0]?.role, 'user');
  assert.equal(updatedConversation.metadata?.assistantDomain?.recentMessages?.[0]?.text, '继续处理登录流程');
});

test('StateCoordinator records runtime episodes and resolves execution/task/project linkage from runtime session', () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'runtime-episode-1',
    externalUserId: 'user-episode',
    title: 'telegram / runtime-episode-1'
  });
  const person = coordinator.findOrCreatePersonByConversation(conversation);
  const project = coordinator.resolveProject({
    personId: person.id,
    conversationId: conversation.id
  });
  const task = coordinator.createTask({
    personId: person.id,
    projectId: project.id,
    title: 'Runtime episode task',
    goal: 'Verify episode linkage',
    conversationId: conversation.id
  });
  const execution = coordinator.createExecution({
    taskId: task.id,
    ownerPersonId: person.id,
    provider: 'codex',
    role: 'primary',
    objective: 'Verify runtime episode linkage',
    conversationId: conversation.id
  });
  coordinator.bindExecutionRuntime({
    executionId: execution.id,
    runtimeSessionId: 'runtime-episode-session-1',
    providerSessionId: 'provider-runtime-1',
    status: 'running',
    conversationId: conversation.id
  });

  const episode = coordinator.recordRuntimeEpisode({
    kind: 'runtime.completed',
    conversationId: conversation.id,
    runtimeSessionId: 'runtime-episode-session-1',
    payload: {
      result: 'done'
    }
  });

  assert.equal(episode.personId, person.id);
  assert.equal(episode.projectId, project.id);
  assert.equal(episode.taskId, task.id);
  assert.equal(episode.executionId, execution.id);
  assert.equal(episode.runtimeSessionId, 'runtime-episode-session-1');
  assert.equal(episode.payload.result, 'done');
});

test('StateCoordinator records handoff prepared/consumed episodes and updates execution inbox', () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'handoff-episode-1',
    externalUserId: 'user-handoff',
    title: 'telegram / handoff-episode-1'
  });
  const person = coordinator.findOrCreatePersonByConversation(conversation);
  const project = coordinator.resolveProject({
    personId: person.id,
    conversationId: conversation.id
  });
  const task = coordinator.createTask({
    personId: person.id,
    projectId: project.id,
    title: 'Handoff task',
    goal: 'Verify handoff ledger',
    conversationId: conversation.id
  });
  const execution = coordinator.createExecution({
    taskId: task.id,
    ownerPersonId: person.id,
    provider: 'codex',
    role: 'reviewer',
    objective: 'Verify handoff ledger',
    conversationId: conversation.id
  });

  const prepared = coordinator.addExecutionHandoff({
    targetExecutionId: execution.id,
    kind: 'review_request',
    title: 'Please review latest diff',
    payload: {
      files: ['src/index.js']
    },
    conversationId: conversation.id
  });
  assert.equal(prepared.execution.handoffInbox.length, 1);
  assert.equal(prepared.handoff.kind, 'review_request');

  const consumed = coordinator.consumeExecutionHandoff({
    executionId: execution.id,
    handoffId: prepared.handoff.id,
    conversationId: conversation.id
  });
  assert.equal(consumed.handoff.status, 'consumed');

  const preparedEpisodes = coordinator.episodeLedger.listByEntity({
    executionId: execution.id,
    kind: 'execution_handoff_prepared',
    limit: 10
  });
  const consumedEpisodes = coordinator.episodeLedger.listByEntity({
    executionId: execution.id,
    kind: 'execution_handoff_consumed',
    limit: 10
  });
  assert.equal(preparedEpisodes.length, 1);
  assert.equal(consumedEpisodes.length, 1);
  assert.equal(preparedEpisodes[0].payload.handoffId, prepared.handoff.id);
  assert.equal(consumedEpisodes[0].payload.handoffId, prepared.handoff.id);
});

test('StateCoordinator records scheduled task lifecycle episodes', () => {
  const { conversationStore, coordinator } = createCoordinator();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'scheduled-task-1',
    externalUserId: 'user-scheduled',
    title: 'scheduled-task-1'
  });
  const person = coordinator.findOrCreatePersonByConversation(conversation);
  const project = coordinator.resolveProject({
    personId: person.id,
    conversationId: conversation.id
  });
  const task = coordinator.createTask({
    personId: person.id,
    projectId: project.id,
    title: 'Scheduled task owner',
    goal: 'Verify scheduler episodes',
    conversationId: conversation.id
  });

  const scheduledTask = coordinator.createScheduledTask({
    personId: person.id,
    projectId: project.id,
    taskId: task.id,
    kind: 'check_in',
    title: 'Daily check-in',
    schedule: {
      type: 'once',
      triggerAt: '2026-05-13T00:00:00.000Z'
    }
  });
  const running = coordinator.updateScheduledTaskState({
    id: scheduledTask.id,
    state: 'running',
    reason: 'test_triggered'
  });
  const completed = coordinator.updateScheduledTaskState({
    id: scheduledTask.id,
    state: 'completed',
    patch: {
      lastRunAt: '2026-05-13T00:01:00.000Z',
      lastResultPreview: 'done'
    },
    reason: 'test_completed'
  });

  assert.equal(running.state, 'running');
  assert.equal(completed.state, 'completed');

  const createdEpisodes = coordinator.episodeLedger.listByEntity({
    taskId: task.id,
    kind: 'scheduled_task.created',
    limit: 10
  });
  const triggeredEpisodes = coordinator.episodeLedger.listByEntity({
    taskId: task.id,
    kind: 'scheduled_task.triggered',
    limit: 10
  });
  const completedEpisodes = coordinator.episodeLedger.listByEntity({
    taskId: task.id,
    kind: 'scheduled_task.completed',
    limit: 10
  });
  assert.equal(createdEpisodes.length, 1);
  assert.equal(triggeredEpisodes.length, 1);
  assert.equal(completedEpisodes.length, 1);
});
