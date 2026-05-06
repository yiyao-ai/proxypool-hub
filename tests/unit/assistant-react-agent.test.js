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
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { ChatUiConversationService } from '../../src/chat-ui/conversation-service.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AssistantObservationService } from '../../src/assistant-core/observation-service.js';
import { AssistantTaskViewService } from '../../src/assistant-core/task-view-service.js';
import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import { AssistantSessionStore } from '../../src/assistant-core/session-store.js';
import AssistantModeService from '../../src/assistant-core/mode-service.js';
import AssistantDialogueService from '../../src/assistant-agent/dialogue-service.js';
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';
import createDefaultAssistantToolRegistry from '../../src/assistant-core/tool-registry.js';
import { buildAnthropicToolDefinitions } from '../../src/assistant-agent/tool-schema.js';
import { AssistantLlmClient } from '../../src/assistant-agent/llm-client.js';
import { resolveReferenceContext } from '../../src/assistant-agent/reference-resolver.js';

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
    return { pid: 1001 };
  }
}

class DelayedClaudeProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {};
  }

  async startTurn({ input, onProviderEvent, onTurnFinished }) {
    onProviderEvent({
      type: AGENT_EVENT_TYPE.MESSAGE,
      payload: { text: `claude:${input}` }
    });
    setTimeout(() => {
      onTurnFinished({
        status: 'ready',
        summary: `claude-done:${input}`
      });
    }, 15);
    return { pid: 2002 };
  }
}

function createFixture() {
  const runtimeRegistry = new AgentRuntimeRegistry();
  runtimeRegistry.register(new FakeProvider());
  runtimeRegistry.register(new DelayedClaudeProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry: runtimeRegistry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-react-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-react-policy-')
    })
  });
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-assistant-react-conv-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-assistant-react-task-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-react-delivery-')
  });
  const runStore = new AssistantRunStore({
    configDir: createTempDir('cligate-assistant-react-run-')
  });
  const sessionStore = new AssistantSessionStore({
    configDir: createTempDir('cligate-assistant-react-session-')
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-assistant-react-supervisor-')
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    supervisorTaskStore
  });
  const observationService = new AssistantObservationService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    deliveryStore
  });
  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    deliveryStore,
    assistantRunStore: runStore
  });

  return {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    runStore,
    sessionStore,
    supervisorTaskStore,
    messageService,
    observationService,
    taskViewService
  };
}

class FakeLlmClient {
  constructor(responses = []) {
    this.responses = [...responses];
    this.calls = [];
  }

  async hasAvailableSource() {
    return true;
  }

  async complete(input) {
    this.calls.push(input);
    const next = this.responses.shift();
    if (!next) {
      throw new Error('No fake LLM response queued');
    }
    return {
      text: next.text || '',
      toolCalls: next.toolCalls || [],
      source: next.source || {
        kind: 'fake',
        label: 'fake-llm',
        model: 'fake-model'
      }
    };
  }
}

class FailingLlmClient {
  async hasAvailableSource() {
    return true;
  }

  async complete() {
    throw new Error('assistant llm failed');
  }
}

class DisabledLlmClient {
  async hasAvailableSource() {
    return false;
  }

  getFallbackReason() {
    return 'assistant_agent_disabled';
  }
}

function createAssistantService({ llmResponses }) {
  const fixture = createFixture();
  const llmClient = new FakeLlmClient(llmResponses);
  const dialogueService = new AssistantDialogueService({
    runStore: fixture.runStore,
    observationService: fixture.observationService,
    taskViewService: fixture.taskViewService,
    messageService: fixture.messageService,
    llmClient
  });
  const assistantModeService = new AssistantModeService({
    conversationStore: fixture.conversationStore,
    assistantSessionStore: fixture.sessionStore,
    assistantRunStore: fixture.runStore,
    observationService: fixture.observationService,
    messageService: fixture.messageService,
    taskViewService: fixture.taskViewService,
    dialogueService
  });
  const chatService = new ChatUiConversationService({
    conversationStore: fixture.conversationStore,
    messageService: fixture.messageService,
    taskStore: fixture.taskStore,
    assistantModeService
  });

  return {
    ...fixture,
    llmClient,
    dialogueService,
    assistantModeService,
    chatService
  };
}

