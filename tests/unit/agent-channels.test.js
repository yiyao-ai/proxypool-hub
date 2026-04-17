import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import { AGENT_EVENT_TYPE } from '../../src/agent-runtime/models.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { AgentChannelConversationStore } from '../../src/agent-channels/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AgentChannelPairingStore } from '../../src/agent-channels/pairing-store.js';
import { AgentChannelRouter } from '../../src/agent-channels/router.js';
import { AgentChannelManager } from '../../src/agent-channels/manager.js';
import { AgentChannelOutboundDispatcher } from '../../src/agent-channels/outbound-dispatcher.js';
import FeishuChannelProvider from '../../src/agent-channels/providers/feishu-provider.js';
import TelegramChannelProvider from '../../src/agent-channels/providers/telegram-provider.js';
import { formatAgentRuntimeEventForChannel } from '../../src/agent-channels/formatter.js';

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
    approvalService: new AgentRuntimeApprovalService()
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
    approvalService: new AgentRuntimeApprovalService()
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
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    requirePairing: false
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
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    requirePairing: false
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
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    requirePairing: false
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

test('channel formatter summarizes oversized completed results for mobile channels', () => {
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

  assert.match(formatted.text, /codex task completed\./i);
  assert.match(formatted.text, /read-only/i);
  assert.match(formatted.text, /D:\\cligatespace\\register\.html/i);
  assert.match(formatted.text, /Full output is available in CliGate session session_long_1\./);
  assert.ok(formatted.text.length < longResult.length);
});
