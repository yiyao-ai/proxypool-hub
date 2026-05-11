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
import { AssistantPolicyService } from '../../src/assistant-core/policy-service.js';
import { AssistantApprovalGovernor } from '../../src/assistant-core/approval-governor.js';
import { AssistantEventIngestService } from '../../src/assistant-core/event-ingest-service.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';

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

function createFixture() {
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({
    configDir: createTempDir('cligate-approval-governor-policy-')
  });
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeInteractiveProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-approval-governor-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    approvalPolicyStore
  });
  const policyService = new AssistantPolicyService({
    approvalPolicyStore
  });
  const approvalGovernor = new AssistantApprovalGovernor({
    messageService,
    policyService
  });
  const eventIngestService = new AssistantEventIngestService({
    observationService: {
      runtimeSessionManager
    },
    approvalGovernor
  });
  const conversationStore = new AgentChannelConversationStore({
    configDir: createTempDir('cligate-approval-governor-conv-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-approval-governor-delivery-')
  });
  return {
    approvalPolicyStore,
    runtimeSessionManager,
    messageService,
    policyService,
    approvalGovernor,
    eventIngestService,
    conversationStore,
    deliveryStore
  };
}

async function createConversationAndSession({
  runtimeSessionManager,
  conversationStore,
  externalConversationId = 'approval-governor-chat-1',
  provider = 'claude-code'
} = {}) {
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId,
    externalUserId: 'user-1',
    title: 'tester / telegram',
    metadata: {
      assistantCore: buildAssistantCoreDeliveryState({}, {
        controlMode: 'assistant'
      })
    }
  });
  const session = await runtimeSessionManager.createSession({
    provider,
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
  return { conversation, session };
}

test('approval governor auto-approves remembered approval policies in assistant mode', async () => {
  const {
    policyService,
    approvalGovernor,
    runtimeSessionManager,
    conversationStore
  } = createFixture();

  const { conversation, session } = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    provider: 'claude-code'
  });

  const approval = runtimeSessionManager.approvalService.createApproval({
    sessionId: session.id,
    provider: 'claude-code',
    title: 'Read workspace file',
    summary: 'Need permission',
    rawRequest: {
      tool_name: 'Read',
      input: {
        file_path: 'D:\\github\\proxypool-hub\\README.md'
      }
    }
  });

  policyService.rememberApproval({
    approval,
    scope: 'runtime_session',
    scopeRef: session.id
  });

  const result = await approvalGovernor.governApproval({
    conversation,
    runtimeSession: session,
    approval
  });

  assert.equal(result.action, 'approve');
  assert.equal(result.resolvedApproval?.status, 'approved');
});

test('assistant event ingest auto-approves remembered approval requests and only asks user when no policy matches', async () => {
  const {
    policyService,
    eventIngestService,
    runtimeSessionManager,
    conversationStore,
    deliveryStore
  } = createFixture();

  const sent = [];
  const dispatcher = new AgentChannelOutboundDispatcher({
    runtimeSessionManager,
    conversationStore,
    deliveryStore,
    eventIngestService,
    registry: {
      get() {
        return {
          async sendMessage({ text }) {
            sent.push(text);
            return { messageId: `approval_delivery_${sent.length}` };
          }
        };
      }
    }
  });

  const first = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    externalConversationId: 'approval-auto-chat-1',
    provider: 'claude-code'
  });
  const rememberedApproval = runtimeSessionManager.approvalService.createApproval({
    sessionId: first.session.id,
    provider: 'claude-code',
    title: 'Read workspace file',
    summary: 'Need permission',
    rawRequest: {
      tool_name: 'Read',
      input: {
        file_path: 'D:\\github\\proxypool-hub\\README.md'
      }
    }
  });
  policyService.rememberApproval({
    approval: rememberedApproval,
    scope: 'runtime_session',
    scopeRef: first.session.id
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: first.session.id,
    seq: 3001,
    type: AGENT_EVENT_TYPE.APPROVAL_REQUEST,
    ts: new Date().toISOString(),
    payload: {
      approvalId: rememberedApproval.approvalId,
      title: rememberedApproval.title,
      summary: rememberedApproval.summary,
      rawRequest: rememberedApproval.rawRequest
    }
  });

  assert.equal(sent.length, 1);
  assert.match(sent[0], /自动批准|auto-approved/i);
  assert.equal(runtimeSessionManager.approvalService.getApproval(first.session.id, rememberedApproval.approvalId)?.status, 'approved');

  const second = await createConversationAndSession({
    runtimeSessionManager,
    conversationStore,
    externalConversationId: 'approval-ask-chat-2',
    provider: 'claude-code'
  });
  const unknownApproval = runtimeSessionManager.approvalService.createApproval({
    sessionId: second.session.id,
    provider: 'claude-code',
    title: 'Write workspace file',
    summary: 'Need permission',
    rawRequest: {
      tool_name: 'Write',
      input: {
        file_path: 'D:\\github\\proxypool-hub\\src\\new-file.js'
      }
    }
  });

  await dispatcher.handleRuntimeEvent({
    sessionId: second.session.id,
    seq: 3002,
    type: AGENT_EVENT_TYPE.APPROVAL_REQUEST,
    ts: new Date().toISOString(),
    payload: {
      approvalId: unknownApproval.approvalId,
      title: unknownApproval.title,
      summary: unknownApproval.summary,
      rawRequest: unknownApproval.rawRequest
    }
  });

  assert.equal(sent.length, 2);
  assert.match(sent[1], /需要你的确认|needs your approval/i);
  assert.equal(runtimeSessionManager.approvalService.getApproval(second.session.id, unknownApproval.approvalId)?.status, 'pending');
});
