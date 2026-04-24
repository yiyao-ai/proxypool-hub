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
    metadata: {
      runtimeSessionId: waitingSession.id,
      provider: 'codex'
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
  assert.match(promptText, /"focusTask"/);
  assert.match(promptText, /"waitingTasks"/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /Use continue_task|优先继续该 task/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /clarification|澄清/);
  assert.match(String(service.llmClient.calls[0]?.system || ''), /Decision example|决策示例/);
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

  assert.match(String(continueTask?.description || ''), /preferred tool|优先/);
  assert.match(String(delegateRuntime?.description || ''), /brand-new|new runtime|新/);
  assert.match(String(delegateTaskExecution?.description || ''), /task identity|task|execution/i);
  assert.match(String(taskSpace?.description || ''), /before deciding|优先|Prefer this/);
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
