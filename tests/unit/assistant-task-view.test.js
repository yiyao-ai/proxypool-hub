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
import { AgentTaskStore } from '../../src/agent-core/task-store.js';
import { ChatUiConversationStore } from '../../src/chat-ui/conversation-store.js';
import { AgentChannelDeliveryStore } from '../../src/agent-channels/delivery-store.js';
import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import { AssistantTaskViewService } from '../../src/assistant-core/task-view-service.js';
import { SupervisorTaskStore } from '../../src/agent-orchestrator/supervisor-task-store.js';
import { TaskStore as AssistantDomainTaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore as AssistantDomainExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ProjectStore as AssistantDomainProjectStore } from '../../src/assistant-core/domain/project-store.js';

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
    return { pid: 888 };
  }
}

class FakeClaudeProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {};
  }

  async startTurn({ input, onProviderEvent, onTurnFinished }) {
    onProviderEvent({
      type: AGENT_EVENT_TYPE.MESSAGE,
      payload: { text: `claude:${input}` }
    });
    onTurnFinished({
      status: 'ready',
      summary: `done:${input}`
    });
    return { pid: 889 };
  }
}

function createFixture() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  registry.register(new FakeClaudeProvider());
  const runtimeSessionManager = new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-task-view-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-task-view-policy-')
    })
  });
  const conversationStore = new ChatUiConversationStore({
    configDir: createTempDir('cligate-assistant-task-view-conv-')
  });
  const taskStore = new AgentTaskStore({
    configDir: createTempDir('cligate-assistant-task-view-task-')
  });
  const deliveryStore = new AgentChannelDeliveryStore({
    configDir: createTempDir('cligate-assistant-task-view-delivery-')
  });
  const assistantRunStore = new AssistantRunStore({
    configDir: createTempDir('cligate-assistant-task-view-run-')
  });
  const supervisorTaskStore = new SupervisorTaskStore({
    configDir: createTempDir('cligate-assistant-task-view-supervisor-')
  });
  const assistantTaskStore = new AssistantDomainTaskStore({
    configDir: createTempDir('cligate-assistant-task-view-domain-task-')
  });
  const assistantExecutionStore = new AssistantDomainExecutionStore({
    configDir: createTempDir('cligate-assistant-task-view-domain-execution-')
  });
  const assistantProjectStore = new AssistantDomainProjectStore({
    configDir: createTempDir('cligate-assistant-task-view-domain-project-')
  });

  return {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    assistantRunStore,
    supervisorTaskStore,
    assistantTaskStore,
    assistantExecutionStore,
    assistantProjectStore,
    taskViewService: new AssistantTaskViewService({
      runtimeSessionManager,
      conversationStore,
      taskStore,
      supervisorTaskStore,
      deliveryStore,
      assistantRunStore,
      assistantTaskStore,
      assistantExecutionStore,
      assistantProjectStore
    })
  };
}

