import stateCoordinator from '../assistant-core/domain/state-coordinator.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import localScheduler from '../assistant-core/local-scheduler.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';

function parseLimit(value, fallback = 20, max = 200) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function toText(value) {
  return String(value || '').trim();
}

function toStringList(value, { lowercase = false } = {}) {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const result = [];
  for (const entry of list) {
    const normalized = lowercase
      ? toText(entry).toLowerCase()
      : toText(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function pickTaskPatch(body = {}) {
  const patch = {};
  if (body.title !== undefined) patch.title = toText(body.title);
  if (body.goal !== undefined) patch.goal = toText(body.goal);
  if (body.summary !== undefined) patch.summary = toText(body.summary);
  if (body.plan !== undefined) patch.plan = Array.isArray(body.plan) ? body.plan : [];
  if (body.todos !== undefined) patch.todos = Array.isArray(body.todos) ? body.todos : [];
  if (body.openQuestions !== undefined) patch.openQuestions = Array.isArray(body.openQuestions) ? body.openQuestions : [];
  if (body.blockers !== undefined) patch.blockers = Array.isArray(body.blockers) ? body.blockers : [];
  if (body.aliases !== undefined) patch.aliases = toStringList(body.aliases, { lowercase: true });
  if (body.lifecycleState !== undefined) patch.lifecycleState = toText(body.lifecycleState);
  if (body.completionCriteria !== undefined) patch.completionCriteria = toText(body.completionCriteria);
  if (body.metadata !== undefined) patch.metadata = toObject(body.metadata);
  return patch;
}

export function handleListAssistantProjects(req, res) {
  const projects = stateCoordinator.listProjects({
    personId: toText(req.query.personId),
    state: toText(req.query.state),
    limit: parseLimit(req.query.limit, 20, 100)
  });

  return res.json({
    success: true,
    projects
  });
}

export function handleGetAssistantPersonDashboard(req, res) {
  const dashboard = stateCoordinator.getPersonDashboard(toText(req.params.id));
  if (!dashboard) {
    return res.status(404).json({
      success: false,
      error: 'assistant person dashboard not found'
    });
  }
  return res.json({
    success: true,
    dashboard
  });
}

export function handleGetAssistantProject(req, res) {
  const project = stateCoordinator.projectStore.get(toText(req.params.id));
  if (!project) {
    return res.status(404).json({
      success: false,
      error: 'assistant project not found'
    });
  }

  return res.json({
    success: true,
    project
  });
}

export function handleListAssistantProjectTasks(req, res) {
  const projectId = toText(req.params.id);
  const project = stateCoordinator.projectStore.get(projectId);
  if (!project) {
    return res.status(404).json({
      success: false,
      error: 'assistant project not found'
    });
  }

  const tasks = stateCoordinator.listTasks({
    projectId,
    lifecycleState: toText(req.query.lifecycleState),
    limit: parseLimit(req.query.limit, 50, 200)
  });

  return res.json({
    success: true,
    tasks
  });
}

export function handleCreateAssistantTask(req, res) {
  try {
    const projectId = toText(req.body?.projectId);
    const project = stateCoordinator.projectStore.get(projectId);
    if (!project?.id) {
      return res.status(404).json({
        success: false,
        error: 'assistant project not found'
      });
    }
    const task = stateCoordinator.createTask({
      personId: toText(req.body?.personId) || project.ownerPersonId,
      projectId: project.id,
      title: toText(req.body?.title),
      goal: toText(req.body?.goal),
      conversationId: toText(req.body?.conversationId),
      completionCriteria: toText(req.body?.completionCriteria) || 'explicit_user_close',
      assistantRationale: req.body?.assistantRationale && typeof req.body.assistantRationale === 'object'
        ? req.body.assistantRationale
        : null,
      metadata: toObject(req.body?.metadata)
    });
    return res.json({
      success: true,
      task
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export function handlePatchAssistantTask(req, res) {
  try {
    const patch = pickTaskPatch(req.body);
    const task = stateCoordinator.updateTask({
      id: toText(req.params.id),
      patch,
      reason: toText(req.body?.reason) || 'assistant_entities_route_patch'
    });
    return res.json({
      success: true,
      task
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message
    });
  }
}

export function handleReplaceAssistantTaskPlan(req, res) {
  try {
    const task = stateCoordinator.updateTask({
      id: toText(req.params.id),
      patch: {
        plan: Array.isArray(req.body?.plan) ? req.body.plan : []
      },
      reason: toText(req.body?.reason) || 'assistant_entities_route_plan_replace'
    });
    return res.json({
      success: true,
      task
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message
    });
  }
}

export function handleMoveAssistantTask(req, res) {
  try {
    const moved = stateCoordinator.moveTaskToProject({
      taskId: toText(req.params.id),
      targetProjectId: toText(req.body?.targetProjectId),
      reason: toText(req.body?.reason) || 'assistant_entities_route_move',
      conversationId: toText(req.body?.conversationId)
    });
    return res.json({
      success: true,
      task: moved.task,
      sourceProject: moved.sourceProject || null,
      targetProject: moved.targetProject || null
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export function handlePromoteAssistantTaskToProject(req, res) {
  try {
    const promoted = stateCoordinator.promoteTaskToProject({
      taskId: toText(req.params.id),
      name: toText(req.body?.name),
      cwd: toText(req.body?.cwd),
      kind: toText(req.body?.kind),
      reason: toText(req.body?.reason) || 'assistant_entities_route_promote',
      conversationId: toText(req.body?.conversationId)
    });
    return res.json({
      success: true,
      task: promoted.task,
      project: promoted.project
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export function handleGetAssistantTaskDashboard(req, res) {
  const dashboard = stateCoordinator.getTaskDashboard(toText(req.params.id));
  if (!dashboard) {
    return res.status(404).json({
      success: false,
      error: 'assistant task dashboard not found'
    });
  }

  return res.json({
    success: true,
    dashboard
  });
}

export function handleListAssistantExecutions(req, res) {
  const executions = stateCoordinator.listExecutions({
    taskId: toText(req.query.taskId),
    status: toText(req.query.status),
    limit: parseLimit(req.query.limit, 20, 100)
  });

  return res.json({
    success: true,
    executions
  });
}

export function handleGetAssistantExecution(req, res) {
  const execution = stateCoordinator.executionStore.get(toText(req.params.id));
  if (!execution) {
    return res.status(404).json({
      success: false,
      error: 'assistant execution not found'
    });
  }

  return res.json({
    success: true,
    execution
  });
}

export async function handleCreateAssistantTaskExecution(req, res) {
  try {
    const task = stateCoordinator.taskStore.get(toText(req.params.id));
    if (!task?.id) {
      return res.status(404).json({
        success: false,
        error: 'assistant task not found'
      });
    }
    const project = stateCoordinator.projectStore.get(task.projectId);
    const session = await agentOrchestratorMessageService.startRuntimeTask({
      provider: toText(req.body?.provider) || 'codex',
      input: toText(req.body?.input || req.body?.objective || task.goal || task.title),
      cwd: toText(req.body?.cwd) || toText(project?.cwd),
      model: toText(req.body?.model),
      metadata: {
        ...(toObject(req.body?.metadata)),
        taskId: task.id,
        conversationId: toText(req.body?.conversationId) || task.lastConversationId,
        executionRole: toText(req.body?.role) || 'secondary',
        source: {
          kind: 'assistant-task-execution',
          taskId: task.id
        }
      }
    });
    const executionId = toText(session?.execution?.executionId || session?.metadata?.assistantExecutionId);
    const execution = executionId
      ? stateCoordinator.executionStore.get(executionId)
      : null;
    return res.json({
      success: true,
      session,
      execution: execution || session?.execution || null
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export function handleCreateAssistantExecutionHandoff(req, res) {
  try {
    const created = stateCoordinator.addExecutionHandoff({
      targetExecutionId: toText(req.params.id),
      fromExecutionId: toText(req.body?.fromExecutionId),
      kind: toText(req.body?.kind) || 'progress',
      title: toText(req.body?.title),
      payload: req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : null,
      conversationId: toText(req.body?.conversationId)
    });
    return res.json({
      success: true,
      execution: created.execution,
      handoff: created.handoff
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message
    });
  }
}

export async function handleSendAssistantExecutionInput(req, res) {
  try {
    const execution = stateCoordinator.executionStore.get(toText(req.params.id));
    if (!execution?.id) {
      return res.status(404).json({
        success: false,
        error: 'assistant execution not found'
      });
    }
    const sessionId = toText(req.body?.sessionId) || toText(execution.currentRuntimeSessionId);
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'assistant execution runtime session not found'
      });
    }
    const session = await agentOrchestratorMessageService.continueRuntimeTask({
      taskId: execution.taskId,
      sessionId,
      input: toText(req.body?.input || req.body?.message)
    });
    const nextExecutionId = toText(session?.execution?.executionId || execution.id);
    return res.json({
      success: true,
      session,
      execution: stateCoordinator.executionStore.get(nextExecutionId) || execution
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export async function handleRespawnAssistantExecution(req, res) {
  try {
    const execution = stateCoordinator.executionStore.get(toText(req.params.id));
    if (!execution?.id) {
      return res.status(404).json({
        success: false,
        error: 'assistant execution not found'
      });
    }
    const sessionId = toText(execution.currentRuntimeSessionId);
    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'assistant execution runtime session not found'
      });
    }
    agentRuntimeSessionManager.cancelSession(sessionId);
    const session = await agentOrchestratorMessageService.continueRuntimeTask({
      taskId: execution.taskId,
      sessionId,
      input: toText(req.body?.input || req.body?.message || execution.objective || 'Respawn execution')
    });
    const nextExecutionId = toText(session?.execution?.executionId || execution.id);
    return res.json({
      success: true,
      session,
      execution: stateCoordinator.executionStore.get(nextExecutionId) || execution
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export function handleConsumeAssistantExecutionHandoff(req, res) {
  try {
    const consumed = stateCoordinator.consumeExecutionHandoff({
      executionId: toText(req.params.id),
      handoffId: toText(req.params.handoffId),
      conversationId: toText(req.body?.conversationId)
    });
    return res.json({
      success: true,
      execution: consumed.execution,
      handoff: consumed.handoff
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message
    });
  }
}

export function handleListAssistantEpisodes(req, res) {
  const episodes = stateCoordinator.episodeLedger.listByEntity({
    personId: toText(req.query.personId),
    projectId: toText(req.query.projectId),
    taskId: toText(req.query.taskId),
    executionId: toText(req.query.executionId),
    runtimeSessionId: toText(req.query.runtimeSessionId),
    conversationId: toText(req.query.conversationId),
    kind: toText(req.query.kind),
    limit: parseLimit(req.query.limit, 50, 200)
  });

  return res.json({
    success: true,
    episodes
  });
}

export function handleGetAssistantEpisode(req, res) {
  const episode = stateCoordinator.episodeLedger.get(toText(req.params.id));
  if (!episode) {
    return res.status(404).json({
      success: false,
      error: 'assistant episode not found'
    });
  }

  return res.json({
    success: true,
    episode
  });
}

export function handleGetAssistantExecutionTranscript(req, res) {
  const execution = stateCoordinator.executionStore.get(toText(req.params.id));
  if (!execution) {
    return res.status(404).json({
      success: false,
      error: 'assistant execution not found'
    });
  }

  const runtimeSessionId = toText(execution.currentRuntimeSessionId);
  if (!runtimeSessionId) {
    return res.status(404).json({
      success: false,
      error: 'execution transcript not found'
    });
  }

  const session = agentRuntimeSessionManager.getSession(runtimeSessionId);
  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'execution transcript not found'
    });
  }

  const turnLimit = parseLimit(req.query.turnLimit, 20, 200);
  const eventLimit = parseLimit(req.query.eventLimit, 100, 500);
  const turns = agentRuntimeSessionManager.listTurns(runtimeSessionId, { limit: turnLimit });
  const transcript = turns.map((turn) => ({
    turn,
    events: agentRuntimeSessionManager.listTurnEvents(runtimeSessionId, turn.id, { limit: eventLimit })
  }));

  return res.json({
    success: true,
    transcript: {
      execution,
      session,
      turns: transcript
    }
  });
}

export function handleListAssistantScheduledTasks(req, res) {
  const tasks = stateCoordinator.scheduledTaskStore.list({
    limit: parseLimit(req.query.limit, 50, 200),
    predicate: (entry) => (
      (!toText(req.query.personId) || entry.personId === toText(req.query.personId))
      && (!toText(req.query.taskId) || entry.taskId === toText(req.query.taskId))
      && (!toText(req.query.state) || entry.state === toText(req.query.state))
    )
  });
  return res.json({
    success: true,
    scheduledTasks: tasks
  });
}

export function handleCreateAssistantScheduledTask(req, res) {
  try {
    const scheduledTask = stateCoordinator.createScheduledTask({
      personId: toText(req.body?.personId),
      projectId: toText(req.body?.projectId),
      taskId: toText(req.body?.taskId),
      executionId: toText(req.body?.executionId),
      kind: toText(req.body?.kind) || 'check_in',
      title: toText(req.body?.title),
      schedule: req.body?.schedule && typeof req.body.schedule === 'object' ? req.body.schedule : {},
      payload: req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : null,
      source: toText(req.body?.source) || 'system',
      metadata: req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {}
    });
    return res.json({
      success: true,
      scheduledTask
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export function handleUpdateAssistantAutonomy(req, res) {
  try {
    const updated = stateCoordinator.updateAutonomy({
      scope: toText(req.body?.scope) || 'task',
      scopeRef: toText(req.body?.scopeRef),
      patch: toObject(req.body?.patch)
    });
    return res.json({
      success: true,
      entity: updated
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export async function handleRunAssistantScheduledTask(req, res) {
  try {
    const result = await localScheduler.runTask(toText(req.params.id));
    return res.json({
      success: true,
      task: result.task,
      result: result.result || null,
      error: result.error ? String(result.error.message || result.error) : null
    });
  } catch (error) {
    return res.status(404).json({
      success: false,
      error: error.message
    });
  }
}

export default {
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
};
