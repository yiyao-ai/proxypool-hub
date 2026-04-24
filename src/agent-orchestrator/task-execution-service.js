import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import supervisorTaskStore from './supervisor-task-store.js';

function toText(value) {
  return String(value || '').trim();
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
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.supervisorTaskStore = supervisorTaskStoreArg;
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
    const existingTask = normalizedTaskId ? this.supervisorTaskStore.get(normalizedTaskId) : null;
    const session = await this.runtimeSessionManager.createSession({
      provider,
      input,
      cwd,
      model,
      metadata: withDefaultRuntimeOptions(provider, {
        ...(metadata || {}),
        cwd,
        conversationId,
        taskId: normalizedTaskId || undefined,
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

    if (conversationId || normalizedTaskId) {
      const supervisorTask = this.supervisorTaskStore.upsertForRuntime({
        taskId: normalizedTaskId,
        conversationId,
        runtimeSessionId: session.id,
        provider: session.provider,
        title: session.title || input,
        goal: input,
        status: session.status,
        metadata: {
          taskId: normalizedTaskId,
          conversationId: toText(conversationId),
          executionRole: normalizedRole,
          primaryExecutionId: normalizedRole === 'primary'
            ? session.id
            : toText(existingTask?.primaryExecutionId || ''),
          latestExecutionId: session.id,
          executionKind: 'runtime_session',
          originKind: toText(metadata?.originKind),
          runtimeSessionId: session.id,
          provider: session.provider
        }
      });
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
  }
}

export const taskExecutionService = new TaskExecutionService();

export default taskExecutionService;
