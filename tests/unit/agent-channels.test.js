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
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { AgentPreferenceStore } from '../../src/agent-core/preference-store.js';
import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AgentChannelPairingStore } from '../../src/agent-channels/pairing-store.js';
import { AgentChannelRouter } from '../../src/agent-channels/router.js';
import { AgentChannelManager } from '../../src/agent-channels/manager.js';
import { AgentChannelOutboundDispatcher } from '../../src/agent-channels/outbound-dispatcher.js';
import FeishuChannelProvider from '../../src/agent-channels/providers/feishu-provider.js';
import DingTalkChannelProvider from '../../src/agent-channels/providers/dingtalk-provider.js';
import TelegramChannelProvider from '../../src/agent-channels/providers/telegram-provider.js';
import { formatAgentRuntimeEventForChannel } from '../../src/agent-channels/formatter.js';
import {
  buildAgentChannelSessionRecords,
  buildAgentChannelSessionRecordDetail
} from '../../src/routes/agent-channels-route.js';

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

  async startTurn({ onApprovalRequest, onQuestionRequest }) {
    onApprovalRequest({
      title: 'Need permission',
      summary: 'Run command'
      ,
      rawRequest: {
        requestId: 'approval-request-1',
        subtype: 'can_use_tool',
        tool_name: 'Read',
        blocked_path: 'D:\\lovetoday\\index.html',
        input: {
          file_path: 'D:\\lovetoday\\index.html'
        }
      }
    });
    onQuestionRequest({
      questionId: 'question-1',
      text: 'Continue?'
    });
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
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-agent-channels-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-agent-channels-runtime-policy-')
    })
  });
}

function createInteractiveRuntimeManager() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeInteractiveProvider());
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-agent-channels-runtime-interactive-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-agent-channels-runtime-interactive-policy-')
    })
  });
}

function createHybridRuntimeManager() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeInteractiveProvider());
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-agent-channels-runtime-hybrid-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-agent-channels-runtime-hybrid-policy-')
    })
  });
}

test('AgentRuntimeEventBus supports subscribeAll listeners', () => {
  const bus = new AgentRuntimeEventBus();
  const seen = [];
  const unsubscribe = bus.subscribeAll((event) => {
    seen.push(event.type);
  });

  bus.publish({
    sessionId: 'session_1',
    seq: 1,
    type: AGENT_EVENT_TYPE.STARTED,
    payload: {}
  });

  unsubscribe();
  bus.publish({
    sessionId: 'session_1',
    seq: 2,
    type: AGENT_EVENT_TYPE.FAILED,
    payload: {}
  });

  assert.deepEqual(seen, [AGENT_EVENT_TYPE.STARTED]);
});

test('AgentChannelConversationStore finds or creates conversations by external identity', () => {
  const store = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-conv-')
  });

  const first = store.findOrCreateByExternal({
    channel: 'telegram',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    title: 'user_1 / telegram'
  });
  const second = store.findOrCreateByExternal({
    channel: 'telegram',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1'
  });

  assert.equal(first.id, second.id);
  assert.equal(store.list().length, 1);
});

test('AgentChannelConversationStore keeps tracked runtime session bindings beyond the active session', () => {
  const store = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-conv-tracked-')
  });

  const conversation = store.findOrCreateByExternal({
    channel: 'telegram',
    externalConversationId: 'chat_tracked_1',
    externalUserId: 'user_tracked_1',
    title: 'tracked'
  });

  store.bindRuntimeSession(conversation.id, 'session_primary');
  store.trackRuntimeSessions(conversation.id, ['session_secondary']);

  const updated = store.get(conversation.id);
  assert.equal(updated.activeRuntimeSessionId, 'session_primary');
  assert.deepEqual(updated.trackedRuntimeSessionIds, ['session_primary', 'session_secondary']);
  assert.equal(store.listByTrackedRuntimeSessionId('session_primary').length, 1);
  assert.equal(store.listByTrackedRuntimeSessionId('session_secondary').length, 1);
});

test('AgentChannelDeliveryStore tracks processed inbound keys and outbound deliveries', () => {
  const store = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-delivery-')
  });

  assert.equal(store.isInboundProcessed('telegram:1'), false);
  assert.equal(store.markInboundProcessed('telegram:1'), true);
  assert.equal(store.isInboundProcessed('telegram:1'), true);

  store.saveInbound({
    channel: 'telegram',
    conversationId: 'conv_1',
    externalMessageId: 'in_1',
    payload: { text: 'hello' }
  });

  store.saveOutbound({
    channel: 'telegram',
    conversationId: 'conv_1',
    status: 'sent',
    payload: { text: 'done' }
  });

  const deliveries = store.listByConversation('conv_1');
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0].channel, 'telegram');
  assert.equal(deliveries[0].direction, 'inbound');
  assert.equal(deliveries[1].direction, 'outbound');
});

test('AgentChannelPairingStore creates and approves pairing requests', () => {
  const store = new AgentChannelPairingStore({
    configDir: createTempDir('cligate-agent-channels-pairing-')
  });

  const record = store.createRequest({
    channel: 'feishu',
    externalUserId: 'user_1',
    externalConversationId: 'chat_1'
  });
  assert.equal(record.status, 'pending');
  assert.equal(store.isApproved('feishu', 'default', 'user_1', 'chat_1'), false);

  const approved = store.approve({
    channel: 'feishu',
    externalUserId: 'user_1',
    externalConversationId: 'chat_1',
    approvedBy: 'tester'
  });
  assert.equal(approved.status, 'approved');
  assert.equal(store.isApproved('feishu', 'default', 'user_1', 'chat_1'), true);
});

test('AgentOrchestratorMessageService starts and continues runtime sessions from commands', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/agent codex inspect repo' },
    conversation: null
  });
  assert.equal(started.type, 'runtime_started');
  assert.equal(started.session.provider, 'codex');

  const continued = await service.routeUserMessage({
    message: { text: 'follow up' },
    conversation: { activeRuntimeSessionId: started.session.id }
  });
  assert.equal(continued.type, 'runtime_continued');
  assert.equal(continued.session.turnCount, 2);
});

test('AgentOrchestratorMessageService supports /cx and /cc mobile aliases', async () => {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeInteractiveProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-agent-channels-runtime-alias-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-agent-channels-runtime-alias-policy-')
    })
  });
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const codexStarted = await service.routeUserMessage({
    message: { text: '/cx inspect repo' },
    conversation: null
  });
  assert.equal(codexStarted.type, 'runtime_started');
  assert.equal(codexStarted.session.provider, 'codex');

  const claudeStarted = await service.routeUserMessage({
    message: { text: '/cc review this directory' },
    conversation: null
  });
  assert.equal(claudeStarted.type, 'runtime_started');
  assert.equal(claudeStarted.session.provider, 'claude-code');
  assert.equal(claudeStarted.startedFresh, true);
});

test('AgentOrchestratorMessageService supports /new cx and /new cc mobile aliases', async () => {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeInteractiveProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-agent-channels-runtime-new-alias-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-agent-channels-runtime-new-alias-policy-')
    })
  });
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const initial = await service.routeUserMessage({
    message: { text: '/cx inspect repo' },
    conversation: null
  });

  const freshClaude = await service.routeUserMessage({
    message: { text: '/new cc review this directory' },
    conversation: { activeRuntimeSessionId: initial.session.id }
  });
  assert.equal(freshClaude.type, 'runtime_started');
  assert.equal(freshClaude.session.provider, 'claude-code');
  assert.equal(freshClaude.replacedSessionId, initial.session.id);

  const freshCodex = await service.routeUserMessage({
    message: { text: '/new cx write a script' },
    conversation: { activeRuntimeSessionId: freshClaude.session.id }
  });
  assert.equal(freshCodex.type, 'runtime_started');
  assert.equal(freshCodex.session.provider, 'codex');
  assert.equal(freshCodex.replacedSessionId, freshClaude.session.id);
});

test('AgentOrchestratorMessageService only injects strict Codex defaults when cwd is set', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const unrestricted = await service.startRuntimeTask({
    provider: 'codex',
    input: 'inspect repo'
  });
  assert.deepEqual(unrestricted.metadata.runtimeOptions || {}, {});

  const restricted = await service.startRuntimeTask({
    provider: 'codex',
    input: 'inspect repo',
    cwd: 'D:\\tmp'
  });
  assert.equal(restricted.metadata.runtimeOptions?.codex?.approvalPolicy, 'on-request');
  assert.equal(restricted.metadata.runtimeOptions?.codex?.sandboxMode, 'workspace-write');
});

