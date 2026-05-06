import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import supervisorTaskStore from './supervisor-task-store.js';
import assistantWorkspaceStore from '../assistant-core/workspace-store.js';
import { createSupervisorTask } from './supervisor-task-store.js';
import { normalizeWorkspaceRef } from '../assistant-core/workspace-store.js';

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
    executionId: toText(executionId || runtimeSessionId),
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

export class TaskExecutionService {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    workspaceStore = assistantWorkspaceStore
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.workspaceStore = workspaceStore;
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
    const normalizedRole = toText(role) || 'primary';
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
      executionId: session.id,
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
    const task = normalizedTaskId ? this.supervisorTaskStore.get(normalizedTaskId) : null;
    const resolvedSessionId = toText(task?.primaryExecutionId || normalizedSessionId);
    if (!resolvedSessionId) {
      throw new Error('task execution target is required');
    }

    const existingSession = this.runtimeSessionManager.getSession(resolvedSessionId);
    const sessionStatus = toText(existingSession?.status).toLowerCase();
    const cancelledOrMissing = !existingSession || sessionStatus === 'cancelled';

    if (!cancelledOrMissing) {
      try {
        const session = await this.runtimeSessionManager.sendInput(resolvedSessionId, input);
        return {
          ...session,
          execution: buildExecutionRecord({
            taskId: normalizedTaskId || toText(task?.id),
            executionId: resolvedSessionId,
            runtimeSessionId: resolvedSessionId,
            executor: session.provider,
            role: normalizedTaskId && task?.primaryExecutionId === resolvedSessionId ? 'primary' : '',
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

    const updatedTask = this.supervisorTaskStore.save({
      ...task,
      executionIds: [...new Set([...(task.executionIds || []), fallbackSession.id])],
      lastUpdateAt: new Date().toISOString(),
      metadata: {
        ...(task.metadata || {}),
        latestExecutionId: fallbackSession.id,
        runtimeSessionId: fallbackSession.id
      }
    });

    return {
      ...fallbackSession,
      execution: buildExecutionRecord({
        taskId: updatedTask.id,
        executionId: fallbackSession.id,
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
