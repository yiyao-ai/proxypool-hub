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
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AssistantObservationService } from '../../src/assistant-core/observation-service.js';
import { TaskStore as AssistantDomainTaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore as AssistantDomainExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ProjectStore as AssistantDomainProjectStore } from '../../src/assistant-core/domain/project-store.js';
import {
  handleGetAssistantWorkspaceContext,
  handleListAssistantRuntimeSessions,
  handleGetAssistantRuntimeSession,
  handleGetAssistantRuntimeTurn,
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
  const assistantTaskStore = new AssistantDomainTaskStore({
    configDir: createTempDir('cligate-assistant-observation-domain-task-')
  });
  const assistantExecutionStore = new AssistantDomainExecutionStore({
    configDir: createTempDir('cligate-assistant-observation-domain-execution-')
  });
  const assistantProjectStore = new AssistantDomainProjectStore({
    configDir: createTempDir('cligate-assistant-observation-domain-project-')
  });

  return {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    assistantTaskStore,
    assistantExecutionStore,
    assistantProjectStore,
    observationService: new AssistantObservationService({
      runtimeSessionManager,
      conversationStore,
      taskStore,
      deliveryStore,
      assistantTaskStore,
      assistantExecutionStore,
      assistantProjectStore
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
        controlMode: 'assistant',
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
  assert.equal(workspace.summary.turnCount, 1);
  assert.ok(Array.isArray(workspace.workspaces));
  assert.ok(workspace.workspaces.length >= 1);
  assert.equal(workspace.turnStats.turnCount, 1);
  assert.equal(workspace.turnStats.messageCount, 1);
  assert.equal(workspace.runtimeSessions[0].id, session.id);
  assert.equal(workspace.runtimeSessions[0].latestTurn.input, 'inspect repo');
  assert.equal(workspace.runtimeSessions[0].turnStats.turnCount, 1);
  assert.equal(workspace.conversations[0].assistantMode, 'assistant');
  assert.ok(Array.isArray(workspace.conversations[0].trackedTaskIds));

  const runtimeDetail = observationService.getRuntimeSessionDetail(session.id);
  assert.equal(runtimeDetail.session.id, session.id);
  assert.equal(runtimeDetail.session.latestTurn.id, runtimeDetail.turns[0].id);
  assert.equal(runtimeDetail.session.turnStats.turnCount, 1);
  assert.equal(runtimeDetail.turns.length, 1);
  assert.equal(runtimeDetail.turns[0].input, 'inspect repo');
  assert.equal(runtimeDetail.turns[0].stats.messageCount, 1);
  assert.equal(runtimeDetail.turns[0].stats.lastMessage, 'echo:inspect repo');
  assert.equal(runtimeDetail.task.title, 'inspect repo');
  assert.ok(Array.isArray(runtimeDetail.recentEvents));

  const turnDetail = observationService.getRuntimeTurnDetail(session.id, runtimeDetail.turns[0].id);
  assert.equal(turnDetail.turn.id, runtimeDetail.turns[0].id);
  assert.equal(turnDetail.turn.stats.messageCount, 1);
  assert.ok(Array.isArray(turnDetail.recentEvents));
  assert.ok(turnDetail.recentEvents.every((event) => event.turnId === runtimeDetail.turns[0].id));

  const conversationDetail = observationService.getConversationContext(conversation.id);
  assert.equal(conversationDetail.conversation.id, conversation.id);
  assert.equal(conversationDetail.activeRuntime.id, session.id);
  assert.equal(conversationDetail.latestTask.title, 'inspect repo');
  assert.ok('currentTask' in conversationDetail);
  assert.ok(conversationDetail.workspace);
  assert.ok(typeof conversationDetail.workspace.workspaceRef === 'string');
  assert.equal(conversationDetail.deliveries.length, 1);
  assert.ok(conversationDetail.memory);
  assert.ok(conversationDetail.policy);
  assert.ok(Array.isArray(conversationDetail.policy.task));
  assert.ok(Array.isArray(conversationDetail.policy.execution));
  assert.ok(Array.isArray(conversationDetail.policy.project));

  const search = observationService.searchProjectMemory({ query: 'inspect', limit: 5 });
  assert.equal(search.tasks.length, 1);
  assert.equal(search.conversations.length, 0);
});

test('AssistantObservationService resolves pending approval and question from pending session hints instead of only active runtime', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    observationService
  } = createObservationFixture();

  const activeSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'active task'
  });
  const waitingSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'waiting task'
  });

  const approval = runtimeSessionManager.approvalService.createApproval({
    sessionId: waitingSession.id,
    provider: 'codex',
    title: 'Write file',
    summary: 'Need permission to continue',
    rawRequest: {
      requestId: 'approval-waiting-1'
    }
  });
  runtimeSessionManager.questionsBySession.set(waitingSession.id, [{
    questionId: 'question-waiting-1',
    status: 'pending',
    text: 'Need your answer',
    createdAt: new Date().toISOString()
  }]);

  const conversation = conversationStore.findOrCreateBySessionId('obs-chat-pending-hint-1');
  conversationStore.bindRuntimeSession(conversation.id, activeSession.id, {
    trackedRuntimeSessionIds: [activeSession.id, waitingSession.id],
    lastPendingApprovalId: approval.approvalId,
    lastPendingApprovalSessionId: waitingSession.id,
    lastPendingQuestionId: 'question-waiting-1',
    lastPendingQuestionSessionId: waitingSession.id
  });

  const detail = observationService.getConversationContext(conversation.id);
  assert.equal(detail.activeRuntime.id, activeSession.id);
  assert.equal(detail.pendingApprovals.length, 1);
  assert.equal(detail.pendingApprovals[0].approvalId, approval.approvalId);
  assert.equal(detail.pendingApprovals[0].sessionId, waitingSession.id);
  assert.equal(detail.pendingQuestions.length, 1);
  assert.equal(detail.pendingQuestions[0].questionId, 'question-waiting-1');
  assert.equal(detail.pendingQuestions[0].sessionId, waitingSession.id);
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
  const originalRuntimeTurnDetail = handleGetAssistantRuntimeTurn;
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
    getRuntimeTurnDetail,
    listConversations,
    getConversationContext
  } = singleton;
  singleton.getWorkspaceContext = observationService.getWorkspaceContext.bind(observationService);
  singleton.listRuntimeSessions = observationService.listRuntimeSessions.bind(observationService);
  singleton.getRuntimeSessionDetail = observationService.getRuntimeSessionDetail.bind(observationService);
  singleton.getRuntimeTurnDetail = observationService.getRuntimeTurnDetail.bind(observationService);
  singleton.listConversations = observationService.listConversations.bind(observationService);
  singleton.getConversationContext = observationService.getConversationContext.bind(observationService);

  try {
    const workspaceRes = mockRes();
    handleGetAssistantWorkspaceContext({ query: {} }, workspaceRes);
    assert.equal(workspaceRes._status, 200);
    assert.equal(workspaceRes._body.success, true);
    assert.equal(workspaceRes._body.context.summary.runtimeCount, 1);
    assert.equal(workspaceRes._body.context.turnStats.turnCount, 1);
    assert.ok(workspaceRes._body.context.memory);
    assert.ok(workspaceRes._body.context.policy);
    assert.ok(Array.isArray(workspaceRes._body.context.policy.person));

    const runtimeListRes = mockRes();
    handleListAssistantRuntimeSessions({ query: {} }, runtimeListRes);
    assert.equal(runtimeListRes._body.sessions[0].id, session.id);
    assert.equal(runtimeListRes._body.sessions[0].latestTurn.input, 'check status');

    const runtimeDetailRes = mockRes();
    handleGetAssistantRuntimeSession({ params: { id: session.id }, query: {} }, runtimeDetailRes);
    assert.equal(runtimeDetailRes._status, 200);
    assert.equal(runtimeDetailRes._body.detail.session.id, session.id);
    assert.equal(runtimeDetailRes._body.detail.turns.length, 1);

    const runtimeTurnDetailRes = mockRes();
    handleGetAssistantRuntimeTurn({
      params: { id: session.id, turnId: runtimeDetailRes._body.detail.turns[0].id },
      query: {}
    }, runtimeTurnDetailRes);
    assert.equal(runtimeTurnDetailRes._status, 200);
    assert.equal(runtimeTurnDetailRes._body.detail.turn.id, runtimeDetailRes._body.detail.turns[0].id);

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

    const missingTurnRes = mockRes();
    handleGetAssistantRuntimeTurn({ params: { id: session.id, turnId: 'missing' }, query: {} }, missingTurnRes);
    assert.equal(missingTurnRes._status, 404);

    const missingConversationRes = mockRes();
    handleGetAssistantConversationContext({ params: { id: 'missing' }, query: {} }, missingConversationRes);
    assert.equal(missingConversationRes._status, 404);
  } finally {
    singleton.getWorkspaceContext = getWorkspaceContext;
    singleton.listRuntimeSessions = listRuntimeSessions;
    singleton.getRuntimeSessionDetail = getRuntimeSessionDetail;
    singleton.getRuntimeTurnDetail = getRuntimeTurnDetail;
    singleton.listConversations = listConversations;
    singleton.getConversationContext = getConversationContext;
    void originalRuntimeTurnDetail;
    void originalWorkspace;
    void originalRuntimeList;
    void originalRuntimeDetail;
    void originalConversationList;
    void originalConversationDetail;
  }
});