test('AgentOrchestratorMessageService supports explicit session reset and fresh runtime starts', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/agent codex inspect repo' },
    conversation: null
  });

  const reset = await service.routeUserMessage({
    message: { text: '/new' },
    conversation: { activeRuntimeSessionId: started.session.id }
  });
  assert.equal(reset.type, 'conversation_reset');
  assert.equal(reset.previousSessionId, started.session.id);

  const fresh = await service.routeUserMessage({
    message: { text: '/new codex fix the failing test' },
    conversation: { activeRuntimeSessionId: started.session.id }
  });
  assert.equal(fresh.type, 'runtime_started');
  assert.equal(fresh.startedFresh, true);
  assert.equal(fresh.replacedSessionId, started.session.id);
  assert.notEqual(fresh.session.id, started.session.id);
});

test('AgentChannelRouter binds runtime sessions to conversations', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-router-delivery-')
  });
  const router = new AgentChannelRouter({
    conversationStore: new AgentChannelConversationStore({
      configDir: createTempDir('cligate-agent-channels-router-conv-')
    }),
    deliveryStore,
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-router-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  const result = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_1',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '/agent codex inspect repo',
    messageType: 'text'
  });

  assert.equal(result.type, 'runtime_started');
  assert.equal(result.conversation.activeRuntimeSessionId, result.session.id);
  assert.equal(result.conversation.mode, 'agent-runtime');
  const deliveries = deliveryStore.listByConversation(result.conversation.id);
  assert.equal(deliveries[0].direction, 'inbound');
  assert.equal(deliveries[0].payload.text, '/agent codex inspect repo');
  assert.equal(deliveries[0].sessionId, result.session.id);
});

test('AgentChannelRouter enforces pairing dynamically from route options', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const router = new AgentChannelRouter({
    conversationStore: new AgentChannelConversationStore({
      configDir: createTempDir('cligate-agent-channels-router-dynamic-pairing-conv-')
    }),
    deliveryStore: new AgentChannelDeliveryStore({
      configDir: createTempDir('cligate-agent-channels-router-dynamic-pairing-delivery-')
    }),
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-router-dynamic-pairing-store-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  const required = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_pair_1',
    externalConversationId: 'chat_pair_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '/agent codex inspect repo',
    messageType: 'text'
  }, {
    requirePairing: true,
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(required.type, 'pairing_required');
  assert.equal(required.pairing.status, 'pending');

  const bypassed = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_pair_2',
    externalConversationId: 'chat_pair_2',
    externalUserId: 'user_2',
    externalUserName: 'bob',
    text: '/agent codex inspect repo',
    messageType: 'text'
  }, {
    requirePairing: false,
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(bypassed.type, 'runtime_started');
  assert.equal(bypassed.session.provider, 'codex');
});

test('AgentChannelRouter clears conversation binding on explicit reset command', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-router-reset-conv-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore: new AgentChannelDeliveryStore({
      configDir: createTempDir('cligate-agent-channels-router-reset-delivery-')
    }),
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-router-reset-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  const started = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_1',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '/agent codex inspect repo',
    messageType: 'text'
  });

  const reset = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_2',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '/new',
    messageType: 'text'
  });

  assert.equal(started.conversation.activeRuntimeSessionId, started.session.id);
  assert.equal(reset.type, 'conversation_reset');
  assert.equal(reset.conversation.activeRuntimeSessionId, null);
  assert.equal(reset.conversation.mode, 'assistant');
});

test('completed runtime events keep channel conversations attached to the same session', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-sticky-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-sticky-delivery-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-sticky-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage() {
            return { messageId: 'outbound_1' };
          }
        };
      }
    }
  });

  const started = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_1',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '/agent codex inspect repo',
    messageType: 'text'
  });

  conversationStore.patch(started.conversation.id, {
    lastPendingApprovalId: 'approval_1',
    lastPendingQuestionId: 'question_1'
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: started.session.id,
    seq: 999,
    type: AGENT_EVENT_TYPE.COMPLETED,
    payload: {
      result: 'done'
    }
  });

  const afterCompleted = conversationStore.get(started.conversation.id);
  assert.equal(afterCompleted.activeRuntimeSessionId, started.session.id);
  assert.equal(afterCompleted.lastPendingApprovalId, null);
  assert.equal(afterCompleted.lastPendingQuestionId, null);

  const followUp = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_2',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: 'follow up',
    messageType: 'text'
  });

  assert.equal(followUp.type, 'runtime_continued');
  assert.equal(followUp.session.id, started.session.id);
});

test('outbound dispatcher still routes completion for an older tracked session after a newer session becomes active', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-tracked-dispatch-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-tracked-dispatch-delivery-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-tracked-dispatch-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
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
            return { messageId: `outbound_${sent.length}` };
          }
        };
      }
    }
  });

  const first = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'tracked_1',
    externalConversationId: 'chat_tracked_dispatch_1',
    externalUserId: 'user_tracked_dispatch_1',
    externalUserName: 'alice',
    text: '/agent codex inspect repo',
    messageType: 'text'
  });

  const second = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'tracked_2',
    externalConversationId: 'chat_tracked_dispatch_1',
    externalUserId: 'user_tracked_dispatch_1',
    externalUserName: 'alice',
    text: '/new codex build dashboard',
    messageType: 'text'
  });

  const conversation = conversationStore.get(second.conversation.id);
  assert.equal(conversation.activeRuntimeSessionId, second.session.id);
  assert.ok(conversation.trackedRuntimeSessionIds.includes(first.session.id));
  assert.ok(conversation.trackedRuntimeSessionIds.includes(second.session.id));

  await dispatcher.handleRuntimeEvent({
    sessionId: first.session.id,
    seq: 500,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'first task done',
      summary: 'first summary'
    }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'first task done');
  const deliveries = deliveryStore.listBySession(first.session.id, { limit: 5 });
  assert.ok(deliveries.some((entry) => String(entry.payload?.fullText || '').includes('first task done')));
});

test('outbound dispatcher can recover conversation routing from runtime session metadata before tracked binding is present', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-fallback-routing-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-fallback-routing-delivery-')
  });
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'chat_fallback_routing_1',
    externalUserId: 'user_fallback_routing_1',
    title: 'fallback routing'
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
            return { messageId: 'fallback_out_1' };
          }
        };
      }
    }
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: session.id,
    seq: 1000,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'fallback metadata done',
      summary: 'finished'
    }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'fallback metadata done');
  const updatedConversation = conversationStore.get(conversation.id);
  assert.ok(updatedConversation.trackedRuntimeSessionIds.includes(session.id));
});

test('outbound dispatcher sends full completed result text to channel providers', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-fulltext-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-fulltext-delivery-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-fulltext-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage(payload) {
            sent.push(payload);
            return { messageId: 'outbound_full_1' };
          }
        };
      }
    }
  });

  const started = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_full_1',
    externalConversationId: 'chat_full_1',
    externalUserId: 'user_full_1',
    externalUserName: 'alice',
    text: '/agent codex inspect repo',
    messageType: 'text'
  });

  const longResult = `Summary line\n${'x'.repeat(1800)}`;
  await dispatcher.handleRuntimeEvent({
    sessionId: started.session.id,
    seq: 1001,
    type: AGENT_EVENT_TYPE.COMPLETED,
    payload: {
      result: longResult
    }
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, longResult);
  assert.equal(deliveryStore.listBySession(started.session.id, { limit: 5 })[0].payload.fullText, longResult);
});

test('AgentChannelRouter stores fresh-session inbound messages under the new runtime session', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-router-fresh-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-router-fresh-delivery-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-router-fresh-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  const started = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_1',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    text: '/agent codex inspect repo',
    messageType: 'text'
  });

  const fresh = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_2',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    text: '/new codex write a page',
    messageType: 'text'
  });

  assert.notEqual(fresh.session.id, started.session.id);
  const oldSessionDeliveries = deliveryStore.listBySession(started.session.id);
  const newSessionDeliveries = deliveryStore.listBySession(fresh.session.id);

  assert.equal(oldSessionDeliveries.length, 1);
  assert.equal(newSessionDeliveries.length, 1);
  assert.equal(newSessionDeliveries[0].payload.text, '/new codex write a page');
});

