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
import { createChannelConversation } from '../../src/agent-channels/models.js';
import { syncSupervisorTaskForRuntimeEvent, syncSupervisorTaskForRuntimeStart } from '../../src/agent-orchestrator/supervisor-task-sync.js';
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';
import { TaskExecutionService } from '../../src/agent-orchestrator/task-execution-service.js';
import { AssistantWorkspaceStore, normalizeWorkspaceRef } from '../../src/assistant-core/workspace-store.js';
import { AssistantReflectionStore } from '../../src/assistant-core/reflection-store.js';
import { AssistantReflectionService } from '../../src/assistant-agent/reflection-service.js';

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
    return { pid: 4242 };
  }
}

function createFixture() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-supervisor-sync-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-supervisor-sync-policy-')
    })
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-supervisor-sync-store-')
  });
  const workspaceStore = new AssistantWorkspaceStore({
    configDir: createTempDir('cligate-supervisor-sync-workspace-')
  });
  const reflectionStore = new AssistantReflectionStore({
    configDir: createTempDir('cligate-supervisor-sync-reflection-')
  });
  const reflectionService = new AssistantReflectionService({
    reflectionStore
  });
  const taskExecutionService = new TaskExecutionService({
    runtimeSessionManager,
    supervisorTaskStore,
    workspaceStore
  });

  return {
    runtimeSessionManager,
    supervisorTaskStore,
    workspaceStore,
    reflectionStore,
    reflectionService,
    taskExecutionService
  };
}

test('normalizeWorkspaceRef applies minimal cwd normalization without collapsing nested paths', () => {
  assert.equal(normalizeWorkspaceRef('d:\\projects\\agent\\'), 'D:\\projects\\agent');
  assert.equal(normalizeWorkspaceRef('D:\\projects\\agent\\src\\worker\\'), 'D:\\projects\\agent\\src\\worker');
  assert.notEqual(
    normalizeWorkspaceRef('D:\\projects\\agent'),
    normalizeWorkspaceRef('D:\\projects\\agent\\src\\worker')
  );
});

test('TaskExecutionService writes the resolved supervisor task id into runtime session metadata', async () => {
  const { runtimeSessionManager, supervisorTaskStore, taskExecutionService, workspaceStore } = createFixture();

  const session = await taskExecutionService.startTaskExecution({
    conversationId: 'conv-supervisor-sync-1',
    provider: 'codex',
    input: 'inspect repo',
    cwd: 'd:\\projects\\agent\\'
  });

  const persistedSession = runtimeSessionManager.getSession(session.id);
  const supervisorTask = supervisorTaskStore.findByRuntimeSessionId(session.id);
  const workspace = workspaceStore.getByRef('D:\\projects\\agent');

  assert.ok(supervisorTask?.id);
  assert.equal(persistedSession?.metadata?.taskId, supervisorTask.id);
  assert.equal(persistedSession?.metadata?.workspaceId, workspace?.id);
  assert.equal(supervisorTask?.primaryExecutionId, session.id);
  assert.equal(supervisorTask?.cwd, 'd:\\projects\\agent\\');
  assert.equal(supervisorTask?.cwdBasename, 'agent');
  assert.equal(supervisorTask?.workspaceId, workspace?.id);
  assert.ok(workspace?.taskIds.includes(supervisorTask.id));
  assert.ok(workspace?.openTaskIds.includes(supervisorTask.id));
});

