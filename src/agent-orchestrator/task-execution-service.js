import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import supervisorTaskStore from './supervisor-task-store.js';
import assistantWorkspaceStore from '../assistant-core/workspace-store.js';
import { createSupervisorTask } from './supervisor-task-store.js';
import { normalizeWorkspaceRef } from '../assistant-core/workspace-store.js';
import agentChannelConversationStore from '../agent-channels/conversation-store.js';
import stateCoordinator from '../assistant-core/domain/state-coordinator.js';

function toText(value) {
  return String(value || '').trim();
}

function isTerminalTaskStatus(status = '') {
  return ['completed', 'failed', 'cancelled'].includes(toText(status));
}

function syncWorkspaceTaskBinding(workspaceStore, workspaceRef, {
  taskId = '',
  provider = '',
  summary = '',
  taskStatus = '',
  timestamp = '',
  metadata = {}
} = {}) {
  const normalizedWorkspaceRef = normalizeWorkspaceRef(workspaceRef);
  const normalizedTaskId = toText(taskId);
  if (!workspaceStore || !normalizedWorkspaceRef || !normalizedTaskId) {
    return null;
  }

  const current = workspaceStore.getByRef(normalizedWorkspaceRef);
  const currentOpenTaskIds = Array.isArray(current?.openTaskIds) ? current.openTaskIds : [];
  const nextOpenTaskIds = isTerminalTaskStatus(taskStatus)
    ? currentOpenTaskIds.filter((entry) => entry !== normalizedTaskId)
    : [...currentOpenTaskIds, normalizedTaskId];
  const workspace = workspaceStore.upsert({
    workspaceRef: normalizedWorkspaceRef,
    patch: {
      defaultRuntimeProvider: toText(provider) || current?.defaultRuntimeProvider || '',
      ...(toText(summary) ? { summary: toText(summary) } : {}),
      taskIds: [normalizedTaskId],
      lastTouchedAt: toText(timestamp) || new Date().toISOString(),
      metadata
    }
  });
  return workspaceStore.replaceOpenTaskIds(normalizedWorkspaceRef, nextOpenTaskIds, {
    defaultRuntimeProvider: workspace?.defaultRuntimeProvider || toText(provider),
    ...(toText(summary) ? { summary: toText(summary) } : {}),
    taskIds: [normalizedTaskId],
    lastTouchedAt: toText(timestamp) || new Date().toISOString(),
    metadata
  }) || workspace;
}

function withDefaultRuntimeOptions(provider, metadata = {}) {
  const next = { ...(metadata || {}) };
  const runtimeOptions = { ...(next.runtimeOptions || {}) };

  if (provider === 'codex' && String(next.cwd || '').trim()) {
    runtimeOptions.codex = {
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ...(runtimeOptions.codex || {})
    };
  }

  if (Object.keys(runtimeOptions).length > 0) {
    next.runtimeOptions = runtimeOptions;
  }

  return next;
}

function buildExecutionRecord({
  taskId = '',
  executionId = '',
  runtimeSessionId = '',
  executor = '',
  role = 'primary',
  status = '',
  summary = '',
  result = '',
  error = '',
  createdAt = '',
  updatedAt = ''
} = {}) {
  return {
    executionId: toText(executionId),
    taskId: toText(taskId),
    executor: toText(executor),
    runtimeSessionId: toText(runtimeSessionId),
    role: toText(role) || 'primary',
    status: toText(status),
    summary: toText(summary),
    result: toText(result),
    error: toText(error),
    createdAt: toText(createdAt),
    updatedAt: toText(updatedAt)
  };
}

function normalizeExecutionRole(role = '') {
  return toText(role) || 'primary';
}