test('AssistantTaskViewService returns unified task records for assistant conversations', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    taskStore,
    deliveryStore,
    assistantRunStore,
    taskViewService
  } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo'
  });
  const conversation = conversationStore.findOrCreateBySessionId('task-view-chat-1', {
    assistantCore: {
      mode: 'assistant',
      assistantSessionId: 'assistant-session-1',
      lastRunId: 'placeholder'
    }
  });
  const run = assistantRunStore.create({
    assistantSessionId: 'assistant-session-1',
    conversationId: conversation.id,
    triggerText: '/cligate inspect repo',
    status: 'completed',
    summary: 'assistant summarized the runtime result',
    result: 'Workspace looks healthy.',
    relatedRuntimeSessionIds: [session.id],
    metadata: {
      checkpoint: {
        resumable: false,
        completedStepCount: 2,
        pendingStepCount: 0,
        updatedAt: new Date().toISOString()
      }
    }
  });
  conversationStore.bindRuntimeSession(conversation.id, session.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantCore: {
        ...(conversation.metadata?.assistantCore || {}),
        mode: 'assistant',
        assistantSessionId: 'assistant-session-1',
        lastRunId: run.id
      },
      supervisor: {
        brief: {
          status: 'completed',
          summary: 'inspect repo finished',
          waitingReason: '',
          nextSuggestion: 'Ask for a follow-up.'
        }
      }
    }
  });
  taskStore.create({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    provider: session.provider,
    title: 'inspect repo',
    status: 'completed',
    summary: 'task summary',
    result: 'task result'
  });
  deliveryStore.saveOutbound({
    channel: 'chat-ui',
    conversationId: conversation.id,
    sessionId: session.id,
    payload: { text: 'User-facing completion message' }
  });

  const tasks = taskViewService.listTasks({ limit: 10 });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].conversation.id, conversation.id);
  assert.equal(tasks[0].assistantRun.id, run.id);
  assert.equal(tasks[0].assistantRun.checkpoint.resumable, false);
  assert.equal(tasks[0].assistantRun.checkpoint.completedStepCount, 2);
  assert.equal(tasks[0].runtimeSession.id, session.id);
  assert.equal(tasks[0].latestTurn.input, 'inspect repo');
  assert.equal(tasks[0].state, 'completed');
  assert.ok(Array.isArray(tasks[0].trackedTaskIds));
  assert.equal(tasks[0].summary, 'assistant summarized the runtime result');
  assert.equal(tasks[0].resultPreview, 'Workspace looks healthy.');
  assert.equal(tasks[0].lastUserVisibleMessage.text, 'User-facing completion message');

  const detail = taskViewService.getTask(tasks[0].id);
  assert.equal(detail.id, tasks[0].id);
  assert.equal(detail.pending.approvalCount, 0);
  assert.equal(detail.pending.questionCount, 0);
});

test('AssistantTaskViewService builds latest assistant run lookup once instead of scanning runs per conversation', async () => {
  const {
    conversationStore,
    taskStore,
    deliveryStore,
    assistantRunStore,
    runtimeSessionManager,
    supervisorTaskStore
  } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo'
  });
  const conversation = conversationStore.findOrCreateBySessionId('task-view-chat-lookup-1');
  conversationStore.bindRuntimeSession(conversation.id, session.id);
  assistantRunStore.create({
    assistantSessionId: 'assistant-session-lookup-1',
    conversationId: conversation.id,
    triggerText: '/cligate inspect repo',
    status: 'completed',
    summary: 'done'
  });
  taskStore.create({
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    provider: session.provider,
    title: 'inspect repo',
    status: 'completed'
  });
  deliveryStore.saveOutbound({
    channel: 'chat-ui',
    conversationId: conversation.id,
    sessionId: session.id,
    payload: { text: 'done' }
  });

  let listCalls = 0;
  const originalList = assistantRunStore.list.bind(assistantRunStore);
  const originalListByConversationId = assistantRunStore.listByConversationId.bind(assistantRunStore);
  assistantRunStore.list = (...args) => {
    listCalls += 1;
    return originalList(...args);
  };
  assistantRunStore.listByConversationId = () => {
    throw new Error('listByConversationId should not be used in bulk task listing');
  };

  const taskViewService = new AssistantTaskViewService({
    conversationStore,
    runtimeSessionManager,
    taskStore,
    supervisorTaskStore,
    deliveryStore,
    assistantRunStore
  });

  const tasks = taskViewService.listTasks({ limit: 10 });
  assert.equal(tasks.length, 1);
  assert.equal(listCalls, 1);

  assistantRunStore.list = originalList;
  assistantRunStore.listByConversationId = originalListByConversationId;
});

