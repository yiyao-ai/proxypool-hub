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
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';
import { AssistantPolicyService } from '../../src/assistant-core/policy-service.js';
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

// FakeProvider 模拟一次发起 approval_request 然后 turn 暂停在 waiting_approval。
class ApprovalRequestingProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {};
    this.respondApproval = async () => {};
  }
  async startTurn({ session, onApprovalRequest }) {
    // 模拟 claude-code 的 WebFetch 权限请求：rawRequest 没有 file_path / command
    onApprovalRequest({
      kind: 'tool_permission',
      title: 'Claude Code wants to use WebFetch',
      summary: 'WebFetch permission for https://example.com',
      rawRequest: {
        tool_name: 'WebFetch',
        input: { url: 'https://example.com' }
      }
    });
    // 注意：不调 onTurnFinished —— turn 在 waiting_approval 状态挂起
    return {
      respondApproval: this.respondApproval
    };
  }
}

function createFixture() {
  const configDir = createTempDir('cligate-resolve-remember-');
  const registry = new AgentRuntimeRegistry();
  registry.register(new ApprovalRequestingProvider());
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({ configDir });
  const policyService = new AssistantPolicyService({ approvalPolicyStore });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({ configDir }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore,
    policyService
  });
  const supervisorTaskStore = new SupervisorTaskStore({ configDir });
  const conversationStore = new AgentChannelConversationStore({ configDir });
  const stateCoordinator = new StateCoordinator({
    conversationStore,
    personStore: new PersonStore({ configDir }),
    projectStore: new ProjectStore({ configDir }),
    taskStore: new TaskStore({ configDir }),
    executionStore: new ExecutionStore({ configDir }),
    scheduledTaskStore: new ScheduledTaskStore({ configDir }),
    episodeLedger: new EpisodeLedger({ configDir })
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    approvalPolicyStore,
    supervisorTaskStore,
    policyService,
    stateCoordinator
  });
  return {
    conversationStore,
    stateCoordinator,
    runtimeSessionManager,
    approvalPolicyStore,
    policyService,
    messageService
  };
}

test('resolveApproval with remember="session" creates a wildcard policy that auto-approves later requests', async () => {
  const { runtimeSessionManager, approvalPolicyStore, messageService } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: '查深圳天气'
  });

  // 应当有一条 pending approval
  const pending = runtimeSessionManager.approvalService.listPending(session.id);
  assert.equal(pending.length, 1, 'one pending approval should exist');
  const approvalId = pending[0].approvalId;

  // 模拟用户说"同意，允许后续所有操作"——LLM 调 resolve_runtime_approval(decision='approve', remember='session')
  const result = await messageService.resolveApproval({
    sessionId: session.id,
    approvalId,
    decision: 'approve',
    remember: 'session'
  });

  assert.equal(result.status, 'approved');
  assert.ok(result.policy, 'policy should be created');
  assert.equal(result.policy.scope, 'execution');
  assert.equal(result.policy.scopeRef, session.id);
  assert.equal(result.policy.toolName, 'WebFetch');
  assert.deepEqual(result.policy.pathPatterns, []);
  assert.deepEqual(result.policy.commandPrefixes, []);
});

test('resolveApproval without remember does not create a policy', async () => {
  const { runtimeSessionManager, approvalPolicyStore, messageService } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: '查上海天气'
  });

  const pending = runtimeSessionManager.approvalService.listPending(session.id);
  const approvalId = pending[0].approvalId;

  const result = await messageService.resolveApproval({
    sessionId: session.id,
    approvalId,
    decision: 'approve'
    // remember not set => default 'none'
  });

  assert.equal(result.status, 'approved');
  assert.equal(result.policy, undefined, 'no policy should be set');
  assert.equal(approvalPolicyStore.listPolicies().length, 0);
});

test('resolveApproval with remember="conversation" requires conversationId', async () => {
  const { runtimeSessionManager, approvalPolicyStore, messageService } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: '查广州天气'
  });
  const pending = runtimeSessionManager.approvalService.listPending(session.id);
  const approvalId = pending[0].approvalId;

  const result = await messageService.resolveApproval({
    sessionId: session.id,
    approvalId,
    decision: 'approve',
    remember: 'conversation',
    conversationId: 'conv-test-1'
  });

  assert.equal(result.status, 'approved');
  assert.ok(result.policy);
  assert.equal(result.policy.scope, 'task');
  assert.equal(result.policy.scopeRef, 'conv-test-1');
});

