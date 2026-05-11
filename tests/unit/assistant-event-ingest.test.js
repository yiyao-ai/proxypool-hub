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

class FakeInteractiveProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {};
  }

  async startTurn() {
    return {
      pid: 888,
      respondApproval: async () => {},
      respondQuestion: async () => {},
      cancel() {}
    };
  }
}

function createRuntimeManager() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeInteractiveProvider());
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-event-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-event-policy-')
    })
  });
}

async function createConversationAndSession({
  runtimeSessionManager,
  conversationStore,
  controlMode = 'assistant',
  externalConversationId = 'assistant-event-chat-1',
  externalUserId = 'user-1',
  input = 'inspect repo',
  provider = 'codex'
} = {}) {
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId,
    externalUserId,
    title: 'tester / telegram',
    metadata: {
      assistantCore: buildAssistantCoreDeliveryState({}, {
        controlMode
      })
    }
  });
  const session = await runtimeSessionManager.createSession({
    provider,
    input,
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: conversation.id,
      source: {
        kind: controlMode === 'assistant' ? 'assistant' : 'channel',
        conversationId: conversation.id
      }
    }
  });
  conversationStore.bindRuntimeSession(conversation.id, session.id);
  return { conversation, session };
}

test('assistant mode forwards approval requests as assistant-authored messages', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-event-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-event-delivery-')
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
            return { messageId: `assistant_event_${sent.length}` };
          }
        };
      }
    }
  });

  const { conversation, session } = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    provider: 'claude-code'
  });
  const createdApproval = runtimeSessionManager.approvalService.createApproval({
    sessionId: session.id,
    provider: 'claude-code',
    title: 'Read workspace file',
    summary: 'Need permission to continue',
    rawRequest: {
      tool_name: 'Read',
      input: {
        file_path: 'D:\\github\\proxypool-hub\\README.md'
      }
    }
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: session.id,
    seq: 2001,
    type: AGENT_EVENT_TYPE.APPROVAL_REQUEST,
    ts: new Date().toISOString(),
    payload: {
      approvalId: createdApproval.approvalId,
      title: 'Read workspace file',
      summary: 'Need permission to continue',
      rawRequest: {
        tool_name: 'Read',
        input: {
          file_path: 'D:\\github\\proxypool-hub\\README.md'
        }
      }
    }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /需要你的确认|needs your approval/i);
  const deliveries = deliveryStore.listBySession(session.id, { limit: 20 });
  assert.ok(deliveries.some((entry) => entry.status === 'suppressed' && entry.payload?.sourceType === 'runtime_event'));
  assert.ok(deliveries.some((entry) => entry.status === 'sent' && entry.payload?.sourceType === 'assistant_run_result'));
  const updatedConversation = conversationStore.get(conversation.id);
  assert.equal(updatedConversation.lastPendingApprovalId, createdApproval.approvalId);
});

test('assistant mode reports current-task completion through assistant but keeps unrelated completions silent', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-assistant-event-complete-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-event-complete-delivery-')
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
            return { messageId: `assistant_complete_${sent.length}` };
          }
        };
      }
    }
  });

  const primary = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    externalConversationId: 'assistant-event-complete-chat-1',
    input: 'current task'
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: primary.session.id,
    seq: 2002,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'current task complete',
      summary: 'done'
    }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /当前关注的任务|current task/i);

  const secondarySession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'old task',
    cwd: process.cwd(),
    model: '',
    metadata: {
      conversationId: primary.conversation.id,
      source: {
        kind: 'assistant',
        conversationId: primary.conversation.id
      }
    }
  });
  conversationStore.trackRuntimeSessions(primary.conversation.id, [secondarySession.id]);

  await dispatcher.handleRuntimeEvent({
    sessionId: secondarySession.id,
    seq: 2003,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'old task complete',
      summary: 'done'
    }
  });

  assert.equal(sent.length, 1);
  const deliveries = deliveryStore.listByConversation(primary.conversation.id, { limit: 30 });
  assert.ok(deliveries.some((entry) => entry.status === 'suppressed' && entry.sessionId === secondarySession.id));
  assert.ok(!deliveries.some((entry) => entry.status === 'sent' && entry.sessionId === secondarySession.id && entry.payload?.sourceType === 'assistant_run_result'));
});