test('AgentOrchestratorMessageService resolves approvals and answers pending questions', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });

  const approvalResult = await service.routeUserMessage({
    message: { text: '/approve' },
    conversation: {
      activeRuntimeSessionId: started.id,
      lastPendingApprovalId: runtimeSessionManager.approvalService.listPending(started.id)[0].approvalId
    }
  });
  assert.equal(approvalResult.type, 'approval_resolved');
  assert.equal(approvalResult.approval.status, 'approved');

  const questionResult = await service.routeUserMessage({
    message: { text: 'yes' },
    conversation: {
      activeRuntimeSessionId: started.id,
      lastPendingQuestionId: 'question-1'
    }
  });
  assert.equal(questionResult.type, 'question_answered');
  assert.equal(questionResult.question.status, 'answered');
});

test('AgentOrchestratorMessageService resolves approvals against current task session before the conversation active session', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const interactive = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });
  const other = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'other interactive task'
  });
  const pendingApproval = runtimeSessionManager.approvalService.listPending(interactive.id)[0];

  const resolved = await service.routeUserMessage({
    message: { text: '/approve' },
    conversation: {
      activeRuntimeSessionId: other.id,
      lastPendingApprovalId: pendingApproval.approvalId,
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: interactive.id,
            currentTask: {
              taskId: interactive.id,
              sessionId: interactive.id,
              provider: 'claude-code',
              title: 'interactive task',
              status: 'waiting_approval'
            }
          }
        }
      }
    }
  });

  assert.equal(resolved.type, 'approval_resolved');
  assert.equal(resolved.approval.status, 'approved');
});

test('AgentOrchestratorMessageService answers pending questions against current task session before the conversation active session', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const interactive = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });
  const other = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'other interactive task'
  });

  const answered = await service.routeUserMessage({
    message: { text: 'yes' },
    conversation: {
      activeRuntimeSessionId: other.id,
      lastPendingQuestionId: 'question-1',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: interactive.id,
            currentTask: {
              taskId: interactive.id,
              sessionId: interactive.id,
              provider: 'claude-code',
              title: 'interactive task',
              status: 'waiting_user'
            }
          }
        }
      }
    }
  });

  assert.equal(answered.type, 'question_answered');
  assert.equal(answered.question.status, 'answered');
});

test('AgentOrchestratorMessageService accepts natural-language approval and can remember session policy', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({
    configDir: createTempDir('cligate-agent-channels-approval-memory-')
  });
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager, approvalPolicyStore });

  const started = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });
  const pendingApproval = runtimeSessionManager.approvalService.listPending(started.id)[0];

  const resolved = await service.routeUserMessage({
    message: { text: '同意这个会话里这个目录后续都允许' },
    conversation: {
      activeRuntimeSessionId: started.id,
      lastPendingApprovalId: pendingApproval.approvalId
    }
  });

  assert.equal(resolved.type, 'approval_resolved');
  assert.equal(resolved.approval.status, 'approved');
  assert.ok(resolved.policy);
  assert.equal(approvalPolicyStore.listPolicies({ scope: 'runtime_session', scopeRef: started.id }).length, 1);
});

test('AgentOrchestratorMessageService can remember approval at conversation scope', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({
    configDir: createTempDir('cligate-agent-channels-approval-conversation-memory-')
  });
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager, approvalPolicyStore });

  const started = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });
  const pendingApproval = runtimeSessionManager.approvalService.listPending(started.id)[0];

  const resolved = await service.routeUserMessage({
    message: { text: '同意这个对话里这个目录后续都允许' },
    conversation: {
      id: 'conv_123',
      activeRuntimeSessionId: started.id,
      lastPendingApprovalId: pendingApproval.approvalId
    }
  });

  assert.equal(resolved.type, 'approval_resolved');
  assert.equal(resolved.policy.scope, 'conversation');
  assert.equal(approvalPolicyStore.listPolicies({ scope: 'conversation', scopeRef: 'conv_123' }).length, 1);
});

test('AgentOrchestratorMessageService returns a friendly busy message while the active session is still running', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });

  const busyResult = await service.routeUserMessage({
    message: { text: 'follow up while busy' },
    conversation: {
      activeRuntimeSessionId: started.id
    }
  });

  assert.equal(busyResult.type, 'command_error');
  assert.match(busyResult.message, /permission decision|need your answer|working on the current task/i);
});

test('AgentOrchestratorMessageService starts a runtime for natural-language messages without an active session', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const result = await service.routeUserMessage({
    message: { text: '现在做到哪了' },
    conversation: {
      metadata: {
        supervisor: {
          taskMemory: {
            current: {
              provider: 'claude-code',
              title: 'Create demo page',
              status: 'waiting_approval'
            }
          }
        }
      }
    },
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(result.type, 'runtime_started');
  assert.equal(result.provider, 'codex');
  assert.equal(result.session.provider, 'codex');
});

test('AgentOrchestratorMessageService keeps explicit /status handling for structured supervisor status replies', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const result = await service.routeUserMessage({
    message: { text: '/status' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'current',
            title: 'Build settings page',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'waiting_approval',
            summary: 'Created the layout and is waiting to write the final file.',
            result: '',
            error: '',
            waitingReason: 'approval: Write D:\\tmp\\settings.html',
            nextSuggestion: 'Reply with approval so the task can continue.'
          }
        }
      }
    }
  });

  assert.equal(result.type, 'supervisor_status');
  assert.match(String(result.message || ''), /Build settings page/);
});

test('AgentOrchestratorMessageService falls back to supervisor status when current task exists but its runtime session is unavailable', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const result = await service.routeUserMessage({
    message: { text: '/status' },
    conversation: {
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'missing-session-1',
            currentTask: {
              taskId: 'missing-session-1',
              sessionId: 'missing-session-1',
              provider: 'codex',
              title: 'Rebuild settings page',
              status: 'running',
              summary: 'still working'
            }
          },
          brief: {
            kind: 'current',
            taskId: 'missing-session-1',
            sessionId: 'missing-session-1',
            title: 'Rebuild settings page',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'running',
            summary: 'still working',
            result: '',
            error: '',
            waitingReason: '',
            nextSuggestion: 'Wait for completion.'
          }
        }
      }
    }
  });

  assert.equal(result.type, 'supervisor_status');
  assert.match(String(result.message || ''), /Task ID: missing-session-1/);
});

test('AgentOrchestratorMessageService asks for clarification when multiple active tasks exist and the follow-up is ambiguous', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const result = await service.routeUserMessage({
    message: { text: '继续刚才那个' },
    conversation: {
      id: 'conv_multi_1',
      activeRuntimeSessionId: 'session_a',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task_a',
            byTask: {
              task_a: {
                taskId: 'task_a',
                sessionId: 'session_a',
                provider: 'codex',
                title: 'Build dashboard',
                status: 'running'
              },
              task_b: {
                taskId: 'task_b',
                sessionId: 'session_b',
                provider: 'claude-code',
                title: 'Review API',
                status: 'waiting_user',
                pendingQuestion: 'Need database schema'
              }
            }
          }
        }
      }
    }
  });

  assert.equal(result.type, 'supervisor_clarification');
  assert.match(String(result.message || ''), /multiple active tasks/i);
  assert.match(String(result.message || ''), /Build dashboard/);
  assert.match(String(result.message || ''), /Review API/);
});

test('AgentOrchestratorMessageService auto-targets the only waiting task for natural-language approval replies', async () => {
  const runtimeSessionManager = createInteractiveRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const waiting = await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'interactive task'
  });
  await service.startRuntimeTask({
    provider: 'claude-code',
    input: 'other interactive task'
  });
  const pendingApproval = runtimeSessionManager.approvalService.listPending(waiting.id)[0];

  const resolved = await service.routeUserMessage({
    message: { text: '同意' },
    conversation: {
      id: 'conv_wait_1',
      activeRuntimeSessionId: 'other-session',
      lastPendingApprovalId: pendingApproval.approvalId,
      metadata: {
        supervisor: {
          taskMemory: {
            byTask: {
              waiting_task: {
                taskId: 'waiting_task',
                sessionId: waiting.id,
                provider: 'claude-code',
                title: 'interactive task',
                status: 'waiting_approval',
                pendingApprovalTitle: pendingApproval.title
              },
              done_task: {
                taskId: 'done_task',
                sessionId: 'done-session',
                provider: 'claude-code',
                title: 'finished task',
                status: 'completed'
              }
            }
          }
        }
      }
    }
  });

  assert.equal(resolved.type, 'approval_resolved');
  assert.equal(resolved.approval.status, 'approved');
});

