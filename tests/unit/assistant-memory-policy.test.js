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
  const memoryService = new AssistantMemoryService({ preferenceStore });

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