function createAssistantServiceWithLlmClient(llmClient) {
  const fixture = createFixture();
  const dialogueService = new AssistantDialogueService({
    runStore: fixture.runStore,
    observationService: fixture.observationService,
    taskViewService: fixture.taskViewService,
    messageService: fixture.messageService,
    llmClient
  });
  const assistantModeService = new AssistantModeService({
    conversationStore: fixture.conversationStore,
    assistantSessionStore: fixture.sessionStore,
    assistantRunStore: fixture.runStore,
    observationService: fixture.observationService,
    messageService: fixture.messageService,
    taskViewService: fixture.taskViewService,
    dialogueService
  });
  const chatService = new ChatUiConversationService({
    conversationStore: fixture.conversationStore,
    messageService: fixture.messageService,
    taskStore: fixture.taskStore,
    assistantModeService
  });

  return {
    ...fixture,
    llmClient,
    dialogueService,
    assistantModeService,
    chatService
  };
}

test('Assistant ReAct loop can answer directly in natural language for simple /cligate chat', async () => {
  const service = createAssistantService({
    llmResponses: [{
      text: '我是 CliGate Assistant。我负责理解你的目标，必要时调用工具或委派 Codex/Claude Code 执行。'
    }]
  });

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-direct-1',
    text: '/cligate 你是谁'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /CliGate Assistant/);
  assert.equal(result.assistantRun.status, 'completed');
  assert.equal(result.assistantRun.steps[0]?.kind, 'assistant_turn');
  assert.equal(result.observability?.mode, 'agent');
  assert.equal(result.observability?.resolvedSource?.label, 'fake-llm');
  assert.equal(result.observability?.resolvedSource?.model, 'fake-model');
  assert.equal(result.observability?.stopPolicy?.closure, 'assistant_done');
});

test('Assistant ReAct loop can inspect task state through structured tool calls', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_1',
          name: 'list_tasks',
          input: {
            limit: 1
          }
        }]
      },
      {
        text: '当前没有可见任务，所以还没有运行中的执行链路。'
      }
    ]
  });

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-observe-1',
    text: '/cligate 现在有哪些任务'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /没有可见任务/);
  assert.equal(result.assistantRun.steps[1]?.toolName, 'list_tasks');
  assert.equal(service.llmClient.calls.length, 2);
});

test('Assistant ReAct loop can delegate runtime work and return a natural-language summary', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_delegate_1',
          name: 'delegate_to_codex',
          input: {
            task: 'inspect repo'
          }
        }]
      },
      {
        text: '我已经让 Codex 去检查仓库了。这一轮已经完成，结果显示仓库检查已跑完。'
      }
    ]
  });

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-delegate-1',
    text: '/cligate 帮我检查一下仓库'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /Codex/);
  assert.equal(result.assistantRun.status, 'completed');
  assert.equal(result.assistantRun.relatedRuntimeSessionIds.length, 1);
  assert.ok(result.assistantRun.steps.some((entry) => entry.toolName === 'delegate_to_codex'));
  assert.ok(result.assistantRun.steps.some((entry) => entry.toolName === 'summarize_runtime_result'));
});

test('Assistant dialogue fallback records the underlying LLM failure reason', async () => {
  const service = createAssistantServiceWithLlmClient(new FailingLlmClient());

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-fallback-1',
    text: '/cligate 你是谁'
  });

  assert.equal(result.type, 'assistant_response');
  assert.equal(result.assistantRun.metadata.assistantAgent.mode, 'fallback');
  assert.match(String(result.assistantRun.metadata.assistantAgent.reason || ''), /assistant llm failed/);
  assert.equal(result.assistantRun.metadata.plan.version, 'phase7-fallback-v1');
  assert.match(String(result.message || ''), /回退|fell back/i);
  assert.equal(result.observability?.mode, 'fallback');
  assert.match(String(result.observability?.fallbackReason || ''), /assistant llm failed/);
});

