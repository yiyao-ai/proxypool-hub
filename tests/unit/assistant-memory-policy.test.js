import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentPreferenceStore } from '../../src/agent-core/preference-store.js';
import { AgentRuntimeApprovalPolicyStore } from '../../src/agent-runtime/approval-policy-store.js';
import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import { AGENT_EVENT_TYPE } from '../../src/agent-runtime/models.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { AssistantMemoryService } from '../../src/assistant-core/memory-service.js';
import { AssistantPolicyService } from '../../src/assistant-core/policy-service.js';
import { AssistantWorkspaceStore } from '../../src/assistant-core/workspace-store.js';
import { AssistantToolRegistry } from '../../src/assistant-core/tool-registry.js';
import AssistantToolExecutor from '../../src/assistant-core/tool-executor.js';
import { AssistantObservationService } from '../../src/assistant-core/observation-service.js';
import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';

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
    return { pid: 111 };
  }
}

class AutoApprovalProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {};
    this.approvals = [];
  }

  async startTurn({ onApprovalRequest, onProviderEvent, onTurnFinished }) {
    onApprovalRequest({
      title: 'Need permission',
      summary: 'Read workspace file',
      rawRequest: {
        requestId: 'approval-auto-1',
        subtype: 'can_use_tool',
        tool_name: 'Read',
        blocked_path: 'D:\\repo\\src\\index.js',
        input: {
          file_path: 'D:\\repo\\src\\index.js'
        }
      }
    });

    return {
      pid: 222,
      respondApproval: async ({ decision }) => {
        this.approvals.push(decision);
        onProviderEvent({
          type: AGENT_EVENT_TYPE.PROGRESS,
          payload: { phase: 'approval_ack', decision }
        });
        onTurnFinished({
          status: 'ready',
          summary: 'approved'
        });
      },
      cancel() {}
    };
  }
}

test('AssistantMemoryService resolves layered preferences across global, workspace, and conversation scopes', () => {
  const preferenceStore = new AgentPreferenceStore({
    configDir: createTempDir('cligate-assistant-memory-')
  });
  const workspaceStore = new AssistantWorkspaceStore({
    configDir: createTempDir('cligate-assistant-memory-workspace-')
  });
  const memoryService = new AssistantMemoryService({ preferenceStore, workspaceStore });

  preferenceStore.upsertPreference({
    scope: 'global_user',
    scopeRef: 'default-user',
    key: 'reply_language',
    value: 'en'
  });
  preferenceStore.upsertPreference({
    scope: 'workspace',
    scopeRef: 'D:\\repo',
    key: 'preferred_runtime_provider',
    value: 'claude-code'
  });
  preferenceStore.upsertPreference({
    scope: 'conversation',
    scopeRef: 'conv-1',
    key: 'reply_language',
    value: 'zh-CN'
  });

  const resolved = memoryService.resolvePreferences({
    conversation: { id: 'conv-1' },
    cwd: 'D:\\repo'
  });

  assert.equal(resolved.values.reply_language, 'zh-CN');
  assert.equal(resolved.values.preferred_runtime_provider, 'claude-code');
  assert.equal(resolved.layers.length, 3);
  assert.equal(resolved.userProfile.replyLanguage, 'zh-CN');
  assert.equal(resolved.userProfile.preferredRuntimeProvider, 'claude-code');
  assert.equal(workspaceStore.getByRef('D:\\repo')?.workspaceRef, 'D:\\repo');
});

test('AgentOrchestratorMessageService uses workspace-scoped preferred provider when no conversation preference exists', async () => {
  const preferenceStore = new AgentPreferenceStore({
    configDir: createTempDir('cligate-assistant-workspace-pref-')
  });
  const memoryService = new AssistantMemoryService({ preferenceStore });
  preferenceStore.upsertPreference({
    scope: 'workspace',
    scopeRef: 'D:\\repo',
    key: 'preferred_runtime_provider',
    value: 'claude-code'
  });

  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new AutoApprovalProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-workspace-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-workspace-policy-')
    })
  });

  const service = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    preferenceStore,
    memoryService
  });

  const response = await service.routeUserMessage({
    message: { text: '帮我检查一下这个仓库的登录流程' },
    conversation: { id: 'conv-workspace-1', metadata: {} },
    defaultRuntimeProvider: 'codex',
    cwd: 'D:\\repo'
  });

  assert.equal(response.type, 'runtime_started');
  assert.equal(response.provider, 'claude-code');
});

test('AssistantPolicyService enables workspace-scoped approval auto-resolution', async () => {
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({
    configDir: createTempDir('cligate-assistant-policy-')
  });
  const policyService = new AssistantPolicyService({ approvalPolicyStore });
  policyService.createApprovalPolicy({
    scope: 'workspace',
    scopeRef: 'D:\\repo',
    provider: 'claude-code',
    toolName: 'Read',
    decision: 'allow',
    pathPatterns: ['D:\\repo\\**']
  });

  const provider = new AutoApprovalProvider();
  const registry = new AgentRuntimeRegistry();
  registry.register(provider);
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-policy-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore,
    policyService
  });

  const session = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: 'read repo',
    cwd: 'D:\\repo',
    metadata: {
      conversationId: 'conv-policy-1'
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(provider.approvals[0], 'approve');
  assert.equal(runtimeSessionManager.approvalService.listPending(session.id).length, 0);
  assert.equal(runtimeSessionManager.getSession(session.id).status, 'ready');
});