test('runtime event sync does not merge a new session into the conversation activeTaskId', async () => {
  const { runtimeSessionManager, supervisorTaskStore, workspaceStore } = createFixture();

  const oldTask = supervisorTaskStore.create({
    id: 'task-old',
    conversationId: 'conv-supervisor-sync-2',
    title: 'Old task',
    goal: 'old task',
    status: 'completed',
    executorStrategy: 'codex',
    primaryExecutionId: 'session-old',
    executionIds: ['session-old'],
    metadata: {
      runtimeSessionId: 'session-old',
      latestExecutionId: 'session-old',
      provider: 'codex'
    }
  });

  const conversation = createChannelConversation({
    channel: 'dingtalk',
    accountId: 'default',
    externalConversationId: 'cid-supervisor-sync-2',
    externalUserId: 'user-supervisor-sync-2',
    title: 'Supervisor sync test',
    metadata: {
      supervisor: {
        taskMemory: {
          activeTaskId: oldTask.id,
          byTask: {
            [oldTask.id]: {
              taskId: oldTask.id,
              sessionId: 'session-old',
              provider: 'codex',
              title: 'Old task',
              status: 'completed'
            }
          }
        }
      }
    }
  });
  conversation.id = 'conv-supervisor-sync-2';

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'new task',
    metadata: {
      conversationId: conversation.id
    }
  });

  const seeded = syncSupervisorTaskForRuntimeStart({
    conversation,
    session: {
      ...session,
      metadata: {
        ...(session.metadata || {}),
        taskId: 'task-new'
      }
    },
    taskMemory: conversation.metadata?.supervisor?.taskMemory || null,
    userInput: 'new task',
    store: supervisorTaskStore,
    workspaceStore
  });

  const startedEvent = runtimeSessionManager.getEvents(session.id, { afterSeq: 0, limit: 5 })
    .find((entry) => entry.type === AGENT_EVENT_TYPE.STARTED);

  const synced = syncSupervisorTaskForRuntimeEvent({
    conversation: {
      ...conversation,
      metadata: {
        ...(conversation.metadata || {}),
        supervisor: {
          ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
            ? conversation.metadata.supervisor
            : {}),
          taskMemory: seeded.taskMemory
        }
      }
    },
    session: {
      ...session,
      metadata: {
        ...(session.metadata || {}),
        taskId: 'task-new'
      }
    },
    event: startedEvent,
    taskMemory: seeded.taskMemory,
    store: supervisorTaskStore,
    workspaceStore
  });

  const newTask = supervisorTaskStore.get('task-new');
  const unchangedOldTask = supervisorTaskStore.get(oldTask.id);

  assert.equal(newTask?.id, 'task-new');
  assert.equal(newTask?.primaryExecutionId, session.id);
  assert.deepEqual(newTask?.executionIds, [session.id]);
  assert.deepEqual(unchangedOldTask?.executionIds, ['session-old']);
  assert.equal(synced.taskMemory?.activeTaskId, 'task-new');
  assert.equal(workspaceStore.list({ limit: 10 }).length, 1);
  assert.ok(workspaceStore.list({ limit: 10 })[0]?.taskIds.includes('task-new'));
});

test('runtime terminal sync removes completed task from workspace openTaskIds', async () => {
  const {
    runtimeSessionManager,
    supervisorTaskStore,
    taskExecutionService,
    workspaceStore,
    reflectionStore,
    reflectionService
  } = createFixture();

  const session = await taskExecutionService.startTaskExecution({
    taskId: 'task-terminal-workspace',
    conversationId: 'conv-terminal-workspace',
    provider: 'codex',
    input: 'inspect repo',
    cwd: 'D:\\projects\\agent'
  });

  runtimeSessionManager.patchSession(session.id, {
    status: 'ready',
    summary: 'done:inspect repo',
    updatedAt: new Date().toISOString()
  });
  const readySession = runtimeSessionManager.getSession(session.id);
  const completedEvent = {
    type: AGENT_EVENT_TYPE.COMPLETED,
    sessionId: session.id,
    payload: {
      summary: 'done:inspect repo',
      result: 'all good'
    },
    ts: new Date().toISOString()
  };

  syncSupervisorTaskForRuntimeEvent({
    conversation: {
      id: 'conv-terminal-workspace',
      activeRuntimeSessionId: session.id,
      metadata: {
        supervisor: {
          taskMemory: {
            activeTaskId: 'task-terminal-workspace',
            byTask: {
              'task-terminal-workspace': {
                taskId: 'task-terminal-workspace',
                sessionId: session.id,
                provider: 'codex',
                title: 'inspect repo',
                status: 'running'
              }
            }
          }
        }
      }
    },
    session: readySession,
    event: completedEvent,
    taskMemory: {
      activeTaskId: 'task-terminal-workspace',
      byTask: {
        'task-terminal-workspace': {
          taskId: 'task-terminal-workspace',
          sessionId: session.id,
          provider: 'codex',
          title: 'inspect repo',
          status: 'running'
        }
      }
    },
    store: supervisorTaskStore,
    workspaceStore,
    reflectionService
  });

  const workspace = workspaceStore.getByRef('D:\\projects\\agent');
  const task = supervisorTaskStore.get('task-terminal-workspace');
  const reflection = reflectionStore.getLatestPostmortemByTaskId('task-terminal-workspace');
  assert.ok(workspace);
  assert.ok(workspace.taskIds.includes('task-terminal-workspace'));
  assert.equal(workspace.openTaskIds.includes('task-terminal-workspace'), false);
  assert.equal(typeof task?.postmortem?.purpose, 'string');
  assert.equal(typeof task?.postmortem?.outcome, 'string');
  assert.ok(Array.isArray(task?.postmortem?.keywords));
  assert.equal(reflection?.taskId, 'task-terminal-workspace');
});