test('Assistant fallback safety rail does not guess free-form requests when the agent path is unavailable', async () => {
  const service = createAssistantServiceWithLlmClient(new DisabledLlmClient());

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-disabled-fallback-1',
    text: '/cligate 你是谁'
  });

  assert.equal(result.type, 'assistant_response');
  assert.equal(result.assistantRun.metadata.assistantAgent.mode, 'fallback');
  assert.equal(result.assistantRun.metadata.assistantAgent.reason, 'assistant_agent_disabled');
  assert.equal(result.assistantRun.metadata.plan.summaryIntent, 'fallback_unhandled');
  assert.match(String(result.message || ''), /当前没有可用的 LLM assistant 主路径|LLM-driven assistant path/i);
});

test('Assistant fallback safety rail still supports explicit control commands', async () => {
  const service = createAssistantServiceWithLlmClient(new DisabledLlmClient());

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-disabled-fallback-2',
    text: '/cligate status'
  });

  assert.equal(result.type, 'assistant_response');
  assert.notEqual(result.assistantRun.metadata.plan.summaryIntent, 'fallback_unhandled');
});

test('Assistant ReAct tool registry supports the task-and-conversation memory alias', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_memory_1',
          name: 'search_task_and_conversation_memory',
          input: {
            query: 'inspect'
          }
        }]
      },
      {
        text: '我已经搜索了现有任务与对话摘要，目前没有更多匹配项。'
      }
    ]
  });

  const result = await service.chatService.routeMessage({
    sessionId: 'assistant-react-memory-alias-1',
    text: '/cligate 搜索一下现有任务摘要'
  });

  assert.equal(result.type, 'assistant_response');
  assert.ok(result.assistantRun.steps.some((entry) => entry.toolName === 'search_task_and_conversation_memory'));
});

test('Assistant ReAct prompt includes task-space-first context', async () => {
  const service = createAssistantService({
    llmResponses: [{
      text: 'There is one waiting task.'
    }]
  });

  const conversation = service.conversationStore.findOrCreateBySessionId('assistant-react-task-space-1', {
    supervisor: {
      taskMemory: {
        activeTaskId: 'task-waiting'
      }
    }
  });
  const waitingSession = await service.runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'need approval'
  });
  service.runtimeSessionManager.getSession(waitingSession.id).status = 'waiting_approval';
  service.supervisorTaskStore.create({
    id: 'task-waiting',
    conversationId: conversation.id,
    title: 'Need approval',
    goal: 'need approval',
    status: 'waiting_approval',
    executorStrategy: 'codex',
    primaryExecutionId: waitingSession.id,
    cwd: 'D:\\projects\\agent',
    cwdBasename: 'agent',
    lastConversationId: conversation.id,
    sourceTaskId: 'task-source-1',
    metadata: {
      latestExecutionId: waitingSession.id,
      originKind: 'related_sibling',
      runtimeSessionId: waitingSession.id,
      provider: 'codex'
    }
  });
  service.observationService.workspaceStore.upsert({
    workspaceRef: 'D:\\projects\\agent',
    patch: {
      name: 'agent',
      aliases: ['agent project', '智能体项目'],
      summary: 'Recent agent workspace',
      taskIds: ['task-waiting'],
      openTaskIds: ['task-waiting'],
      lastTouchedAt: new Date().toISOString()
    }
  });

  const run = service.runStore.create({
    assistantSessionId: 'assistant-session-task-space',
    conversationId: conversation.id,
    triggerText: '/cligate status',
    status: 'running'
  });
  await service.dialogueService.run({
    run,
    conversation,
    text: 'What is waiting?'
  });

  const promptText = String(service.llmClient.calls[0]?.messages?.[0]?.content?.[0]?.text || '');
  assert.match(promptText, /<task_space>/);
  assert.match(promptText, /<recent_tasks>/);
  assert.match(promptText, /<known_cwds>/);
  assert.match(promptText, /<routing_hints>/);
  assert.match(promptText, /<pending_runtime_approval>/);
  assert.match(promptText, /<pending_runtime_question>/);
  assert.match(promptText, /"focusTask"/);
  assert.match(promptText, /"cwd": "D:\\\\projects\\\\agent"/);
  assert.match(promptText, /"cwdBasename": "agent"/);
  assert.match(promptText, /"lastConversationId":/);
  assert.match(promptText, /"aliases": \[/);
  assert.match(promptText, /agent project/);
  assert.match(promptText, /"waitingTasks"/);
  assert.match(promptText, /"focusTaskReason":/);
  assert.match(promptText, /"taskRelationshipSummary":/);
  assert.match(promptText, /"decisionHints":/);
  assert.match(promptText, /"requestType":/);
  assert.match(promptText, /"preferredAction":/);
  assert.match(promptText, /"preferredTaskId":/);
  assert.match(promptText, /"originKind": "related_sibling"/);
  assert.match(promptText, /"sourceTaskId": "task-source-1"/);
  assert.match(promptText, /"latestExecutionId":/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /Use continue_task|优先继续该 task/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /clarification|澄清/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /resolve_runtime_approval/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /answer_runtime_question/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /Decision example|决策示例/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /routingHints|requestType|preferredExecutionTarget/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /originKind|sourceTaskId|latestExecutionId/);
});