test('AssistantTaskViewService does not reuse an older assistant run summary for a newer unrelated task in the same conversation', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    supervisorTaskStore,
    assistantRunStore,
    taskViewService
  } = createFixture();

  const qingdaoSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'check Qingdao weather'
  });
  const sanyaSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'check Sanya weather'
  });
  runtimeSessionManager.getSession(qingdaoSession.id).status = 'completed';
  runtimeSessionManager.getSession(qingdaoSession.id).summary = 'Qingdao is cloudy.';
  runtimeSessionManager.getSession(sanyaSession.id).status = 'completed';
  runtimeSessionManager.getSession(sanyaSession.id).summary = 'Sanya is sunny.';

  const conversation = conversationStore.findOrCreateBySessionId('task-view-summary-isolation-1', {
    assistantCore: {
      mode: 'assistant'
    },
    supervisor: {
      taskMemory: {
        activeTaskId: 'task-sanya'
      }
    }
  });
  conversationStore.bindRuntimeSession(conversation.id, sanyaSession.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantCore: {
        ...(conversation.metadata?.assistantCore || {}),
        mode: 'assistant'
      },
      supervisor: {
        ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
          ? conversation.metadata.supervisor
          : {}),
        taskMemory: {
          activeTaskId: 'task-sanya'
        },
        brief: {
          taskId: 'task-sanya',
          status: 'completed',
          summary: 'Sanya is sunny.'
        }
      }
    },
    trackedRuntimeSessionIds: [qingdaoSession.id, sanyaSession.id]
  });

  supervisorTaskStore.create({
    id: 'task-qingdao',
    conversationId: conversation.id,
    title: 'Check Qingdao weather',
    goal: 'check Qingdao weather',
    status: 'completed',
    executorStrategy: 'codex',
    primaryExecutionId: qingdaoSession.id,
    metadata: {
      runtimeSessionId: qingdaoSession.id,
      latestExecutionId: qingdaoSession.id,
      provider: 'codex'
    }
  });
  supervisorTaskStore.create({
    id: 'task-sanya',
    conversationId: conversation.id,
    title: 'Check Sanya weather',
    goal: 'check Sanya weather',
    status: 'completed',
    executorStrategy: 'codex',
    primaryExecutionId: sanyaSession.id,
    metadata: {
      runtimeSessionId: sanyaSession.id,
      latestExecutionId: sanyaSession.id,
      provider: 'codex'
    }
  });

  assistantRunStore.create({
    assistantSessionId: 'assistant-session-summary-isolation-1',
    conversationId: conversation.id,
    triggerText: '/cligate check Qingdao weather',
    status: 'completed',
    summary: 'Qingdao is cloudy.',
    result: 'Qingdao result',
    relatedRuntimeSessionIds: [qingdaoSession.id]
  });

  const taskSpace = taskViewService.getConversationTaskSpace(conversation.id);
  assert.equal(taskSpace.focusTask.taskId, 'task-sanya');
  assert.equal(taskSpace.focusTask.runtimeSession.id, sanyaSession.id);
  assert.equal(taskSpace.focusTask.summary, 'done:check Sanya weather');
  assert.equal(taskSpace.focusTask.assistantRun, null);
});

test('AssistantTaskViewService exposes task-space-first conversation snapshots', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    supervisorTaskStore,
    taskViewService
  } = createFixture();

  const waitingSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'need approval'
  });
  const completedSession = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: 'finished task'
  });
  const conversation = conversationStore.findOrCreateBySessionId('task-view-task-space-1', {
    supervisor: {
      taskMemory: {
        activeTaskId: 'task-waiting'
      }
    }
  });
  conversationStore.bindRuntimeSession(conversation.id, waitingSession.id, {
    metadata: {
      ...(conversation.metadata || {}),
      supervisor: {
        ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
          ? conversation.metadata.supervisor
          : {}),
        taskMemory: {
          activeTaskId: 'task-waiting'
        }
      }
    }
  });

  runtimeSessionManager.getSession(waitingSession.id).status = 'waiting_approval';
  runtimeSessionManager.getSession(completedSession.id).status = 'completed';

  supervisorTaskStore.create({
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
  supervisorTaskStore.create({
    id: 'task-done',
    conversationId: conversation.id,
    title: 'Finished task',
    goal: 'finished task',
    status: 'completed',
    executorStrategy: 'claude-code',
    primaryExecutionId: completedSession.id,
    metadata: {
      runtimeSessionId: completedSession.id,
      provider: 'claude-code'
    }
  });

  const taskSpace = taskViewService.getConversationTaskSpace(conversation.id);
  assert.equal(taskSpace.focusTask.taskId, 'task-waiting');
  assert.equal(taskSpace.activeTasks.length, 1);
  assert.equal(taskSpace.waitingTasks.length, 1);
  assert.equal(taskSpace.recentCompletedTasks.length, 1);
  assert.equal(taskSpace.recentCompletedTasks[0].taskId, 'task-done');
  assert.equal(taskSpace.summary.taskCount, 2);
  assert.match(String(taskSpace.focusTaskReason || ''), /only waiting task|focus task|focused|supervisor memory/i);
  assert.equal(taskSpace.decisionHints.preferredAction, 'continue_waiting_task');
  assert.equal(taskSpace.decisionHints.preferredTaskId, 'task-waiting');
  assert.match(String(taskSpace.decisionHints.reason || ''), /waiting task/i);
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.preferredRuntimeSessionId, waitingSession.id);
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.preferredAssistantExecutionId, '');
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.preferredTaskExecutionId, '');
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.source, 'task_latest_execution');
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.canContinue, true);
});

