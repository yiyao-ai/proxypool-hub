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
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';
import { TaskExecutionService } from '../../src/agent-orchestrator/task-execution-service.js';
import { AgentOrchestratorMessageService } from '../../src/agent-orchestrator/message-service.js';
import { AssistantWorkspaceStore } from '../../src/assistant-core/workspace-store.js';

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
    return { pid: 3001 };
  }
}

class FakeClaudeProvider extends FakeProvider {
  constructor() {
    super();
    this.id = 'claude-code';
  }
}

function createFixture() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeClaudeProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-task-execution-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-task-execution-policy-')
    })
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-task-execution-supervisor-')
  });
  const workspaceStore = new AssistantWorkspaceStore({
    configDir: createTempDir('cligate-task-execution-workspace-')
  });
  const taskExecutionService = new TaskExecutionService({
    runtimeSessionManager,
    supervisorTaskStore,
    workspaceStore
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    supervisorTaskStore,
    taskExecutionService
  });

  return {
    runtimeSessionManager,
    supervisorTaskStore,
    workspaceStore,
    taskExecutionService,
    messageService
  };
}

test('TaskExecutionService starts a fresh execution and binds it to the supervisor task', async () => {
  const { taskExecutionService, supervisorTaskStore, workspaceStore } = createFixture();

  const session = await taskExecutionService.startTaskExecution({
    taskId: 'task-alpha',
    conversationId: 'conv-alpha',
    provider: 'codex',
    input: 'inspect repo',
    cwd: 'd:\\repo-a\\'
  });

  const task = supervisorTaskStore.get('task-alpha');
  const workspace = workspaceStore.getByRef('D:\\repo-a');
  assert.ok(session.id);
  assert.equal(session.execution.executionId, session.id);
  assert.equal(session.execution.runtimeSessionId, session.id);
  assert.equal(session.execution.role, 'primary');
  assert.equal(task.id, 'task-alpha');
  assert.equal(task.conversationId, 'conv-alpha');
  assert.equal(task.primaryExecutionId, session.id);
  assert.ok(task.executionIds.includes(session.id));
  assert.equal(task.metadata.latestExecutionId, session.id);
  assert.equal(task.metadata.executionKind, 'runtime_session');
  assert.equal(task.cwd, 'd:\\repo-a\\');
  assert.equal(task.cwdBasename, 'repo-a');
  assert.equal(task.workspaceId, workspace?.id);
  assert.equal(task.metadata.workspaceId, workspace?.id);
  assert.ok(workspace?.taskIds.includes('task-alpha'));
  assert.ok(workspace?.openTaskIds.includes('task-alpha'));
});

test('AgentOrchestratorMessageService continues a task through its primary execution', async () => {
  const { messageService, supervisorTaskStore, runtimeSessionManager } = createFixture();

  const started = await messageService.startRuntimeTask({
    provider: 'codex',
    input: 'initial task work',
    metadata: {
      taskId: 'task-beta',
      conversationId: 'conv-beta'
    }
  });
  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-beta',
    conversationId: 'conv-beta',
    runtimeSessionId: started.id,
    provider: 'codex',
    title: 'Task beta',
    goal: 'initial task work',
    status: 'completed'
  });

  const continued = await messageService.continueRuntimeTask({
    taskId: 'task-beta',
    input: 'follow up on task beta'
  });

  const turns = runtimeSessionManager.listTurns(started.id, { limit: 10 });
  assert.equal(continued.id, started.id);
  assert.equal(continued.execution.executionId, started.id);
  assert.equal(continued.execution.runtimeSessionId, started.id);
  assert.equal(turns[0]?.input, 'follow up on task beta');
});

test('AgentOrchestratorMessageService routes natural-language continue phrasing through the task primary execution', async () => {
  const { messageService, supervisorTaskStore, runtimeSessionManager } = createFixture();

  const primary = await messageService.startRuntimeTask({
    provider: 'codex',
    input: 'initial task work',
    metadata: {
      taskId: 'task-natural-followup',
      conversationId: 'conv-natural-followup'
    }
  });

  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-natural-followup',
    conversationId: 'conv-natural-followup',
    runtimeSessionId: primary.id,
    provider: 'codex',
    title: 'Natural follow-up task',
    goal: 'initial task work',
    status: 'completed'
  });

  const result = await messageService.routeUserMessage({
    message: { text: '继续刚才那个' },
    conversation: {
      id: 'conv-natural-followup',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-natural-followup',
            byTask: {
              'task-natural-followup': {
                taskId: 'task-natural-followup',
                sessionId: primary.id,
                provider: 'codex',
                title: 'Natural follow-up task',
                status: 'completed'
              }
            }
          }
        }
      }
    }
  });

  const turns = runtimeSessionManager.listTurns(primary.id, { limit: 10 });
  assert.equal(result.type, 'runtime_continued');
  assert.equal(result.session.id, primary.id);
  assert.equal(turns[0]?.input, '继续刚才那个');
});