test('AssistantLlmClient returns no candidates when no supervisor binding is configured (no silent emergency fallback)', async () => {
  const client = new AssistantLlmClient({ enabled: true });

  client.getRuntimeConfig = () => ({
    enabled: true,
    boundCredential: null,
    fallbacks: [],
    circuitBreaker: { failureThreshold: 3, probeIntervalMs: 300_000 },
    sources: {}
  });

  const candidates = await client.listCandidateSources();
  assert.ok(Array.isArray(candidates));
  assert.equal(candidates.length, 0);

  let resolveError = null;
  try {
    await client.resolveSource();
  } catch (error) {
    resolveError = error;
  }
  assert.ok(resolveError, 'resolveSource should throw when no binding is configured');
  assert.match(String(resolveError.message || ''), /no assistant model source available/i);
});

test('Assistant mode routes pending runtime approval through the LLM tool path', async () => {
  const fixture = createFixture();
  const llmClient = new FakeLlmClient([
    {
      toolCalls: [{
        id: 'tool_approval_1',
        name: 'resolve_runtime_approval',
        input: {
          sessionId: 'session-waiting-approval',
          approvalId: 'approval-1',
          decision: 'approve'
        }
      }]
    },
    {
      text: '我已经批准这个请求。'
    }
  ]);
  const dialogueService = new AssistantDialogueService({
    runStore: fixture.runStore,
    observationService: fixture.observationService,
    taskViewService: fixture.taskViewService,
    messageService: fixture.messageService,
    llmClient
  });
  const assistantModeService = new AssistantModeService({
    conversationStore: fixture.conversationStore,
    assistantSessionStore: fixture.sessionStore,
    assistantRunStore: fixture.runStore,
    observationService: fixture.observationService,
    messageService: fixture.messageService,
    taskViewService: fixture.taskViewService,
    dialogueService
  });
  const chatService = new ChatUiConversationService({
    conversationStore: fixture.conversationStore,
    messageService: fixture.messageService,
    taskStore: fixture.taskStore,
    assistantModeService
  });

  const conversation = fixture.conversationStore.save({
    id: 'conv-waiting-approval',
    channel: 'chat-ui',
    accountId: 'default',
    externalConversationId: 'chat-ui-approval',
    externalUserId: 'local-user',
    title: 'Waiting approval',
    mode: 'assistant',
    activeRuntimeSessionId: null,
    lastPendingApprovalId: 'approval-1',
    lastPendingQuestionId: null,
    metadata: {
      assistantCore: {
        mode: 'assistant'
      }
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  fixture.runtimeSessionManager._saveSession({
    id: 'session-waiting-approval',
    provider: 'claude-code',
    status: 'waiting_approval',
    title: 'Need permission',
    input: 'inspect protected file',
    cwd: '',
    model: '',
    metadata: {},
    turnCount: 1,
    currentTurnId: 'turn-1',
    summary: '',
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastEventSeq: 0
  });
  fixture.runtimeSessionManager.approvalService.createApproval({
    sessionId: 'session-waiting-approval',
    provider: 'claude-code',
    title: 'Need permission',
    summary: 'Run command',
    rawRequest: {
      requestId: 'approval-1'
    },
    turnId: 'turn-1'
  });
  fixture.runtimeSessionManager.turnHandles.set('session-waiting-approval', {
    respondApproval: async () => {}
  });
  fixture.conversationStore.patch(conversation.id, {
    activeRuntimeSessionId: 'session-waiting-approval'
  });

  const result = await chatService.routeMessage({
    sessionId: 'chat-ui-approval',
    text: '同意',
    defaultRuntimeProvider: 'codex'
  });

  assert.equal(result.type, 'assistant_response');
  assert.match(String(result.message || ''), /批准|approve/i);
  assert.equal(llmClient.calls.length, 2);
  assert.equal(
    fixture.runtimeSessionManager.approvalService.getApproval('session-waiting-approval', 'approval-1')?.status,
    'approved'
  );
  assert.equal(result.conversation.lastPendingApprovalId, null);
  const promptText = String(llmClient.calls[0]?.messages?.[0]?.content?.[0]?.text || '');
  assert.match(promptText, /<pending_runtime_approval>/);
  assert.match(promptText, /approval-1/);
  assert.match(String(llmClient.calls[0]?.system || ''), /resolve_runtime_approval/);
});

test('Assistant ReAct prompt includes pending clarification context when present', async () => {
  const service = createAssistantService({
    llmResponses: [{
      text: 'Please clarify which task you mean.'
    }]
  });

  const conversation = service.conversationStore.findOrCreateBySessionId('assistant-react-clarification-prompt-1', {
    assistantCore: {
      mode: 'assistant'
    }
  });
  const clarification = service.observationService.clarificationStore.create({
    conversationId: conversation.id,
    question: 'Which task should I continue?',
    candidates: [
      { kind: 'task', id: 'task-a', label: 'Task A', confidence: 0.9 },
      { kind: 'task', id: 'task-b', label: 'Task B', confidence: 0.7 }
    ]
  });
  service.conversationStore.patch(conversation.id, {
    lastPendingClarificationId: clarification.id
  });

  const run = service.runStore.create({
    assistantSessionId: 'assistant-session-clarification-prompt',
    conversationId: conversation.id,
    triggerText: '/cligate continue',
    status: 'running'
  });
  await service.dialogueService.run({
    run,
    conversation: service.conversationStore.get(conversation.id),
    text: '继续'
  });

  const promptText = String(service.llmClient.calls[0]?.messages?.[0]?.content?.[0]?.text || '');
  assert.match(promptText, /<pending_clarification>/);
  assert.match(promptText, /Which task should I continue\?/);
  assert.match(promptText, /task-a/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /resolve_clarification/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /cancel_pending_clarification/);
});

test('reference resolver returns task and cwd candidates for ambiguous project phrasing', () => {
  const resolution = resolveReferenceContext({
    text: '继续刚才那个 agent 项目',
    taskSpace: {
      focusTask: {
        taskId: 'task-agent',
        title: 'Inspect agent',
        task: {
          title: 'Inspect agent',
          cwd: 'D:\\projects\\agent',
          cwdBasename: 'agent',
          lastConversationId: 'conv-1'
        },
        conversationId: 'conv-1',
        state: 'running'
      },
      recentTasks: [{
        taskId: 'task-agent',
        title: 'Inspect agent',
        task: {
          title: 'Inspect agent',
          cwd: 'D:\\projects\\agent',
          cwdBasename: 'agent',
          lastConversationId: 'conv-1'
        },
        conversationId: 'conv-1',
        state: 'running'
      }]
    },
    workspaceContext: {
      knownCwds: [{
        workspaceRef: 'D:\\projects\\agent',
        name: 'agent',
        aliases: ['agent project']
      }]
    },
    conversationContext: {
      conversation: {
        id: 'conv-1'
      }
    }
  });

  assert.equal(resolution.intent, 'continue');
  assert.ok(Array.isArray(resolution.references));
  assert.ok(resolution.references.length >= 1);
  assert.ok(resolution.references[0].topCandidates.some((entry) => entry.kind === 'task'));
  assert.ok(resolution.references[0].topCandidates.some((entry) => entry.kind === 'cwd'));
  assert.match(String(resolution.references[0]?.confidence || ''), /high|medium|low/);
  assert.match(String(resolution.references[0]?.recommendedAction || ''), /reuse_task|inspect_workspace|ask_user/);
  assert.equal(typeof resolution.references[0]?.shouldAskUser, 'boolean');
  assert.equal(typeof resolution.summary?.shouldAskUser, 'boolean');
});

test('Assistant ReAct prompt includes reference resolution and recent intent timeline blocks', async () => {
  const service = createAssistantService({
    llmResponses: [{
      text: 'I found the likely task reference.'
    }]
  });

  const conversation = service.conversationStore.findOrCreateBySessionId('assistant-react-reference-1', {
    assistantCore: {
      mode: 'assistant'
    }
  });
  service.deliveryStore.saveInbound({
    conversationId: conversation.id,
    sessionId: '',
    payload: {
      text: '继续刚才那个 agent 项目'
    }
  });
  service.supervisorTaskStore.create({
    id: 'task-reference-1',
    conversationId: conversation.id,
    title: 'Inspect agent',
    goal: 'Inspect agent',
    status: 'running',
    cwd: 'D:\\projects\\agent',
    cwdBasename: 'agent',
    lastConversationId: conversation.id,
    metadata: {
      provider: 'codex',
      runtimeSessionId: 'session-reference-1',
      latestExecutionId: 'session-reference-1'
    }
  });
  service.observationService.workspaceStore.upsert({
    workspaceRef: 'D:\\projects\\agent',
    patch: {
      aliases: ['agent project']
    }
  });

  const run = service.runStore.create({
    assistantSessionId: 'assistant-session-reference',
    conversationId: conversation.id,
    triggerText: '/cligate continue agent',
    status: 'running'
  });
  await service.dialogueService.run({
    run,
    conversation,
    text: '继续刚才那个 agent 项目'
  });

  const promptText = String(service.llmClient.calls[0]?.messages?.[0]?.content?.[0]?.text || '');
  assert.match(promptText, /<reference_resolution>/);
  assert.match(promptText, /<recent_intent_timeline>/);
  assert.match(promptText, /"phrase":/);
  assert.match(promptText, /"recommendedAction":/);
  assert.match(promptText, /"confidence":/);
  assert.match(promptText, /"shouldAskUser":/);
  assert.match(promptText, /"preferredReferenceAction":/);
  assert.match(promptText, /"preferredReferenceTaskId":/);
  assert.match(promptText, /"referenceConfidence":/);
  assert.match(promptText, /"topCandidates":/);
  assert.match(promptText, /"kind": "task"/);
  assert.match(promptText, /"kind": "cwd"/);
  assert.match(promptText, /agent project/);
});

test('Assistant ReAct prompt includes user profile when global preferences exist', async () => {
  const service = createAssistantService({
    llmResponses: [{
      text: 'I will follow your saved preferences.'
    }]
  });

  service.observationService.memoryService.preferenceStore.upsertPreference({
    scope: 'global_user',
    scopeRef: 'default-user',
    key: 'reply_language',
    value: 'zh-CN'
  });
  service.observationService.memoryService.preferenceStore.upsertPreference({
    scope: 'global_user',
    scopeRef: 'default-user',
    key: 'preferred_runtime_provider',
    value: 'claude-code'
  });

  const conversation = service.conversationStore.findOrCreateBySessionId('assistant-react-user-profile-1', {
    assistantCore: {
      mode: 'assistant'
    }
  });
  const run = service.runStore.create({
    assistantSessionId: 'assistant-session-user-profile',
    conversationId: conversation.id,
    triggerText: '/cligate preferences',
    status: 'running'
  });
  await service.dialogueService.run({
    run,
    conversation,
    text: '继续'
  });

  const promptText = String(service.llmClient.calls[0]?.messages?.[0]?.content?.[0]?.text || '');
  assert.match(promptText, /<user_profile>/);
  assert.match(promptText, /"replyLanguage": "zh-CN"/);
  assert.match(promptText, /"preferredRuntimeProvider": "claude-code"/);
});

test('Assistant ReAct can continue a task by task id instead of activeRuntimeSessionId', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_continue_task_1',
          name: 'continue_task',
          input: {
            taskId: 'task-target',
            message: 'please continue target task'
          }
        }]
      },
      {
        text: 'I continued the target task.'
      }
    ]
  });

  const targetSession = await service.runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'target task'
  });
  const otherSession = await service.runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'other task'
  });
  const conversation = service.conversationStore.findOrCreateBySessionId('assistant-react-continue-task-1', {
    supervisor: {
      taskMemory: {
        activeTaskId: 'task-target'
      }
    }
  });
  service.conversationStore.bindRuntimeSession(conversation.id, otherSession.id, {
    metadata: {
      ...(conversation.metadata || {}),
      supervisor: {
        ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
          ? conversation.metadata.supervisor
          : {}),
        taskMemory: {
          activeTaskId: 'task-target'
        }
      }
    }
  });
  service.supervisorTaskStore.create({
    id: 'task-target',
    conversationId: conversation.id,
    title: 'Target task',
    goal: 'target task',
    status: 'completed',
    executorStrategy: 'codex',
    primaryExecutionId: targetSession.id,
    metadata: {
      runtimeSessionId: targetSession.id,
      provider: 'codex'
    }
  });

  const run = service.runStore.create({
    assistantSessionId: 'assistant-session-continue-task',
    conversationId: conversation.id,
    triggerText: '/cligate continue target',
    status: 'running'
  });
  const result = await service.dialogueService.run({
    run,
    conversation,
    text: 'Continue the target task'
  });

  const targetTurns = service.runtimeSessionManager.listTurns(targetSession.id, { limit: 10 });
  const otherTurns = service.runtimeSessionManager.listTurns(otherSession.id, { limit: 10 });
  assert.equal(targetTurns[0]?.input, 'please continue target task');
  assert.notEqual(otherTurns[0]?.input, 'please continue target task');
});