test('AssistantPolicyService marks cross-workspace delegation as requiring confirmation', () => {
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({
    configDir: createTempDir('cligate-assistant-policy-scope-')
  });
  const policyService = new AssistantPolicyService({ approvalPolicyStore });

  const decision = policyService.canExecuteToolCall({
    toolName: 'delegate_to_runtime',
    conversation: { id: 'conv-1', metadata: { workspaceId: 'D:\\repo-a' } },
    cwd: 'D:\\repo-a',
    input: {
      provider: 'codex',
      task: 'inspect repo',
      cwd: 'D:\\repo-b'
    }
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.requiresConfirmation, true);
  assert.equal(decision.scopeExpanded, true);
  assert.equal(decision.riskLevel, 'high');
});

test('AssistantToolExecutor blocks tool calls that require confirmation', async () => {
  const registry = new AssistantToolRegistry();
  registry.register({
    name: 'delegate_to_runtime',
    description: 'delegate',
    execute: async () => ({ ok: true })
  });
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({
    configDir: createTempDir('cligate-assistant-tool-policy-')
  });
  const executor = new AssistantToolExecutor({
    toolRegistry: registry,
    policyService: new AssistantPolicyService({ approvalPolicyStore })
  });

  await assert.rejects(
    () => executor.executeToolCall({
      toolName: 'delegate_to_runtime',
      input: {
        provider: 'codex',
        task: 'inspect',
        cwd: 'D:\\repo-b'
      }
    }, {
      conversation: { id: 'conv-2', metadata: { workspaceId: 'D:\\repo-a' } },
      run: { metadata: {} }
    }),
    /requires confirmation/i
  );
});

test('AssistantMemoryService turns runtime_session into a session-memory carrier for runtime state', async () => {
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: (() => {
      const registry = new AgentRuntimeRegistry();
      registry.register(new AutoApprovalProvider());
      return registry;
    })(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-session-memory-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-session-memory-policy-')
    })
  });
  const preferenceStore = new AgentPreferenceStore({
    configDir: createTempDir('cligate-assistant-session-memory-pref-')
  });
  const workspaceStore = new AssistantWorkspaceStore({
    configDir: createTempDir('cligate-assistant-session-memory-workspace-')
  });
  const memoryService = new AssistantMemoryService({
    preferenceStore,
    workspaceStore
  });
  const observationService = new AssistantObservationService({
    conversationStore: new ChatUiConversationStore({
      configDir: createTempDir('cligate-assistant-session-memory-conv-')
    }),
    runtimeSessionManager,
    taskStore: new AgentTaskStore({
      configDir: createTempDir('cligate-assistant-session-memory-task-')
    }),
    deliveryStore: new AgentChannelDeliveryStore({
      configDir: createTempDir('cligate-assistant-session-memory-delivery-')
    }),
    memoryService
  });

  const session = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: 'inspect repo',
    cwd: 'D:\\repo',
    metadata: {
      conversationId: 'conv-session-memory-1'
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const detail = observationService.getRuntimeSessionDetail(session.id, { eventLimit: 20 });
  const runtimeMemory = memoryService.listRuntimeSessionMemory({
    sessionId: session.id,
    limit: 20
  });
  const listed = memoryService.listMemory({
    scope: 'runtime_session',
    scopeRef: session.id
  });

  assert.ok(Array.isArray(detail.runtimeSessionMemory));
  assert.ok(runtimeMemory.some((entry) => entry.key === 'session:status' && entry.kind === 'session'));
  assert.ok(runtimeMemory.some((entry) => entry.key === 'turn:current' && entry.kind === 'turn'));
  assert.ok(runtimeMemory.some((entry) => entry.key === 'approval:pending' && entry.kind === 'approval'));
  assert.ok(runtimeMemory.some((entry) => entry.key === 'question:pending' && entry.kind === 'question'));
  assert.ok(listed.some((entry) => entry.key === 'approval:pending'));
  assert.ok(listed.some((entry) => entry.key === 'question:pending'));
});

test('runtime session memory includes remembered approval policies as temporary authorization state', async () => {
  const approvalPolicyStore = new AgentRuntimeApprovalPolicyStore({
    configDir: createTempDir('cligate-assistant-session-auth-policy-')
  });
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: (() => {
      const registry = new AgentRuntimeRegistry();
      registry.register(new AutoApprovalProvider());
      return registry;
    })(),
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-session-auth-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore
  });
  const memoryService = new AssistantMemoryService({
    preferenceStore: new AgentPreferenceStore({
      configDir: createTempDir('cligate-assistant-session-auth-pref-')
    }),
    workspaceStore: new AssistantWorkspaceStore({
      configDir: createTempDir('cligate-assistant-session-auth-workspace-')
    }),
    policyService: new AssistantPolicyService({ approvalPolicyStore })
  });
  const observationService = new AssistantObservationService({
    conversationStore: new ChatUiConversationStore({
      configDir: createTempDir('cligate-assistant-session-auth-conv-')
    }),
    runtimeSessionManager,
    taskStore: new AgentTaskStore({
      configDir: createTempDir('cligate-assistant-session-auth-task-')
    }),
    deliveryStore: new AgentChannelDeliveryStore({
      configDir: createTempDir('cligate-assistant-session-auth-delivery-')
    }),
    memoryService,
    policyService: new AssistantPolicyService({ approvalPolicyStore })
  });
  const service = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    approvalPolicyStore
  });

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
  assert.ok(resolved.policy);

  const detail = observationService.getRuntimeSessionDetail(started.id);
  const authorizations = detail.runtimeSessionMemory
    .filter((entry) => entry.kind === 'authorization')
    .flatMap((entry) => Array.isArray(entry.value) ? entry.value : []);

  assert.ok(authorizations.some((entry) => entry.policyId === resolved.policy.id));
  assert.ok(authorizations.some((entry) => entry.toolName === resolved.policy.toolName));
});