test('AssistantTaskViewService prefers pending-session hinted waiting task over unrelated active runtime', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    supervisorTaskStore,
    taskViewService
  } = createFixture();

  const activeSession = await runtimeSessionManager.createSession({
    provider: 'claude-code',
    input: 'other active task'
  });
  const waitingSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'task waiting approval'
  });
  runtimeSessionManager.getSession(activeSession.id).status = 'running';
  runtimeSessionManager.getSession(waitingSession.id).status = 'waiting_approval';
  runtimeSessionManager.approvalService.createApproval({
    sessionId: waitingSession.id,
    provider: 'codex',
    title: 'Write file',
    summary: 'Need permission to continue',
    rawRequest: {
      requestId: 'approval-task-view-1'
    }
  });

  const conversation = conversationStore.findOrCreateBySessionId('task-view-pending-session-priority-1');
  conversationStore.bindRuntimeSession(conversation.id, activeSession.id, {
    trackedRuntimeSessionIds: [activeSession.id, waitingSession.id],
    lastPendingApprovalId: 'approval-task-view-1',
    lastPendingApprovalSessionId: waitingSession.id
  });

  supervisorTaskStore.create({
    id: 'task-active',
    conversationId: conversation.id,
    title: 'Other active task',
    goal: 'other active task',
    status: 'running',
    executorStrategy: 'claude-code',
    primaryExecutionId: activeSession.id,
    metadata: {
      runtimeSessionId: activeSession.id,
      provider: 'claude-code'
    }
  });
  supervisorTaskStore.create({
    id: 'task-waiting-hinted',
    conversationId: conversation.id,
    title: 'Task waiting approval',
    goal: 'task waiting approval',
    status: 'waiting_approval',
    executorStrategy: 'codex',
    primaryExecutionId: waitingSession.id,
    metadata: {
      runtimeSessionId: waitingSession.id,
      provider: 'codex'
    }
  });

  const taskSpace = taskViewService.getConversationTaskSpace(conversation.id);
  assert.equal(taskSpace.focusTask.taskId, 'task-waiting-hinted');
  assert.equal(taskSpace.focusTask.runtimeSession.id, waitingSession.id);
  assert.equal(taskSpace.waitingTasks[0].taskId, 'task-waiting-hinted');
});