test('Assistant reflection summarizes continue_task results when the runtime turn finishes', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_continue_task_2',
          name: 'continue_task',
          input: {
            taskId: 'task-target-2',
            message: 'continue and summarize'
          }
        }]
      },
      {
        text: 'Target task continued and I summarized the result.'
      }
    ]
  });

  const targetSession = await service.runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'target task 2'
  });
  const conversation = service.conversationStore.findOrCreateBySessionId('assistant-react-continue-task-2', {
    supervisor: {
      taskMemory: {
        activeTaskId: 'task-target-2'
      }
    }
  });
  service.supervisorTaskStore.create({
    id: 'task-target-2',
    conversationId: conversation.id,
    title: 'Target task 2',
    goal: 'target task 2',
    status: 'completed',
    executorStrategy: 'codex',
    primaryExecutionId: targetSession.id,
    metadata: {
      runtimeSessionId: targetSession.id,
      provider: 'codex'
    }
  });

  const run = service.runStore.create({
    assistantSessionId: 'assistant-session-continue-task-2',
    conversationId: conversation.id,
    triggerText: '/cligate continue target 2',
    status: 'running'
  });
  const result = await service.dialogueService.run({
    run,
    conversation,
    text: 'Continue task 2'
  });

  assert.ok(result.run.steps.some((entry) => entry.toolName === 'continue_task'));
  assert.ok(result.run.steps.some((entry) => entry.toolName === 'summarize_runtime_result'));
});