test('resolveApproval maps remember aliases onto assistant domain scope refs when available', async () => {
  const { runtimeSessionManager, approvalPolicyStore, messageService } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: '查杭州天气',
    metadata: {
      assistantPersonId: 'person-1',
      assistantProjectId: 'project-1',
      assistantTaskId: 'task-1',
      assistantExecutionId: 'execution-1'
    }
  });
  const pending = runtimeSessionManager.approvalService.listPending(session.id);
  const approvalId = pending[0].approvalId;

  const taskScoped = await messageService.resolveApproval({
    sessionId: session.id,
    approvalId,
    decision: 'approve',
    remember: 'conversation',
    metadata: {
      taskId: 'task-1',
      projectId: 'project-1',
      globalUserId: 'person-1',
      executionId: 'execution-1'
    }
  });

  assert.equal(taskScoped.status, 'approved');
  assert.ok(taskScoped.policy);
  assert.equal(taskScoped.policy.scope, 'task');
  assert.equal(taskScoped.policy.scopeRef, 'task-1');
  assert.equal(approvalPolicyStore.listPolicies({ scope: 'task', scopeRef: 'task-1' }).length, 1);
});

test('message service records approval/question/cancel runtime episodes', async () => {
  const { runtimeSessionManager, messageService, conversationStore, stateCoordinator } = createFixture();
  const conversation = conversationStore.findOrCreateByExternal({
    channel: 'telegram',
    accountId: 'default',
    externalConversationId: 'resolve-remember-ledger-chat-1',
    externalUserId: 'user-1',
    title: 'resolve remember ledger'
  });

  const session = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: '查成都天气',
    metadata: {
      conversationId: conversation.id,
      assistantPersonId: 'person-1',
      assistantProjectId: 'project-1',
      assistantTaskId: 'task-1',
      assistantExecutionId: 'execution-1'
    }
  });

  const pendingApproval = runtimeSessionManager.approvalService.listPending(session.id)[0];
  const resolved = await messageService.resolveApproval({
    sessionId: session.id,
    approvalId: pendingApproval.approvalId,
    decision: 'approve',
    conversation
  });
  assert.equal(resolved.status, 'approved');

  const approvalEpisodes = stateCoordinator.episodeLedger.listByEntity({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    kind: 'runtime.approval_resolved',
    limit: 10
  });
  assert.equal(approvalEpisodes.length, 1);
  assert.equal(approvalEpisodes[0].payload.approvalId, pendingApproval.approvalId);
  assert.equal(approvalEpisodes[0].payload.decision, 'approved');

  runtimeSessionManager.questionsBySession.set(session.id, [{
    questionId: 'question-1',
    sessionId: session.id,
    turnId: `${session.id}:turn:1`,
    provider: 'claude-code',
    status: 'pending',
    text: 'continue?',
    options: [],
    rawRequest: null,
    createdAt: new Date().toISOString(),
    answeredAt: null
  }]);
  runtimeSessionManager.turnHandles.set(session.id, {
    respondQuestion: async () => {},
    cancel() {}
  });

  const answered = await messageService.answerQuestion({
    sessionId: session.id,
    questionId: 'question-1',
    answer: 'yes'
  });
  assert.equal(answered.status, 'answered');

  const answeredEpisodes = stateCoordinator.episodeLedger.listByEntity({
    conversationId: '',
    runtimeSessionId: session.id,
    kind: 'runtime.question_answered',
    limit: 10
  });
  assert.equal(answeredEpisodes.length, 1);
  assert.equal(answeredEpisodes[0].payload.questionId, 'question-1');
  assert.equal(answeredEpisodes[0].payload.answer, 'yes');

  runtimeSessionManager.questionsBySession.set(session.id, [{
    questionId: 'question-2',
    sessionId: session.id,
    turnId: `${session.id}:turn:1`,
    provider: 'claude-code',
    status: 'pending',
    text: 'cancel?',
    options: [],
    rawRequest: null,
    createdAt: new Date().toISOString(),
    answeredAt: null
  }]);

  const cancelledQuestion = messageService.cancelPendingQuestion({
    sessionId: session.id,
    questionId: 'question-2',
    reason: 'user switched intent'
  });
  assert.equal(cancelledQuestion.status, 'cancelled');

  const cancelledQuestionEpisodes = stateCoordinator.episodeLedger.listByEntity({
    runtimeSessionId: session.id,
    kind: 'runtime.question_cancelled',
    limit: 10
  });
  assert.equal(cancelledQuestionEpisodes.length, 1);
  assert.equal(cancelledQuestionEpisodes[0].payload.questionId, 'question-2');
  assert.equal(cancelledQuestionEpisodes[0].payload.reason, 'user switched intent');

  const cancelledSession = messageService.cancelRuntimeSession({
    sessionId: session.id,
    conversation
  });
  assert.equal(cancelledSession.status, 'cancelled');

  const cancelledSessionEpisodes = stateCoordinator.episodeLedger.listByEntity({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    kind: 'runtime.cancelled',
    limit: 10
  });
  assert.equal(cancelledSessionEpisodes.length, 1);
  assert.equal(cancelledSessionEpisodes[0].payload.reason, 'user_cancelled');
});