test('TaskExecutionService can add a secondary execution without overriding the primary execution', async () => {
  const { taskExecutionService, supervisorTaskStore } = createFixture();

  const primary = await taskExecutionService.startTaskExecution({
    taskId: 'task-gamma',
    conversationId: 'conv-gamma',
    provider: 'codex',
    input: 'implement feature',
    role: 'primary'
  });
  const secondary = await taskExecutionService.startTaskExecution({
    taskId: 'task-gamma',
    conversationId: 'conv-gamma',
    provider: 'codex',
    input: 'review feature',
    role: 'secondary'
  });

  const task = supervisorTaskStore.get('task-gamma');
  assert.equal(task.primaryExecutionId, primary.id);
  assert.ok(task.executionIds.includes(primary.id));
  assert.ok(task.executionIds.includes(secondary.id));
  assert.equal(task.executionIds.length, 2);
  assert.equal(secondary.execution.role, 'secondary');
  assert.equal(task.metadata.latestExecutionId, secondary.id);
});

test('AgentOrchestratorMessageService answers natural-language status through supervisor status instead of starting a new runtime', async () => {
  const { messageService } = createFixture();

  const result = await messageService.routeUserMessage({
    message: { text: '进展如何' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'current',
            taskId: 'task-status-1',
            title: 'Polish login page',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'running',
            summary: 'Implementing the login form polish.',
            result: '',
            error: '',
            waitingReason: '',
            nextSuggestion: 'Ask for the latest result or continue the task.'
          }
        }
      }
    }
  });

  assert.equal(result.type, 'supervisor_status');
  assert.match(String(result.message || ''), /Polish login page/);
  assert.match(String(result.message || ''), /running/i);
});

test('AgentOrchestratorMessageService returns multi-task supervisor status overview for natural-language progress queries', async () => {
  const { messageService } = createFixture();

  const result = await messageService.routeUserMessage({
    message: { text: '进展如何' },
    conversation: {
      id: 'conv-multi-status',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-a',
            byTask: {
              'task-a': {
                taskId: 'task-a',
                sessionId: 'session-a',
                provider: 'codex',
                title: 'Build dashboard',
                status: 'running',
                summary: 'Implementing dashboard widgets.'
              },
              'task-b': {
                taskId: 'task-b',
                sessionId: 'session-b',
                provider: 'claude-code',
                title: 'Review API',
                status: 'waiting_user',
                pendingQuestion: 'Need database schema'
              }
            }
          }
        }
      }
    }
  });

  assert.equal(result.type, 'supervisor_status');
  assert.match(String(result.message || ''), /2 active task\(s\)/i);
  assert.match(String(result.message || ''), /Build dashboard/);
  assert.match(String(result.message || ''), /Review API/);
});

test('AgentOrchestratorMessageService chooses the current task for descriptive multi-task follow-up instead of asking for clarification', async () => {
  const { messageService, runtimeSessionManager, supervisorTaskStore } = createFixture();

  const primary = await messageService.startRuntimeTask({
    provider: 'codex',
    input: 'build dashboard',
    metadata: {
      taskId: 'task-a',
      conversationId: 'conv-smart-followup'
    }
  });
  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-a',
    conversationId: 'conv-smart-followup',
    runtimeSessionId: primary.id,
    provider: 'codex',
    title: 'Build dashboard',
    goal: 'build dashboard',
    status: 'running'
  });
  supervisorTaskStore.create({
    id: 'task-b',
    conversationId: 'conv-smart-followup',
    title: 'Review API',
    goal: 'review api',
    status: 'running',
    executorStrategy: 'claude-code',
    primaryExecutionId: 'session-b',
    metadata: {
      runtimeSessionId: 'session-b',
      provider: 'claude-code'
    }
  });

  const result = await messageService.routeUserMessage({
    message: { text: '把仪表盘改成两列布局' },
    conversation: {
      id: 'conv-smart-followup',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-a',
            byTask: {
              'task-a': {
                taskId: 'task-a',
                sessionId: primary.id,
                provider: 'codex',
                title: 'Build dashboard',
                status: 'running',
                summary: 'Implement dashboard widgets.'
              },
              'task-b': {
                taskId: 'task-b',
                sessionId: 'session-b',
                provider: 'claude-code',
                title: 'Review API',
                status: 'running',
                summary: 'Review authentication endpoints.'
              }
            }
          }
        }
      }
    }
  });

  const turns = runtimeSessionManager.listTurns(primary.id, { limit: 10 });
  assert.equal(result.type, 'runtime_continued');
  assert.equal(result.session.id, primary.id);
  assert.equal(turns[0]?.input, '把仪表盘改成两列布局');
});