test('Assistant can start a secondary execution for the current supervisor task', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [{
          id: 'tool_delegate_secondary_1',
          name: 'delegate_task_execution',
          input: {
            taskId: 'task-secondary',
            provider: 'claude-code',
            role: 'secondary',
            task: 'review the current task'
          }
        }]
      },
      {
        text: 'I started a secondary execution for the current task.'
      }
    ]
  });

  const primary = await service.messageService.startRuntimeTask({
    provider: 'codex',
    input: 'build login page',
    metadata: {
      taskId: 'task-secondary',
      conversationId: 'conv-secondary'
    }
  });
  service.supervisorTaskStore.upsertForRuntime({
    taskId: 'task-secondary',
    conversationId: 'conv-secondary',
    runtimeSessionId: primary.id,
    provider: 'codex',
    title: 'build login page',
    goal: 'build login page',
    status: 'completed'
  });
  const conversation = service.conversationStore.findOrCreateBySessionId('assistant-react-secondary-execution-1', {
    supervisor: {
      taskMemory: {
        activeTaskId: 'task-secondary',
        byTask: {
          task_secondary: {
            taskId: 'task-secondary',
            sessionId: primary.id,
            provider: 'codex',
            title: 'build login page',
            status: 'completed'
          }
        }
      }
    }
  });

  const run = service.runStore.create({
    assistantSessionId: 'assistant-session-secondary-execution',
    conversationId: conversation.id,
    triggerText: '/cligate review this task with claude',
    status: 'running'
  });
  const result = await service.dialogueService.run({
    run,
    conversation,
    text: 'Review this task with claude'
  });

  const task = service.supervisorTaskStore.get('task-secondary');
  assert.ok(result.run.steps.some((entry) => entry.toolName === 'delegate_task_execution'));
  assert.equal(task.primaryExecutionId, primary.id);
  assert.equal(task.executionIds.length, 2);
});

