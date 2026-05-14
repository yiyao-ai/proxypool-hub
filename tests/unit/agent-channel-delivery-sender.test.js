import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentChannelDeliverySender } from '../../src/agent-channels/delivery-sender.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { StateCoordinator } from '../../src/assistant-core/domain/state-coordinator.js';
import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { PersonStore } from '../../src/assistant-core/domain/person-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ScheduledTaskStore } from '../../src/assistant-core/domain/scheduled-task-store.js';
import { EpisodeLedger } from '../../src/assistant-core/domain/episode-ledger.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createCoordinator(conversationStore) {
  const configDir = createTempDir('cligate-delivery-sender-domain-');
  return new StateCoordinator({
    conversationStore,
    personStore: new PersonStore({ configDir }),
    projectStore: new ProjectStore({ configDir }),
    taskStore: new TaskStore({ configDir }),
    executionStore: new ExecutionStore({ configDir }),
    scheduledTaskStore: new ScheduledTaskStore({ configDir }),
    episodeLedger: new EpisodeLedger({ configDir })
  });
}

test('AgentChannelDeliverySender records sent and suppressed deliveries into EpisodeLedger', async () => {
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-delivery-sender-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-delivery-sender-store-')
  });
  const coordinator = createCoordinator(conversationStore);
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'delivery-sender-chat-1',
    externalUserId: 'user-1',
    title: 'delivery sender'
  });

  const sender = new AgentChannelDeliverySender({
    deliveryStore,
    stateCoordinator: coordinator,
    registry: {
      get() {
        return {
          async sendMessage() {
            return { messageId: 'delivery-message-1' };
          }
        };
      }
    }
  });

  await sender.send({
    conversation,
    sessionId: 'runtime-session-delivery-1',
    eventSeq: 1,
    payload: {
      text: 'delivery sent'
    },
    message: {
      text: 'delivery sent'
    }
  });

  sender.suppress({
    conversation,
    sessionId: 'runtime-session-delivery-1',
    eventSeq: 2,
    payload: {
      text: 'delivery suppressed'
    },
    reason: 'assistant_mode_suppressed'
  });

  const sentEpisodes = coordinator.episodeLedger.listByEntity({
    conversationId: conversation.id,
    runtimeSessionId: 'runtime-session-delivery-1',
    kind: 'delivery.sent',
    limit: 10
  });
  assert.equal(sentEpisodes.length, 1);
  assert.equal(sentEpisodes[0].payload.externalMessageId, 'delivery-message-1');
  assert.equal(sentEpisodes[0].payload.text, 'delivery sent');

  const suppressedEpisodes = coordinator.episodeLedger.listByEntity({
    conversationId: conversation.id,
    runtimeSessionId: 'runtime-session-delivery-1',
    kind: 'delivery.suppressed',
    limit: 10
  });
  assert.equal(suppressedEpisodes.length, 1);
  assert.equal(suppressedEpisodes[0].payload.suppressionReason, 'assistant_mode_suppressed');
  assert.equal(suppressedEpisodes[0].payload.text, 'delivery suppressed');
});