test('AgentOrchestratorMessageService keeps explicit /status available without starting a runtime', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const result = await service.routeUserMessage({
    message: { text: '/status' },
    conversation: null
  });

  assert.equal(result.type, 'command_error');
  assert.match(String(result.message || ''), /No remembered task status is available/i);
});

test('AgentOrchestratorMessageService forwards mixed status and fix requests to the active runtime', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/cx inspect repo' },
    conversation: null
  });

  const result = await service.routeUserMessage({
    message: {
      text: '我刚才发给你的消息你修复了吗，这个问题，请重新查看代码，我已经看到了你收起的实例块，但是我点击实例或者展开按钮都无法进行展开，目前是收起的状态，请进行修复'
    },
    conversation: {
      activeRuntimeSessionId: started.session.id,
      metadata: {
        supervisor: {
          brief: {
            kind: 'current',
            title: 'Fix channel instance collapse interaction',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'completed',
            summary: 'Previous patch changed the collapse UI.',
            result: '',
            error: '',
            waitingReason: '',
            nextSuggestion: 'Ask for a follow-up change if the interaction is still broken.'
          }
        }
      }
    }
  });

  assert.equal(result.type, 'runtime_continued');
  assert.equal(result.session.id, started.session.id);
  assert.equal(result.session.turnCount, 2);
});

test('AgentOrchestratorMessageService continues the active runtime for fresh-task phrasing unless a command is used', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/cx inspect repo' },
    conversation: null
  });

  const continued = await service.routeUserMessage({
    message: { text: '开始新任务：写一个新的说明文档' },
    conversation: {
      activeRuntimeSessionId: started.session.id
    }
  });

  assert.equal(continued.type, 'runtime_continued');
  assert.equal(continued.session.id, started.session.id);
  assert.equal(continued.session.turnCount, 2);
});

test('AgentOrchestratorMessageService continues the active runtime for sibling-task phrasing unless a command is used', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/cx inspect repo' },
    conversation: null
  });

  const continued = await service.routeUserMessage({
    message: { text: '另外再做一个：生成部署说明' },
    conversation: {
      activeRuntimeSessionId: started.session.id
    }
  });

  assert.equal(continued.type, 'runtime_continued');
  assert.equal(continued.session.id, started.session.id);
  assert.equal(continued.session.turnCount, 2);
});

test('AgentOrchestratorMessageService continues the active runtime for related-task phrasing unless a command is used', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/cx create a login page' },
    conversation: null
  });

  const continued = await service.routeUserMessage({
    message: { text: '基于刚才那个再做一个：注册页' },
    conversation: {
      activeRuntimeSessionId: started.session.id
    }
  });

  assert.equal(continued.type, 'runtime_continued');
  assert.equal(continued.session.id, started.session.id);
  assert.equal(continued.session.turnCount, 2);
});

test('AgentOrchestratorMessageService continues revision phrasing to the current task', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/cx create a login page' },
    conversation: null
  });

  const continued = await service.routeUserMessage({
    message: { text: '再加一个扫码登录入口' },
    conversation: {
      activeRuntimeSessionId: started.session.id
    }
  });

  assert.equal(continued.type, 'runtime_continued');
  assert.equal(continued.session.id, started.session.id);
});

test('AgentOrchestratorMessageService starts the preferred provider for follow-up revisions without an active session', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/cc create a login page' },
    conversation: null
  });

  const followUp = await service.routeUserMessage({
    message: { text: '把按钮改成绿色' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'last_completed',
            title: started.session.title || 'create a login page',
            provider: 'claude-code',
            providerLabel: 'Claude Code',
            status: 'completed',
            summary: 'Created the initial login page.',
            result: 'index.html is ready.',
            error: '',
            waitingReason: '',
            nextSuggestion: 'You can ask for a revision, a follow-up change, or start a related task.'
          }
        }
      }
    },
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(followUp.type, 'runtime_started');
  assert.equal(followUp.provider, 'claude-code');
  assert.equal(followUp.startedFresh, true);
});

test('AgentOrchestratorMessageService prefers remembered provider for new natural-language tasks', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const response = await service.routeUserMessage({
    message: { text: '另外再做一个：生成部署说明' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'last_completed',
            title: 'Create a login page',
            provider: 'claude-code',
            providerLabel: 'Claude Code',
            status: 'completed',
            summary: 'The login page is finished.',
            result: 'index.html is ready.',
            error: '',
            waitingReason: '',
            nextSuggestion: 'You can ask for a revision, a follow-up change, or start a related task.'
          }
        }
      }
    },
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(response.type, 'runtime_started');
  assert.equal(response.provider, 'claude-code');
  assert.equal(response.startedFresh, true);
});

test('AgentOrchestratorMessageService stores explicit conversation preferences from natural language', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const preferenceStore = new AgentPreferenceStore({
    configDir: createTempDir('cligate-agent-preference-store-')
  });
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager, preferenceStore });

  const response = await service.routeUserMessage({
    message: { text: '记住：以后默认中文回复，优先用 Claude Code，并且尽量最小改动' },
    conversation: {
      id: 'conv_pref_1',
      metadata: {}
    },
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(response.type, 'preference_saved');
  assert.match(String(response.message || ''), /Preference saved/i);
  assert.equal(preferenceStore.getPreference({
    scope: 'conversation',
    scopeRef: 'conv_pref_1',
    key: 'reply_language'
  })?.value, 'zh-CN');
  assert.equal(preferenceStore.getPreference({
    scope: 'conversation',
    scopeRef: 'conv_pref_1',
    key: 'preferred_runtime_provider'
  })?.value, 'claude-code');
  assert.equal(preferenceStore.getPreference({
    scope: 'conversation',
    scopeRef: 'conv_pref_1',
    key: 'execution_style'
  })?.value, 'minimal-change');
});

test('AgentOrchestratorMessageService prefers conversation-saved provider for new tasks', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const preferenceStore = new AgentPreferenceStore({
    configDir: createTempDir('cligate-agent-preference-provider-')
  });
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv_pref_2',
    key: 'preferred_runtime_provider',
    value: 'claude-code',
    metadata: { source: 'test' }
  });

  const service = new AgentOrchestratorMessageService({ runtimeSessionManager, preferenceStore });
  const response = await service.routeUserMessage({
    message: { text: '帮我检查一下这个仓库的登录流程' },
    conversation: {
      id: 'conv_pref_2',
      metadata: {}
    },
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(response.type, 'runtime_started');
  assert.equal(response.provider, 'claude-code');
  assert.equal(response.session.provider, 'claude-code');
});

test('AgentChannelRouter keeps natural-language follow-up on the preferred provider without synthetic supervisor context', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-remembered-followup-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-remembered-followup-delivery-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-remembered-followup-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  const existing = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'chat_followup',
    externalUserId: 'user_1',
    metadata: {
      supervisor: {
        brief: {
          kind: 'last_completed',
          title: 'Create a login page',
          provider: 'claude-code',
          providerLabel: 'Claude Code',
          status: 'completed',
          summary: 'Created the initial login page.',
          result: 'index.html is ready.',
          error: '',
          waitingReason: '',
          nextSuggestion: 'You can ask for a revision, a follow-up change, or start a related task.'
        }
      }
    }
  });
  assert.ok(existing);

  const result = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_followup_1',
    externalConversationId: 'chat_followup',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '把按钮改成绿色',
    messageType: 'text'
  }, {
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(result.type, 'runtime_started');
  assert.equal(result.session.provider, 'claude-code');
  assert.equal(result.conversation.metadata?.supervisor?.taskMemory?.current?.title, '把按钮改成绿色');
  assert.equal(result.conversation.metadata?.supervisor?.taskMemory?.current?.originKind, 'direct');
});

test('AgentChannelRouter keeps related-task phrasing as direct runtime input in remembered conversations', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-related-origin-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-related-origin-delivery-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-related-origin-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'chat_related',
    externalUserId: 'user_1',
    metadata: {
      supervisor: {
        brief: {
          kind: 'last_completed',
          title: 'Create a login page',
          provider: 'claude-code',
          providerLabel: 'Claude Code',
          status: 'completed',
          summary: 'The login page is finished.',
          result: 'index.html is ready.',
          error: '',
          waitingReason: '',
          nextSuggestion: 'You can ask for a revision, a follow-up change, or start a related task.'
        }
      }
    }
  });

  const result = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_related_1',
    externalConversationId: 'chat_related',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '基于刚才那个再做一个：注册页',
    messageType: 'text'
  }, {
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(result.type, 'runtime_started');
  assert.equal(result.session.provider, 'claude-code');
  assert.equal(result.conversation.metadata?.supervisor?.taskMemory?.current?.title, '基于刚才那个再做一个：注册页');
  assert.equal(result.conversation.metadata?.supervisor?.taskMemory?.current?.originKind, 'direct');
});

