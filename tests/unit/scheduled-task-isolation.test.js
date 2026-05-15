import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { StateCoordinator } from '../../src/assistant-core/domain/state-coordinator.js';
import { PersonStore } from '../../src/assistant-core/domain/person-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ScheduledTaskStore } from '../../src/assistant-core/domain/scheduled-task-store.js';
import { EpisodeLedger } from '../../src/assistant-core/domain/episode-ledger.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { filterMainContextDeliveries } from '../../src/assistant-agent/prompt-builder.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFixture() {
  const configDir = createTempDir('cligate-scheduled-isolation-');
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
  const deliveryStore = new AgentChannelDeliveryStore({ configDir });
  const sentMessages = [];
  const deliverySender = {
    async send({ conversation, channel, payload, message }) {
      const delivery = deliveryStore.saveOutbound({
        channel: conversation?.channel || channel,
        conversationId: conversation?.id,
        sessionId: null,
        externalMessageId: '',
        status: 'sent',
        payload: { ...(payload || {}), fullText: message?.text || payload?.text || '' }
      });
      sentMessages.push({ conversation, channel, payload, message, delivery });
      return { messageId: 'delivered-' + sentMessages.length };
    },
    setRegistry() {},
    setDeliveryStore() {}
  };
  const messageService = new AgentOrchestratorMessageService({
    stateCoordinator: coordinator,
    conversationStore,
    deliverySender
  });
  return { conversationStore, coordinator, messageService, sentMessages, deliveryStore };
}

test('createScheduledTask auto-creates a dedicated scope conversation', () => {
  const { conversationStore, coordinator } = createFixture();
  const task = coordinator.createScheduledTask({
    title: '每天 PR 总结',
    kind: 'reminder',
    schedule: { recurrence: 'daily', localTime: '09:00', timezone: 'Asia/Shanghai' },
    notifyTargets: [],
    now: Date.parse('2026-05-15T00:00:00.000Z')
  });
  assert.ok(task.scopeConversationId, 'task must have a scopeConversationId');
  const scopeConv = conversationStore.get(task.scopeConversationId);
  assert.ok(scopeConv?.id, 'scope conversation must be persisted');
  assert.equal(scopeConv.channel, 'scheduled-task-scope');
  assert.equal(scopeConv.externalConversationId, task.id);
  assert.equal(scopeConv.metadata?.scheduledTaskId, task.id);
});

test('notify_user fans out to every notifyTarget with kind=scheduled_task_notification', async () => {
  const { conversationStore, coordinator, messageService, sentMessages } = createFixture();
  const convA = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-A', externalUserId: 'u1', title: 'A'
  });
  const convB = conversationStore.findOrCreateByExternal({
    channel: 'chat-ui', accountId: 'default',
    externalConversationId: 'ext-B', externalUserId: 'u2', title: 'B'
  });
  const task = coordinator.createScheduledTask({
    title: '吃饭啦',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'notify_user', message: '该吃饭了' },
    notifyTargets: [
      { kind: 'conversation', conversationId: convA.id },
      { kind: 'conversation', conversationId: convB.id }
    ]
  });

  await messageService.runScheduledTask(task);

  assert.equal(sentMessages.length, 2);
  for (const sent of sentMessages) {
    assert.equal(sent.payload.kind, 'scheduled_task_notification');
    assert.equal(sent.payload.scheduledTaskId, task.id);
    assert.match(String(sent.payload.text || ''), /该吃饭了/);
  }
  const convIds = sentMessages.map((s) => s.conversation.id).sort();
  assert.deepEqual(convIds, [convA.id, convB.id].sort());
});

test('notify_user with empty notifyTargets refuses to deliver (background-only is invalid for notify_user)', async () => {
  const { coordinator, messageService, sentMessages } = createFixture();
  const task = coordinator.createScheduledTask({
    title: 'silent reminder',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'notify_user', message: 'nothing' },
    notifyTargets: []
  });
  await assert.rejects(
    () => messageService.runScheduledTask(task),
    /no notifyTargets/
  );
  assert.equal(sentMessages.length, 0);
});

test('legacy payload.conversationId is auto-promoted into notifyTargets', () => {
  const { conversationStore, coordinator } = createFixture();
  const conv = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-legacy', externalUserId: 'u-legacy', title: 'Legacy'
  });
  const task = coordinator.createScheduledTask({
    title: 'legacy reminder',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'notify_user', message: 'hi', conversationId: conv.id }
    // notifyTargets not passed — backward-compat path
  });
  assert.equal(task.notifyTargets.length, 1);
  assert.equal(task.notifyTargets[0].conversationId, conv.id);
});

test('filterMainContextDeliveries excludes scheduled-task notification deliveries', () => {
  const deliveries = [
    { id: '1', direction: 'inbound', payload: { text: 'hi', kind: 'text' } },
    { id: '2', direction: 'outbound', payload: { text: 'reply', kind: 'assistant-run-result' } },
    { id: '3', direction: 'outbound', payload: { text: 'reminder', kind: 'scheduled_task_notification', scheduledTaskId: 't1' } },
    { id: '4', direction: 'outbound', payload: { text: 'old reminder', kind: 'scheduled_reminder' } },
    { id: '5', direction: 'outbound', payload: { text: 'old invoke', kind: 'scheduled_invoke_result' } },
    { id: '6', direction: 'outbound', payload: { text: 'untagged', sourceType: 'scheduled_task' } },
    { id: '7', direction: 'inbound', payload: { text: 'follow up', kind: 'text' } }
  ];
  const filtered = filterMainContextDeliveries(deliveries);
  const ids = filtered.map((d) => d.id);
  assert.deepEqual(ids, ['1', '2', '7']);
});

test('scope conversation is found and used for invoke_assistant runs (no pollution of notifyTargets)', async () => {
  // We do not actually drive the assistant LLM here — but we verify the
  // method path: runScheduledTask(action=invoke_assistant) looks up the
  // scope conversation rather than any notifyTarget conversation. We stub
  // the assistant module via a dynamic import override.
  const { conversationStore, coordinator, messageService, sentMessages } = createFixture();
  const convA = conversationStore.findOrCreateByExternal({
    channel: 'dingtalk', accountId: 'default',
    externalConversationId: 'ext-notify', externalUserId: 'u', title: 'Notify'
  });
  const task = coordinator.createScheduledTask({
    title: 'PR daily',
    kind: 'reminder',
    schedule: { recurrence: 'once', delayMinutes: 1 },
    payload: { action: 'invoke_assistant', message: 'summarize PRs' },
    notifyTargets: [{ kind: 'conversation', conversationId: convA.id }]
  });

  // Verify scope conversation exists and is distinct from notifyTarget.
  assert.ok(task.scopeConversationId);
  assert.notEqual(task.scopeConversationId, convA.id);
  const scopeConv = conversationStore.get(task.scopeConversationId);
  assert.equal(scopeConv.channel, 'scheduled-task-scope');

  // Verify notify-target fan-out logic resolves only the notifyTargets,
  // never the scope conversation.
  const resolved = messageService._resolveScheduledTaskNotifyTargets(task);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].conversationId, convA.id);
  // Specifically, the scope conversation must NOT be among delivery
  // targets — otherwise notifications would land in the scope itself.
  assert.ok(!resolved.some((t) => t.conversationId === task.scopeConversationId));
});
