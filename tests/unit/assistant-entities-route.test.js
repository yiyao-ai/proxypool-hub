import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PersonStore } from '../../src/assistant-core/domain/person-store.js';
import { ProjectStore } from '../../src/assistant-core/domain/project-store.js';
import { TaskStore } from '../../src/assistant-core/domain/task-store.js';
import { ExecutionStore } from '../../src/assistant-core/domain/execution-store.js';
import { ScheduledTaskStore } from '../../src/assistant-core/domain/scheduled-task-store.js';
import { EpisodeLedger } from '../../src/assistant-core/domain/episode-ledger.js';
import { StateCoordinator } from '../../src/assistant-core/domain/state-coordinator.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import { AgentRuntimeApprovalPolicyStore } from '../../src/agent-runtime/approval-policy-store.js';
import { AGENT_EVENT_TYPE } from '../../src/agent-runtime/models.js';
import {
  handleGetAssistantPersonDashboard,
  handleListAssistantProjects,
  handleGetAssistantProject,
  handleListAssistantProjectTasks,
  handleCreateAssistantTask,
  handlePatchAssistantTask,
  handleReplaceAssistantTaskPlan,
  handleMoveAssistantTask,
  handlePromoteAssistantTaskToProject,
  handleGetAssistantTaskDashboard,
  handleListAssistantExecutions,
  handleGetAssistantExecution,
  handleCreateAssistantTaskExecution,
  handleCreateAssistantExecutionHandoff,
  handleSendAssistantExecutionInput,
  handleRespawnAssistantExecution,
  handleConsumeAssistantExecutionHandoff,
  handleListAssistantEpisodes,
  handleGetAssistantEpisode,
  handleGetAssistantExecutionTranscript,
  handleListAssistantScheduledTasks,
  handleCreateAssistantScheduledTask,
  handleUpdateAssistantAutonomy,
  handleRunAssistantScheduledTask
} from '../../src/routes/assistant-entities-route.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
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

function createCoordinator() {
  const configDir = createTempDir('cligate-assistant-entities-route-');
  return new StateCoordinator({
    personStore: new PersonStore({ configDir }),
    projectStore: new ProjectStore({ configDir }),
    taskStore: new TaskStore({ configDir }),
    executionStore: new ExecutionStore({ configDir }),
    scheduledTaskStore: new ScheduledTaskStore({ configDir }),
    episodeLedger: new EpisodeLedger({ configDir }),
    conversationStore: {
      get() { return null; },
      save(value) { return value; }
    }
  });
}

function createRuntimeManager() {
  const registry = new AgentRuntimeRegistry();
  registry.register(new FakeProvider());
  return new AgentRuntimeSessionManager({
    registry,
    store: new AgentRuntimeSessionStore({
      configDir: createTempDir('cligate-assistant-entities-runtime-')
    }),
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService(),
    approvalPolicyStore: new AgentRuntimeApprovalPolicyStore({
      configDir: createTempDir('cligate-assistant-entities-policy-')
    })
  });
}