test('Assistant tool definitions distinguish continue-task vs fresh delegation intent', () => {
  const service = createFixture();
  const registry = createDefaultAssistantToolRegistry({
    observationService: service.observationService,
    messageService: service.messageService,
    taskViewService: service.taskViewService
  });
  const tools = buildAnthropicToolDefinitions(registry);
  const continueTask = tools.find((entry) => entry.name === 'continue_task');
  const delegateRuntime = tools.find((entry) => entry.name === 'delegate_to_runtime');
  const delegateTaskExecution = tools.find((entry) => entry.name === 'delegate_task_execution');
  const taskSpace = tools.find((entry) => entry.name === 'get_conversation_task_space');
  const cwdInfo = tools.find((entry) => entry.name === 'get_cwd_info');
  const addCwdAlias = tools.find((entry) => entry.name === 'add_cwd_alias');
  const linkTask = tools.find((entry) => entry.name === 'link_task_to_conversation');
  const recall = tools.find((entry) => entry.name === 'recall');
  const resolveReference = tools.find((entry) => entry.name === 'resolve_reference');

  assert.match(String(continueTask?.description || ''), /preferred tool|优先/);
  assert.match(String(delegateRuntime?.description || ''), /brand-new|new runtime|新/);
  assert.match(String(delegateTaskExecution?.description || ''), /task identity|task|execution/i);
  assert.match(String(taskSpace?.description || ''), /before deciding|优先|Prefer this/);
  assert.match(String(cwdInfo?.description || ''), /cwd|project path|known cwd/i);
  assert.match(String(addCwdAlias?.description || ''), /alias/i);
  assert.match(String(linkTask?.description || ''), /current conversation|take over|接管/i);
  assert.match(String(recall?.description || ''), /historical|earlier|过去|历史/i);
  assert.match(String(resolveReference?.description || ''), /Resolve a phrase|引用消解|candidates/i);
});