test('AssistantTaskViewService includes assistant domain links when supervisor task is dual-written', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    supervisorTaskStore,
    assistantTaskStore,
    assistantExecutionStore,
    assistantProjectStore,
    taskViewService
  } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'inspect repo'
  });
  const conversation = conversationStore.findOrCreateBySessionId('task-view-domain-link-1');
  conversationStore.bindRuntimeSession(conversation.id, session.id);

  const assistantProject = assistantProjectStore.create({
    ownerPersonId: 'person-1',
    name: 'repo project',
    kind: 'misc'
  });
  const assistantTask = assistantTaskStore.create({
    projectId: assistantProject.id,
    ownerPersonId: 'person-1',
    title: 'inspect repo',
    goal: 'inspect repo'
  });
  const assistantExecution = assistantExecutionStore.create({
    taskId: assistantTask.id,
    ownerPersonId: 'person-1',
    provider: 'codex',
    role: 'primary',
    objective: 'inspect repo',
    currentRuntimeSessionId: session.id
  });

  supervisorTaskStore.create({
    id: 'task-domain-link',
    conversationId: conversation.id,
    title: 'inspect repo',
    goal: 'inspect repo',
    status: 'completed',
    executorStrategy: 'codex',
    primaryExecutionId: session.id,
    metadata: {
      runtimeSessionId: session.id,
      provider: 'codex',
      assistantProjectId: assistantProject.id,
      assistantTaskId: assistantTask.id,
      assistantExecutionId: assistantExecution.id
    }
  });

  const detail = taskViewService.getTask('task-domain-link');
  assert.equal(detail?.assistantDomain?.task?.id, assistantTask.id);
  assert.equal(detail?.assistantDomain?.execution?.id, assistantExecution.id);
  assert.equal(detail?.assistantDomain?.project?.id, assistantProject.id);
});

test('AssistantTaskViewService decision hints prefer assistant execution runtime continuity over primary execution', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    supervisorTaskStore,
    assistantTaskStore,
    assistantExecutionStore,
    taskViewService
  } = createFixture();

  const primarySession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'primary execution'
  });
  const latestSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'latest execution'
  });
  const conversation = conversationStore.findOrCreateBySessionId('task-view-execution-continuity-1', {
    supervisor: {
      taskMemory: {
        activeTaskId: 'task-exec-continuity'
      }
    }
  });
  conversationStore.bindRuntimeSession(conversation.id, latestSession.id, {
    metadata: {
      ...(conversation.metadata || {}),
      supervisor: {
        ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
          ? conversation.metadata.supervisor
          : {}),
        taskMemory: {
          activeTaskId: 'task-exec-continuity'
        }
      }
    }
  });

  const assistantTask = assistantTaskStore.create({
    projectId: 'project-exec-continuity',
    ownerPersonId: 'person-exec-continuity',
    title: 'execution continuity',
    goal: 'execution continuity'
  });
  const assistantExecution = assistantExecutionStore.create({
    taskId: assistantTask.id,
    ownerPersonId: 'person-exec-continuity',
    provider: 'codex',
    role: 'secondary',
    objective: 'execution continuity',
    currentRuntimeSessionId: latestSession.id
  });

  supervisorTaskStore.create({
    id: 'task-exec-continuity',
    conversationId: conversation.id,
    title: 'execution continuity',
    goal: 'execution continuity',
    status: 'running',
    executorStrategy: 'codex',
    primaryExecutionId: primarySession.id,
    metadata: {
      runtimeSessionId: latestSession.id,
      latestExecutionId: latestSession.id,
      provider: 'codex',
      assistantTaskId: assistantTask.id,
      assistantExecutionId: assistantExecution.id
    }
  });

  const taskSpace = taskViewService.getConversationTaskSpace(conversation.id);
  assert.equal(taskSpace.focusTask.taskId, 'task-exec-continuity');
  assert.equal(taskSpace.decisionHints.preferredTaskId, 'task-exec-continuity');
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.preferredRuntimeSessionId, latestSession.id);
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.preferredAssistantExecutionId, assistantExecution.id);
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.preferredTaskExecutionId, assistantExecution.id);
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.source, 'assistant_execution_runtime');
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.canContinue, true);
  assert.match(String(taskSpace.decisionHints.focusTaskExecutionContinuity.reason || ''), /latest runtime session/i);
});