test('AssistantObservationService exposes assistant domain links in conversation context when dual-write metadata exists', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    assistantTaskStore,
    assistantExecutionStore,
    assistantProjectStore,
    observationService
  } = createObservationFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo'
  });
  const conversation = conversationStore.findOrCreateBySessionId('obs-domain-link-1');
  conversationStore.bindRuntimeSession(conversation.id, session.id);

  const assistantProject = assistantProjectStore.create({
    ownerPersonId: 'person-1',
    name: 'repo project',
    kind: 'misc'
  });
  const assistantTask = assistantTaskStore.create({
    projectId: assistantProject.id,
    ownerPersonId: 'person-1',
    title: 'inspect repo',
    goal: 'inspect repo'
  });
  const assistantExecution = assistantExecutionStore.create({
    taskId: assistantTask.id,
    ownerPersonId: 'person-1',
    provider: 'codex',
    role: 'primary',
    objective: 'inspect repo',
    currentRuntimeSessionId: session.id
  });

  taskStore.create({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    provider: session.provider,
    title: 'inspect repo',
    status: 'completed',
    summary: 'done:inspect repo',
    metadata: {
      assistantProjectId: assistantProject.id,
      assistantTaskId: assistantTask.id,
      assistantExecutionId: assistantExecution.id
    }
  });

  const detail = observationService.getConversationContext(conversation.id);
  assert.equal(detail.latestTask.assistantDomain?.task?.id, assistantTask.id);
  assert.equal(detail.latestTask.assistantDomain?.execution?.id, assistantExecution.id);
  assert.equal(detail.latestTask.assistantDomain?.project?.id, assistantProject.id);
});