test('AgentOrchestratorMessageService returns supervisor status for remembered-failure status phrasing', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const result = await service.routeUserMessage({
    message: { text: '进展如何' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'current',
            title: 'Polish login page',
            provider: 'claude-code',
            providerLabel: 'Claude Code',
            status: 'failed',
            summary: 'Continuing remembered task "Create a login page".',
            result: '',
            error: 'Write was blocked.',
            waitingReason: '',
            nextSuggestion: 'You can retry this follow-up task, revise the request, or return to "Create a login page".'
          }
        }
      }
    }
  });

  assert.equal(result.type, 'supervisor_status');
  assert.match(String(result.message || ''), /Polish login page/);
  assert.match(String(result.message || ''), /failed/i);
});

test('AgentOrchestratorMessageService starts the preferred provider for retry phrasing without special interception', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const response = await service.routeUserMessage({
    message: { text: '重试刚才那个' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'current',
            title: 'Polish login page',
            provider: 'claude-code',
            providerLabel: 'Claude Code',
            status: 'failed',
            summary: 'Continuing remembered task "Create a login page".',
            result: '',
            error: 'Write was blocked.',
            waitingReason: '',
            nextSuggestion: 'You can retry this follow-up task, revise the request, or return to "Create a login page".',
            sourceTitle: 'Create a login page',
            sourceProvider: 'claude-code',
            sourceStatus: 'completed'
          }
        }
      }
    },
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(response.type, 'runtime_started');
  assert.equal(response.provider, 'claude-code');
});

test('AgentChannelRouter supports /cligate mode switching and one-shot assistant replies', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-assistant-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-assistant-delivery-')
  });
  const pairingStore = new AgentChannelPairingStore({
    configDir: createTempDir('cligate-agent-channels-assistant-pairing-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  const entered = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-chat-1',
    externalUserId: 'user-1',
    externalUserName: 'tester',
    externalMessageId: 'msg-enter',
    text: '/cligate',
    messageType: 'text'
  });
  assert.equal(entered.type, 'assistant_mode_entered');
  assert.equal(entered.conversation.metadata?.assistantCore?.mode, 'assistant');

  const replied = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-chat-1',
    externalUserId: 'user-1',
    externalUserName: 'tester',
    externalMessageId: 'msg-status',
    text: 'status',
    messageType: 'text'
  });
  assert.equal(replied.type, 'assistant_run_accepted');
  assert.match(String(replied.message || ''), /CliGate Assistant|后台|background/i);

  const exited = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-chat-1',
    externalUserId: 'user-1',
    externalUserName: 'tester',
    externalMessageId: 'msg-exit',
    text: '/runtime',
    messageType: 'text'
  });
  assert.equal(exited.type, 'assistant_mode_exited');
  assert.equal(exited.conversation.metadata?.assistantCore?.mode, 'direct-runtime');
});

test('AgentChannelRouter runs Phase 4 assistant tool flow to start a runtime task', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-assistant-runner-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-assistant-runner-delivery-')
  });
  const pairingStore = new AgentChannelPairingStore({
    configDir: createTempDir('cligate-agent-channels-assistant-runner-pairing-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  const result = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-runner-chat-1',
    externalUserId: 'user-1',
    externalUserName: 'tester',
    externalMessageId: 'msg-start',
    text: '/cligate start codex inspect repo',
    messageType: 'text'
  }, {
    defaultRuntimeProvider: 'claude-code'
  });

  assert.equal(result.type, 'assistant_run_accepted');
  assert.ok(result.assistantRun?.id);
  assert.equal(result.assistantRun.status, 'queued');
});

test('AgentChannelRouter binds assistant-started runtime sessions back to the channel conversation', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-assistant-bind-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-assistant-bind-delivery-')
  });
  const pairingStore = new AgentChannelPairingStore({
    configDir: createTempDir('cligate-agent-channels-assistant-bind-pairing-')
  });
  const sent = [];
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    assistantModeService: {
      async maybeHandleMessage({ conversation, onBackgroundResult }) {
        const session = await runtimeSessionManager.createSession({
          provider: 'claude-code',
          input: 'inspect repo',
          cwd: process.cwd(),
          model: ''
        });
        const backgroundResult = {
          type: 'assistant_response',
          message: 'started in background',
          assistantRun: {
            id: 'assistant-run-1',
            relatedRuntimeSessionIds: [session.id]
          },
          conversation
        };
        await onBackgroundResult(backgroundResult);
        return {
          type: 'assistant_run_accepted',
          message: 'accepted',
          assistantRun: {
            id: 'assistant-run-1',
            status: 'queued'
          },
          conversation
        };
      }
    }
  });
  router.registry = {
    get() {
      return {
        async sendMessage({ text }) {
          sent.push(text);
          return { messageId: 'out_1' };
        }
      };
    }
  };

  const result = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-bind-chat-1',
    externalUserId: 'user-1',
    externalUserName: 'tester',
    externalMessageId: 'msg-start-bind',
    text: '/cligate start claude inspect repo',
    messageType: 'text'
  }, {
    defaultRuntimeProvider: 'claude-code'
  });

  assert.equal(result.type, 'assistant_run_accepted');
  await new Promise((resolve) => setTimeout(resolve, 10));

  const conversation = conversationStore.findByExternal('telegram', 'default', 'assistant-bind-chat-1', 'user-1', '');
  assert.ok(conversation?.activeRuntimeSessionId);
  assert.ok(conversation?.activeTaskId);
  assert.ok(Array.isArray(conversation?.trackedTaskIds));
  assert.ok(conversation?.trackedTaskIds.includes(conversation.activeTaskId));
  const boundSession = runtimeSessionManager.getSession(conversation.activeRuntimeSessionId);
  assert.equal(boundSession?.provider, 'claude-code');
  assert.ok(sent.includes('started in background'));
});

test('AgentChannelRouter keeps aggregated assistant background results when multiple runtime sessions are related', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-assistant-fanin-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-assistant-fanin-delivery-')
  });
  const pairingStore = new AgentChannelPairingStore({
    configDir: createTempDir('cligate-agent-channels-assistant-fanin-pairing-')
  });
  const sent = [];
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    assistantModeService: {
      async maybeHandleMessage({ conversation, onBackgroundResult }) {
        const codexSession = await runtimeSessionManager.createSession({
          provider: 'codex',
          input: 'remove welcome text',
          cwd: process.cwd(),
          model: ''
        });
        const claudeSession = await runtimeSessionManager.createSession({
          provider: 'claude-code',
          input: 'summarize skills repo',
          cwd: process.cwd(),
          model: ''
        });
        await onBackgroundResult({
          type: 'assistant_response',
          message: '并发任务已全部结束，汇总如下：\n1. Codex: done\n2. Claude Code: done',
          assistantRun: {
            id: 'assistant-run-fanin-1',
            relatedRuntimeSessionIds: [codexSession.id, claudeSession.id],
            status: 'completed'
          },
          conversation
        });
        return {
          type: 'assistant_run_accepted',
          message: 'accepted',
          assistantRun: {
            id: 'assistant-run-fanin-1',
            status: 'queued'
          },
          conversation
        };
      }
    }
  });
  router.registry = {
    get() {
      return {
        async sendMessage({ text }) {
          sent.push(text);
          return { messageId: 'out_fanin_1' };
        }
      };
    }
  };

  const result = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'assistant-fanin-chat-1',
    externalUserId: 'user-1',
    externalUserName: 'tester',
    externalMessageId: 'msg-start-fanin',
    text: '/cligate 并发跑两个任务',
    messageType: 'text'
  }, {
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(result.type, 'assistant_run_accepted');
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sent.length, 1);
  assert.match(sent[0], /Codex/);
  assert.match(sent[0], /Claude Code/);
  const deliveries = deliveryStore.listByConversation(result.conversation.id);
  assert.ok(deliveries.some((entry) => String(entry.payload?.text || '').includes('Claude Code')));
});