export class TaskExecutionService {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    workspaceStore = assistantWorkspaceStore,
    conversationStore = agentChannelConversationStore,
    stateCoordinator: stateCoordinatorArg = stateCoordinator
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.workspaceStore = workspaceStore;
    this.conversationStore = conversationStore;
    this.stateCoordinator = stateCoordinatorArg;
  }

  _ensureSupervisorTaskFromAssistantDomain({ taskId = '', sessionId = '' } = {}) {
    const normalizedTaskId = toText(taskId);
    const normalizedSessionId = toText(sessionId);
    const existing = normalizedTaskId ? this.supervisorTaskStore.get(normalizedTaskId) : null;
    if (existing?.id) {
      return existing;
    }

    const executionFromRuntime = normalizedSessionId && this.stateCoordinator?.executionStore?.findByRuntimeSessionId
      ? this.stateCoordinator.executionStore.findByRuntimeSessionId(normalizedSessionId)
      : null;
    const assistantTask = normalizedTaskId && this.stateCoordinator?.taskStore?.get
      ? this.stateCoordinator.taskStore.get(normalizedTaskId)
      : (executionFromRuntime?.taskId && this.stateCoordinator?.taskStore?.get
          ? this.stateCoordinator.taskStore.get(executionFromRuntime.taskId)
          : null);
    if (!assistantTask?.id) {
      return null;
    }

    const preferredExecutionId = toText(
      executionFromRuntime?.id
      || assistantTask.activeExecutionIds?.[assistantTask.activeExecutionIds.length - 1]
      || assistantTask.allExecutionIds?.[assistantTask.allExecutionIds.length - 1]
    );
    const assistantExecution = preferredExecutionId && this.stateCoordinator?.executionStore?.get
      ? this.stateCoordinator.executionStore.get(preferredExecutionId)
      : executionFromRuntime;
    const assistantProject = assistantTask.projectId && this.stateCoordinator?.projectStore?.get
      ? this.stateCoordinator.projectStore.get(assistantTask.projectId)
      : null;
    const runtimeSessionId = toText(
      normalizedSessionId
      || assistantExecution?.currentRuntimeSessionId
      || executionFromRuntime?.currentRuntimeSessionId
    );
    const runtimeSession = runtimeSessionId
      ? this.runtimeSessionManager.getSession(runtimeSessionId)
      : null;
    const executionHistory = Array.isArray(assistantExecution?.runtimeSessionHistory)
      ? assistantExecution.runtimeSessionHistory
      : [];

    return this.supervisorTaskStore.save({
      id: assistantTask.id,
      conversationId: toText(assistantTask.lastConversationId),
      lastConversationId: toText(assistantTask.lastConversationId),
      title: toText(assistantTask.title),
      goal: toText(assistantTask.goal),
      status: toText(runtimeSession?.status || assistantExecution?.status || assistantTask.lifecycleState || 'ready'),
      executorStrategy: toText(assistantExecution?.provider || runtimeSession?.provider),
      primaryExecutionId: runtimeSessionId,
      executionIds: [
        runtimeSessionId,
        ...executionHistory
      ].filter(Boolean),
      summary: toText(assistantTask.summary || assistantExecution?.lastTurnSummary || runtimeSession?.summary),
      error: toText(runtimeSession?.error),
      cwd: toText(assistantProject?.cwd || runtimeSession?.cwd),
      workspaceId: toText(assistantProject?.id || ''),
      metadata: {
        assistantPersonId: toText(assistantTask.ownerPersonId || assistantExecution?.ownerPersonId),
        assistantProjectId: toText(assistantProject?.id || assistantTask.projectId),
        assistantTaskId: assistantTask.id,
        assistantExecutionId: toText(assistantExecution?.id),
        latestExecutionId: runtimeSessionId,
        runtimeSessionId,
        provider: toText(assistantExecution?.provider || runtimeSession?.provider),
        originKind: 'assistant_domain_compat'
      }
    });
  }

  _resolveContinuationBinding({ taskId = '', sessionId = '' } = {}) {
    const normalizedTaskId = toText(taskId);
    const normalizedSessionId = toText(sessionId);
    const supervisorTask = normalizedTaskId
      ? (this.supervisorTaskStore.get(normalizedTaskId) || this._ensureSupervisorTaskFromAssistantDomain({
          taskId: normalizedTaskId,
          sessionId: normalizedSessionId
        }))
      : this._ensureSupervisorTaskFromAssistantDomain({
          taskId: '',
          sessionId: normalizedSessionId
        });
    const assistantExecutionId = toText(
      supervisorTask?.metadata?.assistantExecutionId
    );
    const assistantExecution = assistantExecutionId && this.stateCoordinator?.executionStore?.get
      ? this.stateCoordinator.executionStore.get(assistantExecutionId)
      : null;
    const runtimeSessionIdFromExecution = toText(assistantExecution?.currentRuntimeSessionId);
    const compatibilityExecution = !assistantExecution && normalizedSessionId && this.stateCoordinator?.executionStore?.findByRuntimeSessionId
      ? this.stateCoordinator.executionStore.findByRuntimeSessionId(normalizedSessionId)
      : null;
    const compatibilityExecutionId = toText(compatibilityExecution?.id);
    const compatibilityRuntimeSessionId = toText(compatibilityExecution?.currentRuntimeSessionId);
    const resolvedRuntimeSessionId = toText(
      runtimeSessionIdFromExecution
      || compatibilityRuntimeSessionId
      || supervisorTask?.metadata?.latestExecutionId
      || supervisorTask?.metadata?.runtimeSessionId
      || supervisorTask?.primaryExecutionId
      || normalizedSessionId
    );

    return {
      supervisorTask,
      assistantExecutionId: assistantExecutionId || compatibilityExecutionId,
      assistantExecution: assistantExecution || compatibilityExecution || null,
      runtimeSessionId: resolvedRuntimeSessionId
    };
  }

  _syncAssistantDomainTaskExecution({
    supervisorTask = null,
    session = null,
    input = '',
    cwd = '',
    conversationId = '',
    provider = '',
    role = 'primary',
    reuseExecutionId = '',
    assistantRationale = null
  } = {}) {
    if (!this.stateCoordinator || !supervisorTask?.id || !session?.id) {
      return null;
    }
    // Domain fact write path: supervisor/runtime compatibility data is dual-written into the assistant entities here.
    const synced = this.stateCoordinator.syncTaskExecutionBridge({
      supervisorTask,
      session,
      input,
      cwd,
      conversationId,
      provider,
      role,
      reuseExecutionId,
      assistantRationale
    });
    if (!synced) {
      return null;
    }

    const nextSupervisorTask = this.supervisorTaskStore.save({
      ...supervisorTask,
      metadata: {
        ...(supervisorTask.metadata || {}),
        assistantPersonId: synced.person.id,
        assistantProjectId: synced.project.id,
        assistantTaskId: synced.task.id,
        assistantExecutionId: synced.execution.id
      }
    });

    this.runtimeSessionManager.patchSession(session.id, {
      metadata: {
        ...(session.metadata || {}),
        assistantPersonId: synced.person.id,
        assistantProjectId: synced.project.id,
        assistantTaskId: synced.task.id,
        assistantExecutionId: synced.execution.id
      }
    });

    return {
      person: synced.person,
      project: synced.project,
      task: synced.task,
      execution: synced.execution,
      supervisorTask: nextSupervisorTask
    };
  }

  async startTaskExecution({
    taskId = '',
    conversationId = '',
    provider,
    input,
    cwd,
    model = '',
    role = 'primary',
    metadata = {}
  } = {}) {
    const normalizedTaskId = toText(taskId);
    const normalizedRole = normalizeExecutionRole(role);
    const normalizedSourceTaskId = toText(metadata?.sourceTaskId);
    const existingTask = normalizedTaskId ? this.supervisorTaskStore.get(normalizedTaskId) : null;
    const resolvedTaskId = normalizedTaskId || createSupervisorTask().id;
    const session = await this.runtimeSessionManager.createSession({
      provider,
      input,
      cwd,
      model,
      metadata: withDefaultRuntimeOptions(provider, {
        ...(metadata || {}),
        cwd,
        conversationId,
        taskId: resolvedTaskId,
        executionRole: normalizedRole,
        executionId: undefined
      })
    });
    const execution = buildExecutionRecord({
      taskId: normalizedTaskId,
      executionId: '',
      runtimeSessionId: session.id,
      executor: session.provider,
      role: normalizedRole,
      status: session.status,
      summary: session.summary,
      error: session.error,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt
    });

    if (conversationId || normalizedTaskId || normalizedSourceTaskId) {
      const normalizedWorkspaceRef = normalizeWorkspaceRef(session.cwd || cwd);
      const workspace = normalizedWorkspaceRef
        ? syncWorkspaceTaskBinding(this.workspaceStore, normalizedWorkspaceRef, {
            taskId: resolvedTaskId,
            provider: session.provider,
            summary: session.title || input,
            taskStatus: session.status,
            timestamp: session.updatedAt || session.createdAt,
            metadata: {
              source: 'task_execution_start'
            }
          })
        : null;
      const supervisorTask = this.supervisorTaskStore.upsertForRuntime({
        taskId: resolvedTaskId,
        conversationId,
        runtimeSessionId: session.id,
        provider: session.provider,
        title: session.title || input,
        goal: input,
        status: session.status,
        sourceTaskId: normalizedSourceTaskId,
        cwd: session.cwd || cwd,
        workspaceId: workspace?.id || '',
        intent: input,
        lastConversationId: conversationId,
        metadata: {
          taskId: normalizedTaskId,
          conversationId: toText(conversationId),
          executionRole: normalizedRole,
          primaryExecutionId: normalizedRole === 'primary'
            ? session.id
            : toText(existingTask?.primaryExecutionId || ''),
          latestExecutionId: session.id,
          workspaceId: workspace?.id || '',
          executionKind: 'runtime_session',
          originKind: toText(metadata?.originKind),
          runtimeSessionId: session.id,
          provider: session.provider
        }
      });
      this.runtimeSessionManager.patchSession(session.id, {
        metadata: {
          ...(session.metadata || {}),
          taskId: supervisorTask.id,
          conversationId: toText(conversationId || session.metadata?.conversationId || ''),
          executionRole: normalizedRole,
          ...(workspace?.id ? { workspaceId: workspace.id } : {})
        }
        });
      if (workspace?.id && supervisorTask?.metadata?.workspaceId !== workspace.id) {
        this.supervisorTaskStore.save({
          ...supervisorTask,
          metadata: {
            ...(supervisorTask.metadata || {}),
            workspaceId: workspace.id
          }
        });
      }
      if (existingTask?.id && normalizedRole !== 'primary') {
        this.supervisorTaskStore.save({
          ...supervisorTask,
          primaryExecutionId: existingTask.primaryExecutionId || supervisorTask.primaryExecutionId,
          executionIds: [...new Set([...(existingTask.executionIds || []), ...(supervisorTask.executionIds || []), session.id])]
        });
      }
      this._syncAssistantDomainTaskExecution({
        supervisorTask: this.supervisorTaskStore.get(supervisorTask.id) || supervisorTask,
        session,
        input,
        cwd,
        conversationId,
        provider: session.provider,
        role: normalizedRole,
        assistantRationale: {
          routeReason: 'dual-write from task execution start',
          candidateEvidence: [
            `supervisorTaskId:${supervisorTask.id}`,
            `runtimeSessionId:${session.id}`,
            `role:${normalizedRole}`
          ]
        }
      });
      const syncedTask = this.supervisorTaskStore.get(supervisorTask.id) || supervisorTask;
      const syncedExecutionId = toText(syncedTask?.metadata?.assistantExecutionId);
      execution.executionId = syncedExecutionId || execution.executionId;
      execution.taskId = syncedTask.id;
      this.stateCoordinator?.recordRuntimeEpisode?.({
        kind: 'runtime.session_spawned',
        conversationId,
        runtimeSessionId: session.id,
        executionId: syncedExecutionId || '',
        payload: {
          provider: toText(session.provider),
          role: normalizedRole,
          reason: 'task_execution_start',
          taskId: syncedTask.id
        },
        metadata: {
          source: 'task_execution_service'
        }
      });
    }

    return {
      ...session,
      execution
    };
  }

  async continueTaskExecution({
    taskId = '',
    sessionId = '',
    input
  } = {}) {
    const normalizedTaskId = toText(taskId);
    const normalizedSessionId = toText(sessionId);
    const binding = this._resolveContinuationBinding({
      taskId: normalizedTaskId,
      sessionId: normalizedSessionId
    });
    const task = binding.supervisorTask;
    const resolvedSessionId = binding.runtimeSessionId;
    if (!resolvedSessionId) {
      throw new Error('task execution target is required');
    }

    const existingSession = this.runtimeSessionManager.getSession(resolvedSessionId);
    const sessionStatus = toText(existingSession?.status).toLowerCase();
    const cancelledOrMissing = !existingSession || sessionStatus === 'cancelled';

    if (!cancelledOrMissing) {
      try {
        const session = await this.runtimeSessionManager.sendInput(resolvedSessionId, input);
        const currentTask = normalizedTaskId ? this.supervisorTaskStore.get(normalizedTaskId) : task;
        if (currentTask?.id) {
          const currentAssistantExecutionId = toText(
            currentTask?.metadata?.assistantExecutionId
            || binding.assistantExecutionId
          );
          this._syncAssistantDomainTaskExecution({
            supervisorTask: currentTask,
            session,
            input,
            cwd: currentTask.cwd || session.cwd || '',
            conversationId: currentTask.lastConversationId || currentTask.conversationId || '',
            provider: session.provider,
            role: normalizeExecutionRole(currentTask?.metadata?.executionRole),
            reuseExecutionId: currentAssistantExecutionId,
            assistantRationale: {
              routeReason: 'dual-write from task execution continue',
              candidateEvidence: [
                `supervisorTaskId:${currentTask.id}`,
                `runtimeSessionId:${session.id}`
              ]
            }
          });
        }
        return {
          ...session,
          execution: buildExecutionRecord({
            taskId: normalizedTaskId || toText(task?.id),
            executionId: binding.assistantExecutionId,
            runtimeSessionId: resolvedSessionId,
            executor: session.provider,
            role: normalizeExecutionRole(task?.metadata?.executionRole),
            status: session.status,
            summary: session.summary,
            error: session.error,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt
          })
        };
      } catch (error) {
        const message = String(error?.message || '');
        // Only fall back when the session record itself is gone.
        // 'session is already running' / quota / spawn failures should propagate.
        if (!/session not found/i.test(message)) {
          throw error;
        }
      }
    }

    // Dead-session fallback (§8.4 B path): spawn a new session bound to the same task.
    if (!task?.id) {
      throw new Error('task not found; cannot start fallback session');
    }

    const provider = toText(
      task.executorStrategy
      || task?.metadata?.provider
      || existingSession?.provider
    );
    if (!provider) {
      throw new Error('cannot determine provider for fallback session');
    }

    const cwd = toText(task.cwd || task?.metadata?.cwd || existingSession?.cwd || '');
    const model = toText(task?.metadata?.model || existingSession?.model || '');
    const conversationId = toText(task.lastConversationId || task.conversationId || '');
    const priorOutcome = toText(
      task?.postmortem?.outcome
      || task.summary
      || task.result
    );
    const taskTitle = toText(task.title || task.goal || task.id);
    const inputBody = toText(input);
    const prefixedInput = priorOutcome
      ? `[Resuming task: ${taskTitle}]\nPrior outcome (last session ${resolvedSessionId}):\n${priorOutcome}\n\nCurrent request:\n${inputBody}`
      : inputBody;

    const fallbackSession = await this.runtimeSessionManager.createSession({
      provider,
      input: prefixedInput,
      cwd,
      model,
      metadata: withDefaultRuntimeOptions(provider, {
        taskId: task.id,
        sourceTaskId: task.id,
        conversationId,
        executionRole: 'fallback',
        originKind: 'remembered_follow_up',
        cwd
      })
    });

    const reusedAssistantExecutionId = toText(task?.metadata?.assistantExecutionId || binding.assistantExecutionId);
    const updatedTask = this.supervisorTaskStore.save({
      ...task,
      lastUpdateAt: new Date().toISOString(),
      metadata: {
        ...(task.metadata || {}),
        latestExecutionId: fallbackSession.id,
        runtimeSessionId: fallbackSession.id
      }
    });
    this._syncAssistantDomainTaskExecution({
      supervisorTask: updatedTask,
      session: fallbackSession,
      input,
      cwd,
      conversationId,
      provider: fallbackSession.provider,
      role: 'fallback',
      reuseExecutionId: reusedAssistantExecutionId,
      assistantRationale: {
        routeReason: 'dual-write from fallback execution continue',
        candidateEvidence: [
          `supervisorTaskId:${updatedTask.id}`,
          `runtimeSessionId:${fallbackSession.id}`,
          `reusedExecution:${toText(task?.metadata?.assistantExecutionId)}`
        ]
      }
    });
    this.stateCoordinator?.recordRuntimeEpisode?.({
      kind: 'execution_runtime_session_swapped',
      conversationId,
      runtimeSessionId: fallbackSession.id,
      executionId: reusedAssistantExecutionId,
      taskId: updatedTask.id,
      payload: {
        fromRuntimeSessionId: resolvedSessionId,
        toRuntimeSessionId: fallbackSession.id,
        provider: toText(fallbackSession.provider),
        reason: cancelledOrMissing ? (existingSession ? 'cancelled_session_fallback' : 'missing_session_fallback') : 'respawn_fallback'
      },
      metadata: {
        source: 'task_execution_service'
      }
    });

    return {
      ...fallbackSession,
      execution: buildExecutionRecord({
        taskId: updatedTask.id,
        executionId: reusedAssistantExecutionId,
        runtimeSessionId: fallbackSession.id,
        executor: fallbackSession.provider,
        role: 'fallback',
        status: fallbackSession.status,
        summary: fallbackSession.summary,
        error: fallbackSession.error,
        createdAt: fallbackSession.createdAt,
        updatedAt: fallbackSession.updatedAt
      })
    };
  }
}

export const taskExecutionService = new TaskExecutionService();

export default taskExecutionService;