test('AgentOrchestratorMessageService reuses remembered task identity for retry phrasing while starting a fresh execution', async () => {
  const { messageService, supervisorTaskStore } = createFixture();

  const result = await messageService.routeUserMessage({
    message: { text: '重试刚才那个' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'last_failed',
            taskId: 'task-retry',
            title: 'Polish login page',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'failed',
            summary: '',
            result: '',
            error: 'Write was blocked.',
            waitingReason: '',
            nextSuggestion: 'You can retry this task.'
          }
        }
      }
    },
    defaultRuntimeProvider: 'claude-code'
  });

  const task = supervisorTaskStore.get('task-retry');
  assert.equal(result.type, 'runtime_started');
  assert.equal(result.startedFresh, true);
  assert.equal(result.session.execution.taskId, 'task-retry');
  assert.equal(task.id, 'task-retry');
  assert.equal(task.metadata.originKind, 'retry_task');
  assert.match(String(result.message || ''), /Retrying remembered task/i);
});

test('AgentOrchestratorMessageService starts a related sibling task with source-task memory but fresh task identity', async () => {
  const { messageService, supervisorTaskStore } = createFixture();

  const result = await messageService.routeUserMessage({
    message: { text: '基于刚才那个再做一个：注册页' },
    conversation: {
      metadata: {
        supervisor: {
          brief: {
            kind: 'last_completed',
            taskId: 'task-source',
            title: 'Create a login page',
            provider: 'codex',
            providerLabel: 'Codex',
            status: 'completed',
            summary: 'The login page is finished.',
            result: 'index.html is ready.',
            error: '',
            waitingReason: '',
            nextSuggestion: 'You can ask for a revision, a follow-up change, or start a related task.'
          }
        }
      }
    },
    defaultRuntimeProvider: 'claude-code'
  });

  const freshTask = supervisorTaskStore.findByRuntimeSessionId(result.session.id);
  assert.equal(result.type, 'runtime_started');
  assert.equal(result.startedFresh, true);
  assert.notEqual(freshTask?.id, 'task-source');
  assert.equal(freshTask?.sourceTaskId, 'task-source');
  assert.equal(freshTask?.metadata?.originKind, 'related_sibling');
  assert.match(String(result.message || ''), /related task/i);
});

test('AgentOrchestratorMessageService routes alternate-task phrasing through an existing runtime follow-up path', async () => {
  const { messageService, runtimeSessionManager, supervisorTaskStore } = createFixture();

  const primary = await messageService.startRuntimeTask({
    provider: 'codex',
    input: 'build qq page',
    metadata: {
      taskId: 'task-qq',
      conversationId: 'conv-alt-task'
    }
  });
  const alternate = await messageService.startRuntimeTask({
    provider: 'claude-code',
    input: 'build x page',
    metadata: {
      taskId: 'task-x',
      conversationId: 'conv-alt-task'
    }
  });

  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-qq',
    conversationId: 'conv-alt-task',
    runtimeSessionId: primary.id,
    provider: 'codex',
    title: 'Build QQ page',
    goal: 'build qq page',
    status: 'completed'
  });
  supervisorTaskStore.upsertForRuntime({
    taskId: 'task-x',
    conversationId: 'conv-alt-task',
    runtimeSessionId: alternate.id,
    provider: 'claude-code',
    title: 'Build X page',
    goal: 'build x page',
    status: 'waiting_approval'
  });
  runtimeSessionManager.patchSession(alternate.id, {
    status: 'waiting_approval'
  });

  const result = await messageService.routeUserMessage({
    message: { text: '我的另外一个任务呢，执行的咋样了' },
    conversation: {
      id: 'conv-alt-task',
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-qq',
            byTask: {
              'task-qq': {
                taskId: 'task-qq',
                sessionId: primary.id,
                provider: 'codex',
                title: 'Build QQ page',
                status: 'completed'
              },
              'task-x': {
                taskId: 'task-x',
                sessionId: alternate.id,
                provider: 'claude-code',
                title: 'Build X page',
                status: 'waiting_approval',
                pendingApprovalTitle: 'Claude Code wants to use Write'
              }
            }
          }
        }
      }
    }
  });

  assert.equal(result.type, 'runtime_continued');
  assert.ok([primary.id, alternate.id].includes(result.session.id));
  const turns = runtimeSessionManager.listTurns(result.session.id, { limit: 10 });
  assert.equal(turns[0]?.input, '我的另外一个任务呢，执行的咋样了');
});