test('AgentOrchestratorMessageService starts the default remembered provider for return phrasing without special interception', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const response = await service.routeUserMessage({
    message: { text: '回到上一个任务' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'current',
            title: 'Polish login page',
            provider: 'claude-code',
            providerLabel: 'Claude Code',
            status: 'failed',
            summary: 'Continuing remembered task "Create a login page".',
            result: '',
            error: 'Write was blocked.',
            waitingReason: '',
            nextSuggestion: 'You can retry this follow-up task, revise the request, or return to "Create a login page".',
            sourceTitle: 'Create a login page',
            sourceProvider: 'codex',
            sourceStatus: 'completed'
          }
        }
      }
    },
    defaultRuntimeProvider: 'claude-code'
  });

  assert.equal(response.type, 'runtime_started');
  assert.equal(response.provider, 'claude-code');
});

test('AgentOrchestratorMessageService forwards provider-switch phrasing to the active runtime unless a command is used', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const service = new AgentOrchestratorMessageService({ runtimeSessionManager });

  const started = await service.routeUserMessage({
    message: { text: '/cx inspect repo' },
    conversation: null
  });

  const response = await service.routeUserMessage({
    message: { text: '切到 Claude Code' },
    conversation: {
      activeRuntimeSessionId: started.session.id
    }
  });

  assert.equal(response.type, 'runtime_continued');
  assert.equal(response.session.id, started.session.id);
});

test('TelegramChannelProvider normalizes messages and callback approvals', () => {
  const provider = new TelegramChannelProvider({
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) })
  });

  const inboundMessage = provider.normalizeInbound({
    update_id: 1,
    message: {
      message_id: 10,
      text: '/agent codex inspect repo',
      chat: { id: 1001 },
      from: { id: 2001, username: 'alice' }
    }
  });
  assert.equal(inboundMessage.externalConversationId, '1001');
  assert.equal(inboundMessage.text, '/agent codex inspect repo');

  const inboundAction = provider.normalizeInbound({
    update_id: 2,
    callback_query: {
      id: 'cb_1',
      data: 'cligate:approve:approval_1',
      from: { id: 2001, username: 'alice' },
      message: {
        message_id: 11,
        chat: { id: 1001 }
      }
    }
  });
  assert.equal(inboundAction.text, '/approve');
  assert.equal(inboundAction.action.callbackQueryId, 'cb_1');
});

test('TelegramChannelProvider polls updates and replies through router results', async () => {
  const calls = [];
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push(body);

    if (!calls[0].allowed_updates) {
      throw new Error('first call should be getUpdates');
    }

    if (calls.length === 1) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          result: [{
            update_id: 21,
            message: {
              message_id: 31,
              text: '/status',
              chat: { id: 1001 },
              from: { id: 2001, username: 'alice' }
            }
          }]
        })
      };
    }

    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: 99
        }
      })
    };
  };

  const provider = new TelegramChannelProvider({ fetchImpl });
  provider.router = {
    routeInboundMessage: async () => ({
      type: 'runtime_status',
      session: { id: 'session_1', status: 'ready', summary: 'done' }
    })
  };
  provider.settings = {
    botToken: 'token',
    mode: 'polling',
    pollingIntervalMs: 100000
  };
  provider.running = true;

  const processed = await provider.pollOnce();
  provider.running = false;
  clearTimeout(provider.timer);

  assert.equal(processed, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].chat_id, '1001');
  assert.match(String(calls[1].text || ''), /session_1/i);
});

test('TelegramChannelProvider splits oversized outbound messages into multiple requests', async () => {
  const calls = [];
  const fetchImpl = async (_url, options = {}) => {
    const body = JSON.parse(options.body || '{}');
    calls.push(body);
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: calls.length
        }
      })
    };
  };

  const provider = new TelegramChannelProvider({ fetchImpl });
  provider.settings = {
    botToken: 'token',
    mode: 'polling'
  };

  const longText = `Result:\n${'x'.repeat(8000)}`;
  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: '1001'
    },
    text: longText
  });

  assert.ok(calls.length >= 3);
  assert.equal(result.messageId, String(calls.length));
  for (const call of calls) {
    assert.equal(call.chat_id, '1001');
    assert.ok(String(call.text || '').length <= 3508);
  }
  assert.match(String(calls[0].text || ''), /^\[1\/\d+\] /);
});

test('AgentChannelManager starts enabled telegram provider from settings', async () => {
  let started = 0;
  let stopped = 0;
  const provider = {
    id: 'telegram',
    capabilities: { mode: 'polling' },
    async start() {
      started += 1;
      return { started: true };
    },
    async stop() {
      stopped += 1;
      return { stopped: true };
    }
  };

  const manager = new AgentChannelManager({
    registry: {
      list: () => [{ id: 'telegram', capabilities: provider.capabilities }],
      get: () => provider
    },
    router: {},
    outboundDispatcher: { start() {}, stop() {} },
    settingsProvider: () => ({
      channels: {
        telegram: { enabled: true, mode: 'polling', botToken: 'token' }
      }
    }),
    settingsWriter: (patch) => ({
      channels: patch.channels
    })
  });

  const providers = await manager.start();
  assert.equal(started, 1);
  assert.equal(stopped, 1);
  assert.equal(providers[0].status.running, true);
});

test('AgentChannelManager outbound registry does not fall back to template provider when instance is missing', async () => {
  const manager = new AgentChannelManager({
    registry: {
      list: () => [],
      get: () => ({
        id: 'telegram',
        sendMessage: async () => ({ messageId: 'template-message' })
      })
    },
    router: {},
    outboundDispatcher: { start() {}, stop() {} },
    settingsProvider: () => ({ channels: {} }),
    settingsWriter: (patch) => ({ channels: patch.channels })
  });

  assert.equal(manager.outboundDispatcher.registry.get('telegram', 'default'), null);
});

test('FeishuChannelProvider normalizes challenge and text events', () => {
  const provider = new FeishuChannelProvider({
    fetchImpl: async () => ({ ok: true, json: async () => ({ code: 0, data: {} }) })
  });

  const challenge = provider.normalizeInbound({ challenge: 'abc123' });
  assert.equal(challenge.type, 'challenge');
  assert.equal(challenge.challenge, 'abc123');

  const inbound = provider.normalizeInbound({
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: {
        sender_id: { open_id: 'ou_123' },
        sender_type: 'user'
      },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        message_type: 'text',
        content: JSON.stringify({ text: '/status' })
      }
    }
  });

  assert.equal(inbound.channel, 'feishu');
  assert.equal(inbound.externalConversationId, 'oc_1');
  assert.equal(inbound.text, '/status');
});

test('FeishuChannelProvider handles webhook challenge and replies to router results', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body || '{}') });
    if (String(url).includes('tenant_access_token')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          tenant_access_token: 'tenant_token',
          expire: 7200
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          message_id: 'msg_1'
        }
      })
    };
  };

  const provider = new FeishuChannelProvider({ fetchImpl });
  provider.router = {
    routeInboundMessage: async () => ({
      type: 'runtime_status',
      session: { id: 'session_1', status: 'ready', summary: 'done' }
    })
  };
  provider.settings = {
    appId: 'app_id',
    appSecret: 'secret',
    defaultRuntimeProvider: 'codex'
  };

  const challengeResult = await provider.handleWebhook({ challenge: 'xyz' });
  assert.equal(challengeResult.body.challenge, 'xyz');

  const messageResult = await provider.handleWebhook({
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: {
        sender_id: { open_id: 'ou_123' },
        sender_type: 'user'
      },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        message_type: 'text',
        content: JSON.stringify({ text: '/status' })
      }
    }
  });

  assert.equal(messageResult.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /im\/v1\/messages/);
  assert.equal(calls[1].body.receive_id, 'oc_1');
});

test('channel providers do not expose a runtime model config field', () => {
  const telegram = new TelegramChannelProvider();
  const feishu = new FeishuChannelProvider();
  const dingtalk = new DingTalkChannelProvider();

  assert.equal(telegram.configFields.some((field) => field.key === 'model'), false);
  assert.equal(feishu.configFields.some((field) => field.key === 'model'), false);
  assert.equal(dingtalk.configFields.some((field) => field.key === 'model'), false);
});

test('FeishuChannelProvider does not pass a channel model into router options', async () => {
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('tenant_access_token')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          tenant_access_token: 'tenant_token',
          expire: 7200
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          message_id: 'msg_1'
        }
      })
    };
  };

  const provider = new FeishuChannelProvider({ fetchImpl });
  provider.router = {
    routeInboundMessage: async (_message, options = {}) => {
      assert.equal('model' in options, false);
      return {
        type: 'runtime_status',
        session: { id: 'session_1', status: 'ready', summary: 'done' }
      };
    }
  };
  provider.settings = {
    appId: 'app_id',
    appSecret: 'secret',
    defaultRuntimeProvider: 'codex'
  };

  const result = await provider.handleWebhook({
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: {
        sender_id: { open_id: 'ou_123' },
        sender_type: 'user'
      },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        message_type: 'text',
        content: JSON.stringify({ text: '/status' })
      }
    }
  });

  assert.equal(result.status, 200);
});

