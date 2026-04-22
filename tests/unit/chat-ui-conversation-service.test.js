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
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { ChatUiConversationService } from '../../src/chat-ui/conversation-service.js';
import { ChatUiRuntimeObserver } from '../../src/chat-ui/runtime-observer.js';

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
      summary: 'Run command',
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

function createHybridRuntimeManager() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeInteractiveProvider());
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-chat-ui-runtime-hybrid-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-chat-ui-runtime-hybrid-policy-')
    })
  });
}

test('ChatUiConversationService stores preferences and reuses saved provider for new tasks', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-chat-ui-conv-pref-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-chat-ui-task-pref-')
  });
  const preferenceStore = new AgentPreferenceStore({
    configDir: createTempDir('cligate-chat-ui-pref-store-')
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    preferenceStore
  });
  const service = new ChatUiConversationService({
    conversationStore,
    messageService,
    taskStore
  });

  const saved = await service.routeMessage({
    sessionId: 'chat-ui-pref-1',
    text: '记住：以后默认中文回复，优先用 Claude Code，并且尽量最小改动',
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(saved.type, 'preference_saved');
  assert.match(String(saved.message || ''), /Preference saved/i);

  const started = await service.routeMessage({
    sessionId: 'chat-ui-pref-1',
    text: '帮我检查一下这个仓库的登录流程',
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(started.type, 'runtime_started');
  assert.equal(started.provider, 'claude-code');
  assert.equal(started.session.provider, 'claude-code');
  assert.equal(started.conversation.channel, 'chat-ui');
  assert.equal(started.conversation.activeRuntimeSessionId, started.session.id);
});

test('ChatUiConversationService revives remembered follow-up without an active runtime session', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-chat-ui-conv-followup-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-chat-ui-task-followup-')
  });
  const service = new ChatUiConversationService({
    conversationStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    taskStore
  });

  const existing = conversationStore.findOrCreateBySessionId('chat-ui-followup-1', {
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
  });
  assert.ok(existing);

  const result = await service.routeMessage({
    sessionId: 'chat-ui-followup-1',
    text: '把按钮改成绿色',
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(result.type, 'runtime_started');
  assert.equal(result.provider, 'claude-code');
  assert.equal(result.startedFresh, true);
  assert.match(String(result.message || ''), /remembered conversation context/i);
  assert.equal(result.conversation.activeRuntimeSessionId, result.session.id);
});

test('ChatUiRuntimeObserver writes runtime approval and completion state back into chat-ui conversation memory', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-chat-ui-conv-observer-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-chat-ui-task-observer-')
  });
  const observer = new ChatUiRuntimeObserver({
    runtimeSessionManager,
    conversationStore,
    taskStore
  });
  const service = new ChatUiConversationService({
    conversationStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    taskStore
  });

  observer.start();
  try {
    const started = await service.routeMessage({
      sessionId: 'chat-ui-observer-1',
      text: '/cc inspect repo',
      defaultRuntimeProvider: 'codex'
    });

    const afterInteractiveEvents = conversationStore.get(started.conversation.id);
    assert.equal(afterInteractiveEvents.lastPendingApprovalId, 'approval-request-1');
    assert.equal(afterInteractiveEvents.lastPendingQuestionId, 'question-1');
    assert.equal(afterInteractiveEvents.metadata?.supervisor?.brief?.status, 'waiting_user');

    await observer.handleRuntimeEvent({
      sessionId: started.session.id,
      seq: 999,
      type: AGENT_EVENT_TYPE.COMPLETED,
      payload: {
        result: 'done'
      }
    });

    const afterCompleted = conversationStore.get(started.conversation.id);
    assert.equal(afterCompleted.lastPendingApprovalId, null);
    assert.equal(afterCompleted.lastPendingQuestionId, null);
    assert.equal(afterCompleted.metadata?.supervisor?.brief?.status, 'completed');
  } finally {
    observer.stop();
  }
});

test('ChatUiConversationService enters assistant mode on /cligate and exits on /runtime', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-chat-ui-conv-assistant-mode-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-chat-ui-task-assistant-mode-')
  });
  const service = new ChatUiConversationService({
    conversationStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    taskStore
  });

  const entered = await service.routeMessage({
    sessionId: 'chat-ui-assistant-mode-1',
    text: '/cligate'
  });

  assert.equal(entered.type, 'assistant_mode_entered');
  assert.equal(entered.conversation.metadata?.assistantCore?.mode, 'assistant');
  assert.ok(entered.assistantSession?.id);

  const exited = await service.routeMessage({
    sessionId: 'chat-ui-assistant-mode-1',
    text: '/runtime'
  });

  assert.equal(exited.type, 'assistant_mode_exited');
  assert.equal(exited.conversation.metadata?.assistantCore?.mode, 'direct-runtime');
});

test('ChatUiConversationService handles one-shot /cligate requests without starting a runtime session', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-chat-ui-conv-assistant-oneshot-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-chat-ui-task-assistant-oneshot-')
  });
  const service = new ChatUiConversationService({
    conversationStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    taskStore
  });

  const result = await service.routeMessage({
    sessionId: 'chat-ui-assistant-oneshot-1',
    text: '/cligate status'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /runtime|conversation|当前/i);
  assert.equal(result.session, undefined);
  assert.equal(result.conversation.activeRuntimeSessionId, null);
  assert.equal(result.conversation.metadata?.assistantCore?.mode, 'direct-runtime');
  assert.ok(result.assistantRun?.id);
});

test('ChatUiConversationService returns to direct runtime handling after /runtime', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-chat-ui-conv-assistant-return-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-chat-ui-task-assistant-return-')
  });
  const service = new ChatUiConversationService({
    conversationStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    taskStore
  });

  await service.routeMessage({
    sessionId: 'chat-ui-assistant-return-1',
    text: '/cligate'
  });

  await service.routeMessage({
    sessionId: 'chat-ui-assistant-return-1',
    text: '/runtime'
  });

  const runtimeResult = await service.routeMessage({
    sessionId: 'chat-ui-assistant-return-1',
    text: '帮我检查一下这个仓库的登录流程',
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(runtimeResult.type, 'runtime_started');
  assert.equal(runtimeResult.session.provider, 'codex');
});

test('ChatUiConversationService runs Phase 4 assistant tool flow to start a runtime task', async () => {
  const runtimeSessionManager = createHybridRuntimeManager();
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-chat-ui-conv-assistant-runner-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-chat-ui-task-assistant-runner-')
  });
  const service = new ChatUiConversationService({
    conversationStore,
    messageService: new AgentOrchestratorMessageService({ runtimeSessionManager }),
    taskStore
  });

  const result = await service.routeMessage({
    sessionId: 'chat-ui-assistant-runner-1',
    text: '/cligate start codex inspect repo',
    defaultRuntimeProvider: 'claude-code'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /Started a new task|已通过 assistant tool 发起新任务/i);
  assert.ok(result.assistantRun?.id);
  assert.equal(result.assistantRun.status, 'completed');
  assert.ok(Array.isArray(result.assistantRun.steps));
  assert.equal(result.assistantRun.steps[0]?.toolName, 'start_runtime_task');
  assert.equal(result.assistantRun.relatedRuntimeSessionIds.length, 1);
});
