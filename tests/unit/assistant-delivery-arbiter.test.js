import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import { AgentRuntimeApprovalPolicyStore } from '../../src/agent-runtime/approval-policy-store.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import { AGENT_EVENT_TYPE } from '../../src/agent-runtime/models.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';
import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AgentChannelOutboundDispatcher } from '../../src/agent-channels/outbound-dispatcher.js';
import { buildAssistantCoreDeliveryState } from '../../src/agent-channels/conversation-delivery-arbiter.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

class FakeProvider {
  constructor() {
    this.id = 'codex';
    this.capabilities = {};
  }

  async startTurn({ input, onProviderEvent, onTurnFinished }) {
    onProviderEvent({
      type: AGENT_EVENT_TYPE.MESSAGE,
      payload: { text: `echo:${input}` }
    });
    onTurnFinished({
      status: 'ready',
      summary: `done:${input}`
    });
    return { pid: 777 };
  }
}

function createRuntimeManager() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-delivery-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-delivery-policy-')
    })
  });
}

test('assistant mode suppresses direct runtime completion delivery and re-emits via assistant ownership', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-delivery-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-delivery-store-')
  });
  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage({ text }) {
            sent.push(text);
            return { messageId: `assistant_mode_${sent.length}` };
          }
        };
      }
    }
  });

  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-mode-chat-1',
    externalUserId: 'user-1',
    title: 'tester / telegram',
    metadata: {
      assistantCore: buildAssistantCoreDeliveryState({}, {
        controlMode: 'assistant'
      })
    }
  });
  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo',
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: conversation.id,
      source: {
        kind: 'assistant',
        conversationId: conversation.id
      }
    }
  });
  conversationStore.bindRuntimeSession(conversation.id, session.id);

  await dispatcher.handleRuntimeEvent({
    sessionId: session.id,
    seq: 1001,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'assistant-owned completion should stay internal',
      summary: 'finished'
    }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /当前关注的任务|current task/i);
  const deliveries = deliveryStore.listBySession(session.id, { limit: 20 });
  assert.ok(deliveries.some((entry) => entry.status === 'suppressed'));
  assert.ok(deliveries.some((entry) => entry.status === 'sent' && entry.payload?.sourceType === 'assistant_run_result'));
  const updatedConversation = conversationStore.get(conversation.id);
  assert.equal(updatedConversation.metadata?.assistantCore?.deliveryOwnership, 'assistant-owned');
  assert.equal(updatedConversation.metadata?.supervisor?.brief?.status, 'completed');
});

test('direct-runtime mode continues sending runtime completions directly', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-direct-delivery-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-direct-delivery-store-')
  });
  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage({ text }) {
            sent.push(text);
            return { messageId: `direct_mode_${sent.length}` };
          }
        };
      }
    }
  });

  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'direct-mode-chat-1',
    externalUserId: 'user-1',
    title: 'tester / telegram',
    metadata: {
      assistantCore: buildAssistantCoreDeliveryState({}, {
        controlMode: 'direct-runtime'
      })
    }
  });
  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo',
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: conversation.id,
      source: {
        kind: 'channel',
        conversationId: conversation.id
      }
    }
  });
  conversationStore.bindRuntimeSession(conversation.id, session.id);

  await dispatcher.handleRuntimeEvent({
    sessionId: session.id,
    seq: 1002,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'runtime-owned completion should be delivered',
      summary: 'finished'
    }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'runtime-owned completion should be delivered');
  const deliveries = deliveryStore.listBySession(session.id, { limit: 20 });
  assert.ok(deliveries.some((entry) => entry.status === 'sent'));
  const updatedConversation = conversationStore.get(conversation.id);
  assert.equal(updatedConversation.metadata?.assistantCore?.deliveryOwnership, 'runtime-owned');
});