test('assistant entity routes list and fetch projects, task dashboards, and executions', async () => {
  const coordinator = createCoordinator();
  const runtimeManager = createRuntimeManager();
  const singleton = (await import('../../src/assistant-core/domain/state-coordinator.js')).default;
  const runtimeSingleton = (await import('../../src/agent-runtime/session-manager.js')).default;
  const {
    listProjects,
    listTasks,
    getTaskDashboard,
    listExecutions,
    taskStore,
    personStore,
    projectStore,
    executionStore,
    episodeLedger,
    scheduledTaskStore
  } = singleton;
  const {
    getSession,
    listTurns,
    listTurnEvents
  } = runtimeSingleton;

  const session = await runtimeManager.createSession({
    provider: 'codex',
    input: 'inspect repo'
  });

  const person = coordinator.personStore.create({
    externalIdentities: [{ channel: 'chat-ui', externalUserId: 'user-1' }],
    miscProjectId: '',
    knownProjectIds: []
  });
  const project = coordinator.projectStore.create({
    ownerPersonId: person.id,
    name: 'repo project',
    kind: 'code_project',
    cwd: 'D:\\projects\\repo'
  });
  const task = coordinator.taskStore.create({
    ownerPersonId: person.id,
    projectId: project.id,
    title: 'inspect repo',
    goal: 'inspect repo',
    lastConversationId: 'conversation-1'
  });
  const execution = coordinator.executionStore.create({
    taskId: task.id,
    ownerPersonId: person.id,
    provider: 'codex',
    role: 'primary',
    status: 'running',
    objective: 'inspect repo',
    currentRuntimeSessionId: session.id
  });
  coordinator.taskStore.attachExecution(task.id, execution.id, { active: true });
  const episode = coordinator.episodeLedger.append({
    kind: 'execution.created',
    personId: person.id,
    projectId: project.id,
    taskId: task.id,
    executionId: execution.id,
    runtimeSessionId: session.id,
    conversationId: 'conversation-1',
    payload: {
      provider: 'codex'
    }
  });

  singleton.listProjects = coordinator.listProjects.bind(coordinator);
  singleton.listTasks = coordinator.listTasks.bind(coordinator);
  singleton.getTaskDashboard = coordinator.getTaskDashboard.bind(coordinator);
  singleton.listExecutions = coordinator.listExecutions.bind(coordinator);
  singleton.personStore = coordinator.personStore;
  singleton.taskStore = coordinator.taskStore;
  singleton.projectStore = coordinator.projectStore;
  singleton.executionStore = coordinator.executionStore;
  singleton.episodeLedger = coordinator.episodeLedger;
  singleton.scheduledTaskStore = coordinator.scheduledTaskStore;
  runtimeSingleton.getSession = runtimeManager.getSession.bind(runtimeManager);
  runtimeSingleton.listTurns = runtimeManager.listTurns.bind(runtimeManager);
  runtimeSingleton.listTurnEvents = runtimeManager.listTurnEvents.bind(runtimeManager);

  try {
    const listProjectsRes = mockRes();
    handleListAssistantProjects({ query: { personId: person.id } }, listProjectsRes);
    assert.equal(listProjectsRes._status, 200);
    assert.equal(listProjectsRes._body.success, true);
    assert.equal(listProjectsRes._body.projects[0].id, project.id);

    const personDashboardRes = mockRes();
    handleGetAssistantPersonDashboard({ params: { id: person.id } }, personDashboardRes);
    assert.equal(personDashboardRes._status, 200);
    assert.equal(personDashboardRes._body.dashboard.person.id, person.id);
    assert.equal(personDashboardRes._body.dashboard.summary.projectCount >= 1, true);

    const getProjectRes = mockRes();
    handleGetAssistantProject({ params: { id: project.id } }, getProjectRes);
    assert.equal(getProjectRes._status, 200);
    assert.equal(getProjectRes._body.project.id, project.id);

    const projectTasksRes = mockRes();
    handleListAssistantProjectTasks({ params: { id: project.id }, query: {} }, projectTasksRes);
    assert.equal(projectTasksRes._status, 200);
    assert.equal(projectTasksRes._body.tasks[0].id, task.id);

    const createTaskRes = mockRes();
    handleCreateAssistantTask({
      body: {
        projectId: project.id,
        personId: person.id,
        title: 'write tests',
        goal: 'add route tests',
        conversationId: 'conversation-1'
      }
    }, createTaskRes);
    assert.equal(createTaskRes._status, 200);
    assert.equal(createTaskRes._body.task.title, 'write tests');

    const patchTaskRes = mockRes();
    handlePatchAssistantTask({
      params: { id: task.id },
      body: {
        summary: 'task summary updated',
        plan: ['inspect', 'implement', 'verify'],
        todos: ['verify routes'],
        openQuestions: ['need extra UI test?'],
        reason: 'test_patch'
      }
    }, patchTaskRes);
    assert.equal(patchTaskRes._status, 200);
    assert.equal(patchTaskRes._body.task.summary, 'task summary updated');
    assert.deepEqual(patchTaskRes._body.task.plan, ['inspect', 'implement', 'verify']);

    const replacePlanRes = mockRes();
    handleReplaceAssistantTaskPlan({
      params: { id: task.id },
      body: {
        plan: ['collect facts', 'patch routes', 'run tests'],
        reason: 'test_replace_plan'
      }
    }, replacePlanRes);
    assert.equal(replacePlanRes._status, 200);
    assert.deepEqual(replacePlanRes._body.task.plan, ['collect facts', 'patch routes', 'run tests']);

    const promotedTaskRes = mockRes();
    handlePromoteAssistantTaskToProject({
      params: { id: createTaskRes._body.task.id },
      body: {
        name: 'write-tests-project',
        cwd: 'D:\\projects\\write-tests',
        kind: 'code_project',
        reason: 'test_promote',
        conversationId: 'conversation-1'
      }
    }, promotedTaskRes);
    assert.equal(promotedTaskRes._status, 200);
    assert.equal(promotedTaskRes._body.project.name, 'write-tests-project');
    assert.equal(promotedTaskRes._body.task.projectId, promotedTaskRes._body.project.id);

    const moveTaskRes = mockRes();
    handleMoveAssistantTask({
      params: { id: task.id },
      body: {
        targetProjectId: promotedTaskRes._body.project.id,
        reason: 'test_move',
        conversationId: 'conversation-1'
      }
    }, moveTaskRes);
    assert.equal(moveTaskRes._status, 200);
    assert.equal(moveTaskRes._body.task.projectId, promotedTaskRes._body.project.id);

    const dashboardRes = mockRes();
    handleGetAssistantTaskDashboard({ params: { id: task.id } }, dashboardRes);
    assert.equal(dashboardRes._status, 200);
    assert.equal(dashboardRes._body.dashboard.task.id, task.id);
    assert.equal(dashboardRes._body.dashboard.executions[0].id, execution.id);

    const listExecutionsRes = mockRes();
    handleListAssistantExecutions({ query: { taskId: task.id } }, listExecutionsRes);
    assert.equal(listExecutionsRes._status, 200);
    assert.equal(listExecutionsRes._body.executions[0].id, execution.id);

    const getExecutionRes = mockRes();
    handleGetAssistantExecution({ params: { id: execution.id } }, getExecutionRes);
    assert.equal(getExecutionRes._status, 200);
    assert.equal(getExecutionRes._body.execution.id, execution.id);

    const messageServiceSingleton = (await import('../../src/agent-orchestrator/message-service.js')).default;
    const originalStartRuntimeTask = messageServiceSingleton.startRuntimeTask;
    const originalContinueRuntimeTask = messageServiceSingleton.continueRuntimeTask;
    messageServiceSingleton.startRuntimeTask = async (payload) => ({
      id: 'runtime-new-1',
      provider: payload.provider,
      metadata: {
        assistantExecutionId: execution.id
      },
      execution: {
        executionId: execution.id
      }
    });
    messageServiceSingleton.continueRuntimeTask = async (payload) => ({
      id: payload.sessionId,
      provider: 'codex',
      execution: {
        executionId: execution.id
      }
    });
    const originalCancelSession = runtimeSingleton.cancelSession;
    runtimeSingleton.cancelSession = (id) => ({
      id,
      status: 'cancelled'
    });
    try {
      const createExecutionRes = mockRes();
      await handleCreateAssistantTaskExecution({
        params: { id: task.id },
        body: {
          provider: 'codex',
          input: 'continue with extra checks',
          role: 'secondary'
        }
      }, createExecutionRes);
      assert.equal(createExecutionRes._status, 200);
      assert.equal(createExecutionRes._body.session.provider, 'codex');

      const executionInputRes = mockRes();
      await handleSendAssistantExecutionInput({
        params: { id: execution.id },
        body: {
          input: 'please continue'
        }
      }, executionInputRes);
      assert.equal(executionInputRes._status, 200);
      assert.equal(executionInputRes._body.session.id, session.id);

      const respawnRes = mockRes();
      await handleRespawnAssistantExecution({
        params: { id: execution.id },
        body: {
          input: 'respawn with fresh session'
        }
      }, respawnRes);
      assert.equal(respawnRes._status, 200);
      assert.equal(respawnRes._body.session.id, session.id);
    } finally {
      messageServiceSingleton.startRuntimeTask = originalStartRuntimeTask;
      messageServiceSingleton.continueRuntimeTask = originalContinueRuntimeTask;
      runtimeSingleton.cancelSession = originalCancelSession;
    }

    const listEpisodesRes = mockRes();
    handleListAssistantEpisodes({ query: { executionId: execution.id } }, listEpisodesRes);
    assert.equal(listEpisodesRes._status, 200);
    assert.equal(listEpisodesRes._body.episodes[0].id, episode.id);

    const getEpisodeRes = mockRes();
    handleGetAssistantEpisode({ params: { id: episode.id } }, getEpisodeRes);
    assert.equal(getEpisodeRes._status, 200);
    assert.equal(getEpisodeRes._body.episode.id, episode.id);

    const transcriptRes = mockRes();
    handleGetAssistantExecutionTranscript({ params: { id: execution.id }, query: {} }, transcriptRes);
    assert.equal(transcriptRes._status, 200);
    assert.equal(transcriptRes._body.transcript.execution.id, execution.id);
    assert.equal(transcriptRes._body.transcript.session.id, session.id);
    assert.equal(transcriptRes._body.transcript.turns[0].turn.input, 'inspect repo');
    assert.ok(Array.isArray(transcriptRes._body.transcript.turns[0].events));

    const handoffCreateRes = mockRes();
    handleCreateAssistantExecutionHandoff({
      params: { id: execution.id },
      body: {
        kind: 'review_request',
        title: 'Please review',
        payload: {
          files: ['src/index.js']
        },
        conversationId: 'conversation-1'
      }
    }, handoffCreateRes);
    assert.equal(handoffCreateRes._status, 200);
    assert.equal(handoffCreateRes._body.handoff.kind, 'review_request');

    const handoffConsumeRes = mockRes();
    handleConsumeAssistantExecutionHandoff({
      params: {
        id: execution.id,
        handoffId: handoffCreateRes._body.handoff.id
      },
      body: {
        conversationId: 'conversation-1'
      }
    }, handoffConsumeRes);
    assert.equal(handoffConsumeRes._status, 200);
    assert.equal(handoffConsumeRes._body.handoff.status, 'consumed');

    const scheduledCreateRes = mockRes();
    handleCreateAssistantScheduledTask({
      body: {
        personId: person.id,
        projectId: project.id,
        taskId: task.id,
        executionId: execution.id,
        kind: 'check_in',
        title: 'Daily check-in',
        schedule: {
          type: 'once',
          triggerAt: '2026-05-13T00:00:00.000Z'
        }
      }
    }, scheduledCreateRes);
    assert.equal(scheduledCreateRes._status, 200);
    assert.ok(scheduledCreateRes._body.scheduledTask.id);

    const scheduledListRes = mockRes();
    handleListAssistantScheduledTasks({
      query: {
        taskId: task.id
      }
    }, scheduledListRes);
    assert.equal(scheduledListRes._status, 200);
    assert.equal(scheduledListRes._body.scheduledTasks.length >= 1, true);

    coordinator.updateScheduledTaskState({
      id: scheduledCreateRes._body.scheduledTask.id,
      state: 'scheduled',
      patch: {
        nextRunAt: '2026-05-13T00:00:00.000Z'
      },
      reason: 'test_prepare_run'
    });
    const schedulerSingleton = (await import('../../src/assistant-core/local-scheduler.js')).default;
    const originalRunTask = schedulerSingleton.runTask;
    schedulerSingleton.runTask = async (id) => ({
      task: coordinator.updateScheduledTaskState({
        id,
        state: 'completed',
        patch: {
          lastRunAt: '2026-05-13T00:01:00.000Z',
          lastResultPreview: 'done'
        },
        reason: 'test_manual_run'
      }),
      result: {
        summary: 'done'
      }
    });
    try {
      const scheduledRunRes = mockRes();
      await handleRunAssistantScheduledTask({
        params: { id: scheduledCreateRes._body.scheduledTask.id }
      }, scheduledRunRes);
      assert.equal(scheduledRunRes._status, 200);
      assert.equal(scheduledRunRes._body.task.state, 'completed');
    } finally {
      schedulerSingleton.runTask = originalRunTask;
    }

    const autonomyRes = mockRes();
    handleUpdateAssistantAutonomy({
      body: {
        scope: 'task',
        scopeRef: task.id,
        patch: {
          proactiveReportThreshold: 'high'
        }
      }
    }, autonomyRes);
    assert.equal(autonomyRes._status, 200);
    assert.equal(autonomyRes._body.entity.autonomy.proactiveReportThreshold, 'high');

    const missingProjectRes = mockRes();
    handleGetAssistantProject({ params: { id: 'missing-project' } }, missingProjectRes);
    assert.equal(missingProjectRes._status, 404);

    const missingDashboardRes = mockRes();
    handleGetAssistantTaskDashboard({ params: { id: 'missing-task' } }, missingDashboardRes);
    assert.equal(missingDashboardRes._status, 404);

    const missingExecutionRes = mockRes();
    handleGetAssistantExecution({ params: { id: 'missing-execution' } }, missingExecutionRes);
    assert.equal(missingExecutionRes._status, 404);

    const missingEpisodeRes = mockRes();
    handleGetAssistantEpisode({ params: { id: 'missing-episode' } }, missingEpisodeRes);
    assert.equal(missingEpisodeRes._status, 404);

    const missingTranscriptRes = mockRes();
    handleGetAssistantExecutionTranscript({ params: { id: 'missing-execution' }, query: {} }, missingTranscriptRes);
    assert.equal(missingTranscriptRes._status, 404);
  } finally {
    singleton.listProjects = listProjects;
    singleton.listTasks = listTasks;
    singleton.getTaskDashboard = getTaskDashboard;
    singleton.listExecutions = listExecutions;
    singleton.personStore = personStore;
    singleton.taskStore = taskStore;
    singleton.projectStore = projectStore;
    singleton.executionStore = executionStore;
    singleton.episodeLedger = episodeLedger;
    singleton.scheduledTaskStore = scheduledTaskStore;
    runtimeSingleton.getSession = getSession;
    runtimeSingleton.listTurns = listTurns;
    runtimeSingleton.listTurnEvents = listTurnEvents;
  }
});
