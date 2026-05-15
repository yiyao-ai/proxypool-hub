import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
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

function createFixture() {
  const configDir = createTempDir('cligate-scheduled-notify-');
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
  const sentMessages = [];
  const deliverySender = {
    async send({ conversation, channel, payload, message }) {
      sentMessages.push({ conversation, channel, payload, message });
      return { messageId: 'delivered-1' };
    },
    setRegistry() {},
    setDeliveryStore() {}
  };
  const messageService = new AgentOrchestratorMessageService({
    stateCoordinator: coordinator,
    conversationStore,
    deliverySender
  });
  return { conversationStore, coordinator, messageService, sentMessages };
}

test('runScheduledTask with action=notify_user delivers the reminder text to the owning conversation', async () => {
  const { conversationStore, coordinator, messageService, sentMessages } = createFixture();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'ext-conv-notify',
    externalUserId: 'user-1',
    title: 'reminder target'
  });

  const scheduledTask = coordinator.createScheduledTask({
    title: '提醒吃晚饭',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: {
      action: 'notify_user',
      message: '该吃晚饭啦',
      conversationId: conversation.id
    },
    source: 'test'
  });

  const result = await messageService.runScheduledTask(scheduledTask);

  assert.equal(result.action, 'notify_user');
  assert.equal(result.scheduledTaskId, scheduledTask.id);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].conversation.id, conversation.id);
  assert.equal(sentMessages[0].channel, 'dingtalk');
  assert.match(String(sentMessages[0].message.text || ''), /该吃晚饭啦/);
  assert.match(String(sentMessages[0].message.text || ''), /定时任务|定时提醒/);
});

test('runScheduledTask with kind=reminder defaults to notify_user even without explicit action', async () => {
  const { conversationStore, coordinator, messageService, sentMessages } = createFixture();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'ext-conv-default-action',
    externalUserId: 'user-2',
    title: 'default action target'
  });

  const scheduledTask = coordinator.createScheduledTask({
    title: '提醒下班',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { conversationId: conversation.id }
  });

  const result = await messageService.runScheduledTask(scheduledTask);

  assert.equal(result.action, 'notify_user');
  assert.equal(sentMessages.length, 1);
  assert.match(String(sentMessages[0].message.text || ''), /提醒下班/);
});

test('runScheduledTask refuses an empty/malformed reminder instead of spawning a runtime session', async () => {
  const { conversationStore, coordinator, messageService, sentMessages } = createFixture();
  conversationStore.findOrCreateByExternal({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'ext-conv-empty',
    externalUserId: 'user-3',
    title: 'empty target'
  });

  // The new validation prevents creating such a record via the normal
  // path — to test the runtime defense we bypass via the store directly.
  // This simulates a hand-edited / legacy JSON record that somehow made
  // it onto disk with a blank title and no payload.
  const scheduledTask = coordinator.scheduledTaskStore.save({
    kind: 'check_in',
    title: '',
    schedule: { recurrence: 'once', timezone: 'Asia/Shanghai' },
    payload: null,
    state: 'scheduled'
  });

  await assert.rejects(
    () => messageService.runScheduledTask(scheduledTask),
    /no usable title\/payload/i
  );
  assert.equal(sentMessages.length, 0);
});

test('runScheduledTask notify_user fails fast when there are no notify targets', async () => {
  const { coordinator, messageService, sentMessages } = createFixture();
  const scheduledTask = coordinator.createScheduledTask({
    title: '提醒任意',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'notify_user', message: '到点了' },
    notifyTargets: []
  });

  await assert.rejects(
    () => messageService.runScheduledTask(scheduledTask),
    /no notifyTargets/i
  );
  assert.equal(sentMessages.length, 0);
});