test('Assistant async background fan-in waits for codex and claude-code before notifying', async () => {
  const service = createAssistantService({
    llmResponses: [
      {
        toolCalls: [
          {
            id: 'tool_delegate_cx',
            name: 'delegate_to_codex',
            input: {
              task: 'remove welcome text'
            }
          },
          {
            id: 'tool_delegate_cc',
            name: 'delegate_to_claude_code',
            input: {
              task: 'summarize skills repo'
            }
          }
        ]
      },
      {
        text: '我已经同时发起两个并行任务，等它们都完成后统一汇总。'
      }
    ]
  });

  let backgroundResult = null;
  const accepted = await service.chatService.routeMessage({
    sessionId: 'assistant-react-fanin-1',
    text: '/cligate 同时发起 codex 和 claude-code',
    assistantExecutionMode: 'async',
    onBackgroundResult: async (result) => {
      backgroundResult = result;
    }
  });

  assert.equal(accepted.type, 'assistant_run_accepted');

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.ok(backgroundResult);
  assert.equal(backgroundResult.assistantRun.status, 'completed');
  assert.equal(backgroundResult.assistantRun.relatedRuntimeSessionIds.length, 2);
  assert.match(String(backgroundResult.message || ''), /并发任务已全部结束|All parallel runtime tasks finished/);
  assert.match(String(backgroundResult.message || ''), /Codex/);
  assert.match(String(backgroundResult.message || ''), /Claude Code/);
});
