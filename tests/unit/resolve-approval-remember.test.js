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
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    approvalPolicyStore,
    supervisorTaskStore,
    policyService
  });
  return {
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
  assert.equal(result.policy.scope, 'runtime_session');
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
  assert.equal(result.policy.scope, 'conversation');
  assert.equal(result.policy.scopeRef, 'conv-test-1');
});