test('continueTaskExecution falls back to a new session when the primary execution record is gone', async () => {
  const { taskExecutionService, supervisorTaskStore, runtimeSessionManager } = createFixture();

  const session = await taskExecutionService.startTaskExecution({
    taskId: 'task-fallback-missing',
    conversationId: 'conv-fallback-missing',
    provider: 'codex',
    input: 'first round',
    cwd: 'D:\\fallback'
  });

  const persistedTask = supervisorTaskStore.get('task-fallback-missing');
  // 给 task 写一个 summary 模拟"上次跑完了"
  supervisorTaskStore.save({
    ...persistedTask,
    summary: '已完成第一轮分析：项目主入口在 main.py'
  });
  // 模拟 codex thread 丢失：把 runtime session 记录直接抹掉，但保留 supervisor task
  runtimeSessionManager.sessions.delete(session.id);

  const result = await taskExecutionService.continueTaskExecution({
    taskId: 'task-fallback-missing',
    input: '继续看看下一个'
  });

  const updatedTask = supervisorTaskStore.get('task-fallback-missing');
  assert.notEqual(result.id, session.id);
  assert.equal(result.execution.role, 'fallback');
  assert.equal(result.execution.taskId, 'task-fallback-missing');
  // 原 primary 不变；新 session 进入 executionIds
  assert.equal(updatedTask.primaryExecutionId, persistedTask.primaryExecutionId);
  assert.ok(updatedTask.executionIds.includes(result.id));
  // 第一轮 input 带 prior outcome 前缀
  const newTurns = runtimeSessionManager.listTurns(result.id, { limit: 5 });
  const firstInput = String(newTurns[0]?.input || '');
  assert.match(firstInput, /Resuming task/);
  assert.match(firstInput, /Current request:/);
  assert.match(firstInput, /继续看看下一个/);
});

test('continueTaskExecution falls back when the primary execution session is cancelled', async () => {
  const { taskExecutionService, supervisorTaskStore, runtimeSessionManager } = createFixture();

  const session = await taskExecutionService.startTaskExecution({
    taskId: 'task-fallback-cancelled',
    conversationId: 'conv-fallback-cancelled',
    provider: 'codex',
    input: 'first round',
    cwd: 'D:\\fallback-cancelled'
  });

  // 标记 session 为 cancelled
  runtimeSessionManager.cancelSession(session.id);

  const result = await taskExecutionService.continueTaskExecution({
    taskId: 'task-fallback-cancelled',
    input: '换个角度再来一次'
  });

  const updatedTask = supervisorTaskStore.get('task-fallback-cancelled');
  assert.notEqual(result.id, session.id);
  assert.equal(result.execution.role, 'fallback');
  assert.ok(updatedTask.executionIds.includes(result.id));
  assert.ok(updatedTask.executionIds.includes(session.id));
});

test('continueTaskExecution propagates non-fallback errors instead of silently spawning new session', async () => {
  const { taskExecutionService } = createFixture();

  await taskExecutionService.startTaskExecution({
    taskId: 'task-fallback-running',
    conversationId: 'conv-fallback-running',
    provider: 'codex',
    input: 'first round',
    cwd: 'D:\\fallback-running'
  });

  // 传一个空 input 触发 'input is required'（来自 sendInput），该错误不应被 fallback 吞掉。
  await assert.rejects(
    () => taskExecutionService.continueTaskExecution({
      taskId: 'task-fallback-running',
      input: ''
    }),
    /input is required/i
  );
});