test('FeishuChannelProvider sends failure text when router throws before runtime session starts', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body || '{}') });
    if (String(url).includes('tenant_access_token')) {
      return {
        ok: true,
        json: async () => ({
          code: 0,
          tenant_access_token: 'tenant_token',
          expire: 7200
        })
      };
    }
    return {
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          message_id: 'msg_fail_1'
        }
      })
    };
  };

  const provider = new FeishuChannelProvider({ fetchImpl });
  provider.router = {
    routeInboundMessage: async () => {
      throw new Error('runtime bootstrap failed');
    }
  };
  provider.settings = {
    appId: 'app_id',
    appSecret: 'secret',
    defaultRuntimeProvider: 'codex'
  };

  const result = await provider.handleWebhook({
    header: { event_type: 'im.message.receive_v1' },
    event: {
      sender: {
        sender_id: { open_id: 'ou_fail_1' },
        sender_type: 'user'
      },
      message: {
        message_id: 'om_fail_1',
        chat_id: 'oc_fail_1',
        message_type: 'text',
        content: JSON.stringify({ text: '/cc inspect repo' })
      }
    }
  });

  assert.equal(result.status, 200);
  assert.equal(calls.length, 2);
  assert.match(String(calls[1].body.content || ''), /Task failed before the runtime session could be established/);
  assert.match(String(calls[1].body.content || ''), /runtime bootstrap failed/);
});

test('DingTalkChannelProvider normalizes text events and routes webhook messages', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        body: options.body ? JSON.parse(options.body) : null,
        headers: options.headers || {}
      });

      if (String(url).includes('/oauth2/accessToken')) {
        return {
          ok: true,
          json: async () => ({
            accessToken: 'dt_access_token'
          })
        };
      }

      return {
        ok: true,
        json: async () => ({})
      };
    }
  });

  const normalized = provider.normalizeInbound({
    msgId: 'dt_msg_1',
    conversationId: 'cid_1',
    senderId: 'uid_1',
    senderNick: 'alice',
    text: {
      content: '/status'
    }
  });

  assert.equal(normalized.channel, 'dingtalk');
  assert.equal(normalized.externalConversationId, 'cid_1');
  assert.equal(normalized.externalUserId, 'uid_1');
  assert.equal(normalized.text, '/status');

  provider.router = {
    routeInboundMessage: async (_message, options = {}) => {
      assert.equal('model' in options, false);
      return {
        type: 'runtime_status',
        session: { id: 'session_dt_1', status: 'ready', summary: 'done' }
      };
    }
  };
  provider.settings = {
    mode: 'webhook',
    defaultRuntimeProvider: 'codex',
    requirePairing: true
  };

  const result = await provider.handleWebhook({
    msgId: 'dt_msg_2',
    conversationId: 'cid_2',
    senderId: 'uid_2',
    senderNick: 'bob',
    sessionWebhook: 'https://example.invalid/dingtalk/session-webhook',
    sessionWebhookExpiredTime: String(Date.now() + 60_000),
    text: {
      content: '/status'
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.invalid/dingtalk/session-webhook');
  assert.equal(calls[0].body.msgtype, 'text');
});

test('DingTalkChannelProvider sends failure text when router throws before runtime session starts', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        ok: true,
        json: async () => ({})
      };
    }
  });

  provider.router = {
    routeInboundMessage: async () => {
      throw new Error('CLAUDE_API_ERROR: 404 - {"type":"error","error":{"type":"not_found_error","message":"model: gpt-5.4"}}');
    }
  };

  const result = await provider.handleWebhook({
    msgId: 'dt_msg_fail_1',
    conversationId: 'cid_fail_1',
    senderId: 'uid_fail_1',
    senderNick: 'bob',
    sessionWebhook: 'https://example.invalid/dingtalk/session-webhook',
    sessionWebhookExpiredTime: String(Date.now() + 60_000),
    text: {
      content: '/cc inspect the repo'
    }
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text.content, /Task failed before the runtime session could be established/);
  assert.match(calls[0].body.text.content, /CLAUDE_API_ERROR: 404/);
});

test('DingTalkChannelProvider starts stream mode and routes callback frames', async () => {
  const fetchCalls = [];
  const sentFrames = [];
  const messageHandlers = [];
  const socket = {
    on(event, handler) {
      if (event === 'message') {
        messageHandlers.push(handler);
      }
    },
    send(payload) {
      sentFrames.push(JSON.parse(payload));
    },
    close() {}
  };

  const provider = new DingTalkChannelProvider({
    fetchImpl: async (url, options = {}) => {
      fetchCalls.push({
        url,
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        ok: true,
        json: async () => ({
          endpoint: 'wss://example.invalid/gateway',
          ticket: 'ticket_123'
        })
      };
    },
    webSocketFactory: async (url) => {
      fetchCalls.push({ url, body: null });
      return socket;
    }
  });

  const routed = [];
  provider.router = {
    routeInboundMessage: async (message) => {
      routed.push(message);
      return {
        type: 'runtime_status',
        session: { id: 'session_stream_1', status: 'running', summary: 'busy' }
      };
    }
  };

  const started = await provider.start({
    settings: {
      enabled: true,
      mode: 'stream',
      clientId: 'client_id',
      clientSecret: 'client_secret',
      defaultRuntimeProvider: 'codex'
    },
    router: provider.router,
    logger: console
  });

  assert.equal(started.started, true);
  assert.equal(started.mode, 'stream');
  assert.match(String(fetchCalls[0].url), /gateway\/connections\/open/);
  assert.match(String(fetchCalls[1].url), /ticket=ticket_123/);

  await provider.handleStreamFrame(JSON.stringify({
    type: 'CALLBACK',
    headers: {
      topic: '/v1.0/im/bot/messages/get',
      messageId: 'stream_msg_1'
    },
    data: JSON.stringify({
      msgId: 'dt_stream_1',
      conversationId: 'cid_stream_1',
      senderId: 'uid_stream_1',
      senderNick: 'alice',
      sessionWebhook: 'https://example.invalid/dingtalk/session-webhook',
      sessionWebhookExpiredTime: String(Date.now() + 60_000),
      text: {
        content: '/status'
      }
    })
  }));

  assert.equal(routed.length, 1);
  assert.equal(routed[0].channel, 'dingtalk');
  assert.equal(routed[0].externalConversationId, 'cid_stream_1');
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].code, 200);
  assert.equal(sentFrames[0].headers.messageId, 'stream_msg_1');
});

test('DingTalkChannelProvider fails clearly when stream mode has no WebSocket implementation', async () => {
  const provider = new DingTalkChannelProvider({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        endpoint: 'wss://example.invalid/gateway',
        ticket: 'ticket_123'
      })
    })
  });

  await assert.rejects(
    () => provider.start({
      settings: {
        enabled: true,
        mode: 'stream',
        clientId: 'client_id',
        clientSecret: 'client_secret'
      },
      router: { routeInboundMessage: async () => ({ type: 'duplicate' }) },
      logger: console
    }),
    /WebSocket is unavailable/i
  );
});

test('DingTalkChannelProvider falls back to app API when session webhook is unavailable', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        body: options.body ? JSON.parse(options.body) : null,
        headers: options.headers || {}
      });

      if (String(url).includes('/oauth2/accessToken')) {
        return {
          ok: true,
          json: async () => ({
            accessToken: 'dt_access_token'
          })
        };
      }

      return {
        ok: true,
        json: async () => ({
          processQueryKey: 'process_key_1'
        })
      };
    }
  });

  provider.settings = {
    mode: 'webhook',
    clientId: 'client_id',
    clientSecret: 'client_secret',
    robotCode: 'robot_123'
  };

  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: 'cid_fallback',
      metadata: {
        channelContext: {
          sessionWebhook: 'https://example.invalid/expired-webhook',
          sessionWebhookExpiredTime: String(Date.now() - 1),
          robotCode: 'robot_123',
          conversationType: '1',
          senderStaffId: 'staff_123'
        }
      }
    },
    text: 'hello from cligate'
  });

  assert.equal(result.messageId, 'process_key_1');
  assert.equal(calls.length, 2);
  assert.match(String(calls[0].url), /oauth2\/accessToken/);
  assert.match(String(calls[1].url), /robot\/oToMessages\/batchSend/);
  assert.deepEqual(calls[1].body.userIds, ['staff_123']);
  assert.equal(calls[1].body.robotCode, 'robot_123');
});