test('AssistantTaskViewService resolves task space from assistant domain working set without supervisor task records', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    assistantTaskStore,
    assistantExecutionStore,
    assistantProjectStore,
    taskViewService
  } = createFixture();

  const session = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'domain-only task view',
    cwd: 'D:\\github\\proxypool-hub'
  });
  const assistantProject = assistantProjectStore.create({
    ownerPersonId: 'person-domain-only',
    name: 'proxypool-hub',
    kind: 'code_project',
    cwd: 'D:\\github\\proxypool-hub'
  });
  const assistantTask = assistantTaskStore.create({
    projectId: assistantProject.id,
    ownerPersonId: 'person-domain-only',
    title: 'domain-only task view',
    goal: 'domain-only task view',
    lastConversationId: 'task-view-domain-only',
    activeExecutionIds: ['exec-task-view-domain-only'],
    allExecutionIds: ['exec-task-view-domain-only']
  });
  const assistantExecution = assistantExecutionStore.create({
    id: 'exec-task-view-domain-only',
    taskId: assistantTask.id,
    ownerPersonId: 'person-domain-only',
    provider: 'codex',
    role: 'primary',
    objective: 'domain-only task view',
    status: 'ready',
    currentRuntimeSessionId: session.id
  });

  const conversation = conversationStore.findOrCreateBySessionId('task-view-domain-only');
  conversationStore.bindRuntimeSession(conversation.id, session.id, {
    metadata: {
      ...(conversation.metadata || {}),
      assistantDomain: {
        ...(conversation.metadata?.assistantDomain || {}),
        personId: 'person-domain-only',
        workingSet: {
          primaryProjectId: assistantProject.id,
          primaryTaskId: assistantTask.id,
          recentTaskIds: [assistantTask.id],
          mentionedProjectIds: [assistantProject.id]
        }
      }
    }
  });

  const taskSpace = taskViewService.getConversationTaskSpace(conversation.id);
  assert.equal(taskSpace.focusTask.taskId, assistantTask.id);
  assert.equal(taskSpace.focusTask.runtimeSession.id, session.id);
  assert.equal(taskSpace.focusTask.task.title, assistantTask.title);
  assert.equal(taskSpace.focusTask.assistantDomain?.task?.id, assistantTask.id);
  assert.equal(taskSpace.focusTask.assistantDomain?.execution?.id, assistantExecution.id);
  assert.equal(taskSpace.focusTask.assistantDomain?.project?.id, assistantProject.id);
  assert.ok(taskSpace.conversation.trackedTaskIds.includes(assistantTask.id));
  assert.equal(taskSpace.decisionHints.preferredTaskId, assistantTask.id);
});

test('AssistantTaskViewService prefers reusing the most relevant recent completed task when no active task exists', async () => {
  const {
    runtimeSessionManager,
    conversationStore,
    supervisorTaskStore,
    taskViewService
  } = createFixture();

  const completedSession = await runtimeSessionManager.createSession({
    provider: 'codex',
    input: 'check Shenzhen weather'
  });
  runtimeSessionManager.getSession(completedSession.id).status = 'completed';

  const conversation = conversationStore.findOrCreateBySessionId('task-view-recent-completed-follow-up-1');
  conversationStore.bindRuntimeSession(conversation.id, completedSession.id);

  supervisorTaskStore.create({
    id: 'task-weather-follow-up',
    conversationId: conversation.id,
    title: 'Check weather',
    goal: 'check Shenzhen weather',
    status: 'completed',
    executorStrategy: 'codex',
    primaryExecutionId: completedSession.id,
    metadata: {
      runtimeSessionId: completedSession.id,
      latestExecutionId: completedSession.id,
      provider: 'codex'
    }
  });

  const taskSpace = taskViewService.getConversationTaskSpace(conversation.id);
  assert.equal(taskSpace.focusTask.taskId, 'task-weather-follow-up');
  assert.equal(taskSpace.recentCompletedTasks[0]?.taskId, 'task-weather-follow-up');
  assert.equal(taskSpace.decisionHints.preferredAction, 'continue_focus_task');
  assert.equal(taskSpace.decisionHints.preferredTaskId, 'task-weather-follow-up');
  assert.equal(taskSpace.decisionHints.shouldReuseRecentCompletedTask, true);
  assert.equal(taskSpace.decisionHints.focusTaskExecutionContinuity.preferredRuntimeSessionId, completedSession.id);
  assert.match(String(taskSpace.focusTaskReason || ''), /recent completed tasks can still be the default follow-up target/i);
  assert.match(String(taskSpace.decisionHints.reason || ''), /same-workflow requests with different parameters/i);
});