test('AssistantObservationService resolves conversation context from assistant domain working set without supervisor task records', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    assistantTaskStore,
    assistantExecutionStore,
    assistantProjectStore,
    observationService
  } = createObservationFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo from domain only',
    cwd: 'D:\\github\\proxypool-hub'
  });
  const assistantProject = assistantProjectStore.create({
    ownerPersonId: 'person-domain-only',
    name: 'proxypool-hub',
    kind: 'code_project',
    cwd: 'D:\\github\\proxypool-hub'
  });
  const assistantTask = assistantTaskStore.create({
    projectId: assistantProject.id,
    ownerPersonId: 'person-domain-only',
    title: 'inspect repo from domain only',
    goal: 'inspect repo from domain only',
    lastConversationId: 'conv-domain-only',
    activeExecutionIds: ['exec-domain-only'],
    allExecutionIds: ['exec-domain-only']
  });
  const assistantExecution = assistantExecutionStore.create({
    id: 'exec-domain-only',
    taskId: assistantTask.id,
    ownerPersonId: 'person-domain-only',
    provider: 'codex',
    role: 'primary',
    objective: 'inspect repo from domain only',
    status: 'ready',
    currentRuntimeSessionId: session.id
  });

  const conversation = conversationStore.findOrCreateBySessionId('conv-domain-only');
  conversationStore.bindRuntimeSession(conversation.id, session.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantDomain: {
        ...(conversation.metadata?.assistantDomain || {}),
        personId: 'person-domain-only',
        workingSet: {
          primaryProjectId: assistantProject.id,
          primaryTaskId: assistantTask.id,
          recentTaskIds: [assistantTask.id],
          mentionedProjectIds: [assistantProject.id]
        }
      }
    }
  });

  const detail = observationService.getConversationContext(conversation.id);
  assert.equal(detail.conversation.activeTaskId, assistantTask.id);
  assert.equal(detail.latestTask.id, assistantTask.id);
  assert.equal(detail.latestTask.runtimeSessionId, session.id);
  assert.equal(detail.latestTask.title, assistantTask.title);
  assert.equal(detail.latestTask.assistantDomain?.task?.id, assistantTask.id);
  assert.equal(detail.latestTask.assistantDomain?.execution?.id, assistantExecution.id);
  assert.equal(detail.latestTask.assistantDomain?.project?.id, assistantProject.id);
  assert.equal(detail.policy.task.length, 0);
  assert.equal(detail.policy.execution.length, 0);
  assert.equal(detail.policy.project.length, 0);
});