test('DingTalkChannelProvider uses group send API for group conversation fallback', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        body: options.body ? JSON.parse(options.body) : null,
        headers: options.headers || {}
      });

      if (String(url).includes('/oauth2/accessToken')) {
        return {
          ok: true,
          json: async () => ({
            accessToken: 'dt_access_token'
          })
        };
      }

      return {
        ok: true,
        json: async () => ({
          processQueryKey: 'group_key_1'
        })
      };
    }
  });

  provider.settings = {
    mode: 'webhook',
    clientId: 'client_id',
    clientSecret: 'client_secret',
    robotCode: 'robot_group'
  };

  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: 'cid_group',
      metadata: {
        channelContext: {
          conversationType: '2',
          robotCode: 'robot_group'
        }
      }
    },
    text: 'group message'
  });

  assert.equal(result.messageId, 'group_key_1');
  assert.equal(calls.length, 2);
  assert.match(String(calls[1].url), /robot\/groupMessages\/send/);
  assert.equal(calls[1].body.openConversationId, 'cid_group');
  assert.equal(calls[1].body.robotCode, 'robot_group');
});

test('channel formatter prefers completed result text over generic completion label', () => {
  const formatted = formatAgentRuntimeEventForChannel({
    event: {
      type: AGENT_EVENT_TYPE.COMPLETED,
      payload: {
        result: 'Today in New York it is 18C and cloudy.',
        summary: 'Codex task completed.'
      }
    },
    session: {
      provider: 'codex',
      summary: 'fallback'
    }
  });

  assert.equal(formatted.text, 'Today in New York it is 18C and cloudy.');
});

test('channel formatter uses task-aware wording for waiting and terminal runtime events', () => {
  const started = formatAgentRuntimeEventForChannel({
    event: {
      type: AGENT_EVENT_TYPE.STARTED,
      payload: {
        title: 'Review login flow'
      }
    },
    session: {
      provider: 'codex'
    }
  });
  const questioned = formatAgentRuntimeEventForChannel({
    event: {
      type: AGENT_EVENT_TYPE.QUESTION,
      payload: {
        text: 'Use REST or GraphQL?'
      }
    },
    session: {
      provider: 'claude-code',
      title: 'Review login flow'
    }
  });
  const failed = formatAgentRuntimeEventForChannel({
    event: {
      type: AGENT_EVENT_TYPE.FAILED,
      payload: {
        message: 'Write was blocked.'
      }
    },
    session: {
      provider: 'codex',
      title: 'Review login flow'
    }
  });

  assert.equal(started.text, 'Task started: Review login flow (codex)');
  assert.equal(questioned.text, 'Task needs your reply: Use REST or GraphQL?');
  assert.match(String(failed.text || ''), /Task failed: Review login flow/);
});

test('channel formatter keeps oversized completed results as full text', () => {
  const longResult = [
    'I could not write the requested file because the environment is read-only.',
    'The intended path was D:\\cligatespace\\register.html.',
    'Below is the full HTML content:',
    '<html>',
    'x'.repeat(2000),
    '</html>'
  ].join('\n');

  const formatted = formatAgentRuntimeEventForChannel({
    event: {
      type: AGENT_EVENT_TYPE.COMPLETED,
      payload: {
        result: longResult
      }
    },
    session: {
      id: 'session_long_1',
      provider: 'codex',
      cwd: 'D:\\cligatespace'
    }
  });

  assert.equal(formatted.text, longResult);
  assert.equal(formatted.fullText, longResult);
});

test('DingTalkChannelProvider splits oversized messages into multiple webhook sends', async () => {
  const calls = [];
  const provider = new DingTalkChannelProvider({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        ok: true,
        json: async () => ({
          processQueryKey: `process_${calls.length}`
        })
      };
    }
  });

  const longText = Array.from({ length: 6 }, (_, index) => `Part ${index + 1}: ${'x'.repeat(900)}`).join('\n');
  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: 'cid_long',
      metadata: {
        channelContext: {
          sessionWebhook: 'https://example.invalid/dingtalk/session-webhook',
          sessionWebhookExpiredTime: String(Date.now() + 60_000)
        }
      }
    },
    text: longText
  });

  assert.equal(result.messageId, `process_${calls.length}`);
  assert.ok(calls.length > 1);
  assert.ok(calls.every((entry) => entry.body?.text?.content));
  assert.ok(calls[0].body.text.content.startsWith('[1/'));
});

test('FeishuChannelProvider splits oversized messages into multiple sends', async () => {
  const calls = [];
  const provider = new FeishuChannelProvider({
    fetchImpl: async (url, options = {}) => {
      calls.push({
        url,
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            message_id: `msg_${calls.length}`
          }
        })
      };
    }
  });

  provider.settings = {
    appId: 'app_id',
    appSecret: 'app_secret'
  };

  const longText = Array.from({ length: 6 }, (_, index) => `Part ${index + 1}: ${'x'.repeat(900)}`).join('\n');
  const result = await provider.sendMessage({
    conversation: {
      externalConversationId: 'oc_feishu_long'
    },
    text: longText
  });

  assert.equal(result.messageId, `msg_${calls.length}`);
  assert.ok(calls.length > 1);
  assert.ok(calls.every((entry) => JSON.parse(entry.body.content).text));
  assert.ok(JSON.parse(calls[0].body.content).text.startsWith('[1/'));
});

test('session records are grouped by runtime session instead of channel conversation', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-session-records-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-session-records-delivery-')
  });
  const pairingStore = new AgentChannelPairingStore({
    configDir: createTempDir('cligate-agent-channels-session-records-pairing-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });

  await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_1',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '/agent codex inspect repo',
    messageType: 'text'
  });

  const second = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_2',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '/new codex create index.html',
    messageType: 'text'
  });

  const records = buildAgentChannelSessionRecords({
    limit: 20,
    runtimeSessionManager,
    deliveryStore,
    conversationStore,
    pairingStore
  });
  const filtered = records.filter((record) => record.externalConversationId === 'chat_1');

  assert.ok(filtered.length >= 2);
  assert.ok(filtered.some((record) => record.id === second.session.id));

  const detail = buildAgentChannelSessionRecordDetail(second.session.id, {
    runtimeSessionManager,
    deliveryStore,
    conversationStore,
    pairingStore
  });
  assert.equal(detail.session.id, second.session.id);
  assert.ok(detail.deliveries.every((entry) => entry.sessionId === second.session.id));
});

test('completed runtime events update conversation supervisor task memory', async () => {
  const runtimeSessionManager = createRuntimeManager();
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-agent-channels-supervisor-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-agent-channels-supervisor-delivery-')
  });
  const router = new AgentChannelRouter({
    conversationStore,
    deliveryStore,
    pairingStore: new AgentChannelPairingStore({
      configDir: createTempDir('cligate-agent-channels-supervisor-pairing-')
    }),
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager })
  });
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    registry: {
      get() {
        return {
          async sendMessage() {
            return { messageId: 'outbound_supervisor_1' };
          }
        };
      }
    }
  });

  const started = await router.routeInboundMessage({
    channel: 'telegram',
    accountId: 'default',
    externalMessageId: 'm_1',
    externalConversationId: 'chat_1',
    externalUserId: 'user_1',
    externalUserName: 'alice',
    text: '/cx create a demo page',
    messageType: 'text'
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: started.session.id,
    seq: 999,
    type: AGENT_EVENT_TYPE.COMPLETED,
    ts: new Date().toISOString(),
    payload: {
      result: 'done',
      summary: 'finished'
    }
  });

  const updatedConversation = conversationStore.get(started.conversation.id);
  assert.equal(updatedConversation.metadata?.supervisor?.taskMemory?.current?.status, 'completed');
  assert.equal(updatedConversation.metadata?.supervisor?.taskMemory?.lastCompleted?.sessionId, started.session.id);
  assert.equal(updatedConversation.metadata?.supervisor?.brief?.kind, 'current');
  assert.equal(updatedConversation.metadata?.supervisor?.brief?.status, 'completed');
  assert.match(String(updatedConversation.metadata?.supervisor?.brief?.summary || ''), /done:create a demo page/i);
});
