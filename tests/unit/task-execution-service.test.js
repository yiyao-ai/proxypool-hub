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

function createFixture() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
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
  const taskExecutionService = new TaskExecutionService({
    runtimeSessionManager,
    supervisorTaskStore
  });
  const messageService = new AgentOrchestratorMessageService({
    runtimeSessionManager,
    supervisorTaskStore,
    taskExecutionService
  });

  return {
    runtimeSessionManager,
    supervisorTaskStore,
    taskExecutionService,
    messageService
  };
}

test('TaskExecutionService starts a fresh execution and binds it to the supervisor task', async () => {
  const { taskExecutionService, supervisorTaskStore } = createFixture();

  const session = await taskExecutionService.startTaskExecution({
    taskId: 'task-alpha',
    conversationId: 'conv-alpha',
    provider: 'codex',
    input: 'inspect repo'
  });

  const task = supervisorTaskStore.get('task-alpha');
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
