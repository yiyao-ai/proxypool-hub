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
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AssistantObservationService } from '../../src/assistant-core/observation-service.js';
import {
  handleGetAssistantWorkspaceContext,
  handleListAssistantRuntimeSessions,
  handleGetAssistantRuntimeSession,
  handleListAssistantConversations,
  handleGetAssistantConversationContext
} from '../../src/routes/assistant-observation-route.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
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

function createObservationFixture() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-observation-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-observation-policy-')
    })
  });
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-assistant-observation-conv-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-assistant-observation-task-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-observation-delivery-')
  });

  return {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    observationService: new AssistantObservationService({
      runtimeSessionManager,
      conversationStore,
      taskStore,
      deliveryStore
    })
  };
}

test('AssistantObservationService returns summary-first workspace and drill-down details', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    observationService
  } = createObservationFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo'
  });
  const conversation = conversationStore.findOrCreateBySessionId('obs-chat-1');
  conversationStore.bindRuntimeSession(conversation.id, session.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantCore: {
        ...(conversation.metadata?.assistantCore || {}),
        mode: 'assistant',
        assistantSessionId: 'assistant-session-1',
        lastRunId: 'assistant-run-1'
      }
    }
  });
  taskStore.create({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    provider: session.provider,
    title: 'inspect repo',
    status: 'completed',
    summary: 'done:inspect repo'
  });
  deliveryStore.saveInbound({
    channel: 'chat-ui',
    conversationId: conversation.id,
    sessionId: session.id,
    externalMessageId: 'msg-1',
    payload: { text: 'inspect repo' }
  });

  const workspace = observationService.getWorkspaceContext();
  assert.equal(workspace.summary.runtimeCount, 1);
  assert.equal(workspace.summary.conversationCount, 1);
  assert.equal(workspace.runtimeSessions[0].id, session.id);
  assert.equal(workspace.conversations[0].assistantMode, 'assistant');

  const runtimeDetail = observationService.getRuntimeSessionDetail(session.id);
  assert.equal(runtimeDetail.session.id, session.id);
  assert.equal(runtimeDetail.task.title, 'inspect repo');
  assert.ok(Array.isArray(runtimeDetail.recentEvents));

  const conversationDetail = observationService.getConversationContext(conversation.id);
  assert.equal(conversationDetail.conversation.id, conversation.id);
  assert.equal(conversationDetail.activeRuntime.id, session.id);
  assert.equal(conversationDetail.latestTask.title, 'inspect repo');
  assert.equal(conversationDetail.deliveries.length, 1);
});

test('assistant observation routes return workspace, runtime, and conversation details', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    observationService
  } = createObservationFixture();

  const originalWorkspace = handleGetAssistantWorkspaceContext;
  const originalRuntimeList = handleListAssistantRuntimeSessions;
  const originalRuntimeDetail = handleGetAssistantRuntimeSession;
  const originalConversationList = handleListAssistantConversations;
  const originalConversationDetail = handleGetAssistantConversationContext;

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'check status'
  });
  const conversation = conversationStore.findOrCreateBySessionId('obs-chat-2');
  conversationStore.bindRuntimeSession(conversation.id, session.id);
  taskStore.create({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    provider: session.provider,
    title: 'check status',
    status: 'completed'
  });
  deliveryStore.saveOutbound({
    channel: 'chat-ui',
    conversationId: conversation.id,
    sessionId: session.id,
    payload: { text: 'done' }
  });

  // Monkey patch singleton-backed service calls by replacing methods on the imported singleton.
  const singleton = (await import('../../src/assistant-core/observation-service.js')).default;
  const {
    getWorkspaceContext,
    listRuntimeSessions,
    getRuntimeSessionDetail,
    listConversations,
    getConversationContext
  } = singleton;
  singleton.getWorkspaceContext = observationService.getWorkspaceContext.bind(observationService);
  singleton.listRuntimeSessions = observationService.listRuntimeSessions.bind(observationService);
  singleton.getRuntimeSessionDetail = observationService.getRuntimeSessionDetail.bind(observationService);
  singleton.listConversations = observationService.listConversations.bind(observationService);
  singleton.getConversationContext = observationService.getConversationContext.bind(observationService);

  try {
    const workspaceRes = mockRes();
    handleGetAssistantWorkspaceContext({ query: {} }, workspaceRes);
    assert.equal(workspaceRes._status, 200);
    assert.equal(workspaceRes._body.success, true);
    assert.equal(workspaceRes._body.context.summary.runtimeCount, 1);

    const runtimeListRes = mockRes();
    handleListAssistantRuntimeSessions({ query: {} }, runtimeListRes);
    assert.equal(runtimeListRes._body.sessions[0].id, session.id);

    const runtimeDetailRes = mockRes();
    handleGetAssistantRuntimeSession({ params: { id: session.id }, query: {} }, runtimeDetailRes);
    assert.equal(runtimeDetailRes._status, 200);
    assert.equal(runtimeDetailRes._body.detail.session.id, session.id);

    const conversationListRes = mockRes();
    handleListAssistantConversations({ query: {} }, conversationListRes);
    assert.equal(conversationListRes._body.conversations[0].id, conversation.id);

    const conversationDetailRes = mockRes();
    handleGetAssistantConversationContext({ params: { id: conversation.id }, query: {} }, conversationDetailRes);
    assert.equal(conversationDetailRes._status, 200);
    assert.equal(conversationDetailRes._body.detail.conversation.id, conversation.id);

    const missingRuntimeRes = mockRes();
    handleGetAssistantRuntimeSession({ params: { id: 'missing' }, query: {} }, missingRuntimeRes);
    assert.equal(missingRuntimeRes._status, 404);

    const missingConversationRes = mockRes();
    handleGetAssistantConversationContext({ params: { id: 'missing' }, query: {} }, missingConversationRes);
    assert.equal(missingConversationRes._status, 404);
  } finally {
    singleton.getWorkspaceContext = getWorkspaceContext;
    singleton.listRuntimeSessions = listRuntimeSessions;
    singleton.getRuntimeSessionDetail = getRuntimeSessionDetail;
    singleton.listConversations = listConversations;
    singleton.getConversationContext = getConversationContext;
    void originalWorkspace;
    void originalRuntimeList;
    void originalRuntimeDetail;
    void originalConversationList;
    void originalConversationDetail;
  }
});
