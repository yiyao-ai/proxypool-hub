import chatUiConversationStore from '../chat-ui/conversation-store.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentTaskStore from '../agent-core/task-store.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import assistantRunStore from './run-store.js';
import assistantDomainTaskStore from './domain/task-store.js';
import assistantDomainExecutionStore from './domain/execution-store.js';
import assistantDomainProjectStore from './domain/project-store.js';
import { getAssistantControlMode } from './assistant-state.js';
import { buildTrackedSupervisorSessionIds, buildTrackedSupervisorTaskIds } from '../agent-orchestrator/supervisor-task-memory.js';
import supervisorTaskStore from '../agent-orchestrator/supervisor-task-store.js';
import {
  resolvePendingApprovalSessionId,
  resolvePendingQuestionSessionId
} from './pending-runtime-state.js';

function toText(value) {
  return String(value || '').trim();
}

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function summarizeConversation(conversation = null) {
  if (!conversation?.id) return null;
  const brief = conversation?.metadata?.supervisor?.brief || {};
  const workingSet = conversation?.metadata?.assistantDomain?.workingSet || {};
  const assistantState = conversation?.metadata?.assistantCore || {};
  const trackedTaskIds = [...new Set([
    ...buildTrackedSupervisorTaskIds(conversation?.metadata?.supervisor?.taskMemory || null),
    String(workingSet?.primaryTaskId || '').trim()
  ].filter(Boolean))];
  return {
    id: conversation.id,
    channel: conversation.channel || '',
    title: conversation.title || '',
    activeRuntimeSessionId: conversation.activeRuntimeSessionId || null,
    activeTaskId: conversation?.metadata?.supervisor?.taskMemory?.activeTaskId || brief.taskId || workingSet.primaryTaskId || null,
    trackedTaskIds,
    assistantMode: getAssistantControlMode(conversation),
    assistantSessionId: assistantState.assistantSessionId || null,
    assistantLastRunId: assistantState.lastRunId || null,
    runtimeStatus: brief.status || '',
    runtimeSummary: brief.summary || '',
    waitingReason: brief.waitingReason || '',
    nextSuggestion: brief.nextSuggestion || '',
    updatedAt: conversation.updatedAt || ''
  };
}

function summarizeRuntimeSession(session = null, latestTurn = null) {
  if (!session?.id) return null;
  return {
    id: session.id,
    provider: session.provider || '',
    providerLabel: providerLabel(session.provider),
    status: session.status || '',
    title: session.title || '',
    summary: session.summary || '',
    error: session.error || '',
    turnCount: Number(session.turnCount || 0),
    currentTurnId: session.currentTurnId || null,
    latestTurnId: latestTurn?.id || null,
    updatedAt: session.updatedAt || ''
  };
}

function summarizeTurn(turn = null) {
  if (!turn?.id) return null;
  return {
    id: turn.id,
    status: turn.status || '',
    input: turn.input || '',
    summary: turn.summary || '',
    error: turn.error || '',
    eventCount: Number(turn.eventCount || 0),
    stats: {
      messageCount: Number(turn?.stats?.messageCount || 0),
      commandCount: Number(turn?.stats?.commandCount || 0),
      fileChangeCount: Number(turn?.stats?.fileChangeCount || 0),
      approvalCount: Number(turn?.stats?.approvalCount || 0),
      approvalResolvedCount: Number(turn?.stats?.approvalResolvedCount || 0),
      questionCount: Number(turn?.stats?.questionCount || 0),
      failureCount: Number(turn?.stats?.failureCount || 0),
      lastMessage: turn?.stats?.lastMessage || ''
    },
    startedAt: turn.startedAt || '',
    completedAt: turn.completedAt || '',
    updatedAt: turn.updatedAt || ''
  };
}

function summarizeAssistantRun(run = null) {
  if (!run?.id) return null;
  return {
    id: run.id,
    assistantSessionId: run.assistantSessionId || '',
    conversationId: run.conversationId || '',
    triggerText: run.triggerText || '',
    mode: run.mode || '',
    status: run.status || '',
    summary: run.summary || '',
    result: run.result || '',
    relatedRuntimeSessionIds: Array.isArray(run.relatedRuntimeSessionIds) ? run.relatedRuntimeSessionIds : [],
    checkpoint: run?.metadata?.checkpoint && typeof run.metadata.checkpoint === 'object'
      ? {
          resumable: run.metadata.checkpoint.resumable === true,
          completedStepCount: Number(run.metadata.checkpoint.completedStepCount || 0),
          pendingStepCount: Number(run.metadata.checkpoint.pendingStepCount || 0),
          updatedAt: run.metadata.checkpoint.updatedAt || ''
        }
      : null,
    updatedAt: run.updatedAt || ''
  };
}

function chooseLatestByUpdatedAt(entries = []) {
  return [...entries]
    .filter(Boolean)
    .sort((left, right) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')))[0] || null;
}

function normalizeSupervisorStoreTask(task = null) {
  if (!task?.id) return null;
  return {
    id: task.id,
    conversationId: task.conversationId || '',
    runtimeSessionId: task.metadata?.runtimeSessionId || task.primaryExecutionId || '',
    primaryExecutionId: task.primaryExecutionId || '',
    latestExecutionId: task.metadata?.latestExecutionId || task.metadata?.runtimeSessionId || task.primaryExecutionId || '',
    provider: task.executorStrategy || task.metadata?.provider || '',
    title: task.title || '',
    status: task.status || '',
    input: task.goal || '',
    summary: task.summary || '',
    result: task.result || '',
    error: task.error || '',
    cwd: task.cwd || '',
    cwdBasename: task.cwdBasename || '',
    lastConversationId: task.lastConversationId || task.conversationId || '',
    originKind: task.metadata?.originKind || '',
    sourceTaskId: task.sourceTaskId || task.metadata?.sourceTaskId || '',
    metadata: task.metadata && typeof task.metadata === 'object'
      ? { ...task.metadata }
      : {},
    updatedAt: task.updatedAt || task.lastUpdateAt || ''
  };
}

function buildAssistantRunIndex(runs = []) {
  const latestByConversationId = new Map();
  const runsByConversationId = new Map();
  for (const run of runs) {
    const conversationId = toText(run?.conversationId);
    if (!conversationId) {
      continue;
    }
    if (!latestByConversationId.has(conversationId)) {
      latestByConversationId.set(conversationId, run);
    }
    if (!runsByConversationId.has(conversationId)) {
      runsByConversationId.set(conversationId, []);
    }
    runsByConversationId.get(conversationId).push(run);
  }
  return {
    latestByConversationId,
    runsByConversationId
  };
}

function buildRelatedRuntimeSessionIdSet({ task = null, runtimeSession = null } = {}) {
  return new Set([
    toText(task?.runtimeSessionId),
    toText(task?.latestExecutionId),
    toText(task?.primaryExecutionId),
    toText(runtimeSession?.id)
  ].filter(Boolean));
}

function resolveAssistantRunForTask({
  conversation = null,
  task = null,
  runtimeSession = null,
  assistantRunIndex = null
} = {}) {
  const conversationId = toText(conversation?.id);
  if (!conversationId) {
    return null;
  }

  const runsByConversationId = assistantRunIndex?.runsByConversationId || new Map();
  const latestByConversationId = assistantRunIndex?.latestByConversationId || new Map();
  const conversationRuns = runsByConversationId.get(conversationId) || [];
  const preferredRunId = toText(conversation?.metadata?.assistantCore?.lastRunId);
  const preferredRun = preferredRunId
    ? conversationRuns.find((entry) => entry.id === preferredRunId) || null
    : null;
  const relatedRuntimeSessionIds = buildRelatedRuntimeSessionIdSet({ task, runtimeSession });

  if (relatedRuntimeSessionIds.size > 0) {
    if (preferredRun) {
      const preferredRelated = Array.isArray(preferredRun.relatedRuntimeSessionIds)
        ? preferredRun.relatedRuntimeSessionIds.some((sessionId) => relatedRuntimeSessionIds.has(toText(sessionId)))
        : false;
      if (preferredRelated) {
        return preferredRun;
      }
    }

    const matchedRun = conversationRuns.find((entry) => (
      Array.isArray(entry?.relatedRuntimeSessionIds)
      && entry.relatedRuntimeSessionIds.some((sessionId) => relatedRuntimeSessionIds.has(toText(sessionId)))
    ));
    if (matchedRun) {
      return matchedRun;
    }
    return null;
  }

  if (!task && preferredRun) {
    return preferredRun;
  }
  if (!task && conversationRuns.length === 1) {
    return conversationRuns[0];
  }
  if (!task) {
    return latestByConversationId.get(conversationId) || null;
  }
  return null;
}

function chooseTaskFromSupervisorMemory(taskMemory = null, persistedTasks = []) {
  const currentTask = taskMemory?.currentTask || taskMemory?.current || null;
  if (currentTask?.sessionId) {
    const matched = persistedTasks.find((entry) => entry.runtimeSessionId === currentTask.sessionId);
    if (matched) return matched;
  }
  if (currentTask?.taskId || currentTask?.sessionId) {
    return {
      id: currentTask.taskId || currentTask.sessionId,
      conversationId: '',
      runtimeSessionId: currentTask.sessionId || '',
      provider: currentTask.provider || '',
      title: currentTask.title || '',
      status: currentTask.status || '',
      input: '',
      summary: currentTask.summary || '',
      result: currentTask.result || '',
      error: currentTask.error || '',
      originKind: currentTask.originKind || '',
      updatedAt: currentTask.lastUpdateAt || ''
    };
  }
  return chooseLatestByUpdatedAt(persistedTasks);
}

function buildAssistantDomainTaskRecord({
  assistantTask = null,
  assistantExecution = null,
  assistantProject = null,
  runtimeSession = null
} = {}) {
  if (!assistantTask?.id) return null;
  return {
    id: assistantTask.id,
    conversationId: assistantTask.lastConversationId || '',
    runtimeSessionId: assistantExecution?.currentRuntimeSessionId || runtimeSession?.id || '',
    primaryExecutionId: assistantExecution?.currentRuntimeSessionId || runtimeSession?.id || '',
    latestExecutionId: assistantExecution?.currentRuntimeSessionId || runtimeSession?.id || '',
    provider: assistantExecution?.provider || runtimeSession?.provider || '',
    title: assistantTask.title || '',
    status: runtimeSession?.status || assistantExecution?.status || assistantTask.lifecycleState || '',
    input: assistantTask.goal || '',
    summary: assistantTask.summary || assistantExecution?.lastTurnSummary || runtimeSession?.summary || '',
    result: '',
    error: runtimeSession?.error || '',
    cwd: assistantProject?.cwd || runtimeSession?.cwd || '',
    cwdBasename: '',
    lastConversationId: assistantTask.lastConversationId || '',
    originKind: '',
    sourceTaskId: '',
    metadata: {
      assistantProjectId: assistantProject?.id || assistantTask.projectId || '',
      assistantTaskId: assistantTask.id,
      assistantExecutionId: assistantExecution?.id || ''
    },
    updatedAt: runtimeSession?.updatedAt || assistantExecution?.updatedAt || assistantTask.updatedAt || ''
  };
}

function summarizeTask(task = null) {
  if (!task?.id) return null;
  return {
    id: task.id,
    conversationId: task.conversationId || '',
    runtimeSessionId: task.runtimeSessionId || '',
    primaryExecutionId: task.primaryExecutionId || task.runtimeSessionId || '',
    latestExecutionId: task.latestExecutionId || task.runtimeSessionId || '',
    provider: task.provider || '',
    title: task.title || '',
    status: task.status || '',
    input: task.input || '',
    summary: task.summary || '',
    result: task.result || '',
    error: task.error || '',
    cwd: task.cwd || '',
    cwdBasename: task.cwdBasename || '',
    lastConversationId: task.lastConversationId || task.conversationId || '',
    originKind: task.originKind || '',
    sourceTaskId: task.sourceTaskId || '',
    metadata: task.metadata && typeof task.metadata === 'object'
      ? { ...task.metadata }
      : {},
    updatedAt: task.updatedAt || ''
  };
}

function summarizeAssistantDomainTask(task = null) {
  if (!task?.id) return null;
  return {
    id: task.id,
    projectId: task.projectId || '',
    ownerPersonId: task.ownerPersonId || '',
    title: task.title || '',
    goal: task.goal || '',
    summary: task.summary || '',
    lifecycleState: task.lifecycleState || '',
    activeExecutionIds: Array.isArray(task.activeExecutionIds) ? task.activeExecutionIds : [],
    allExecutionIds: Array.isArray(task.allExecutionIds) ? task.allExecutionIds : [],
    lastConversationId: task.lastConversationId || '',
    updatedAt: task.updatedAt || ''
  };
}

function summarizeAssistantDomainExecution(execution = null) {
  if (!execution?.id) return null;
  return {
    id: execution.id,
    taskId: execution.taskId || '',
    provider: execution.provider || '',
    role: execution.role || '',
    status: execution.status || '',
    objective: execution.objective || '',
    currentRuntimeSessionId: execution.currentRuntimeSessionId || '',
    providerSessionId: execution.providerSessionId || '',
    lastTurnSummary: execution.lastTurnSummary || '',
    lastInputPreview: execution.lastInputPreview || '',
    updatedAt: execution.updatedAt || ''
  };
}

function summarizeAssistantDomainProject(project = null) {
  if (!project?.id) return null;
  return {
    id: project.id,
    ownerPersonId: project.ownerPersonId || '',
    name: project.name || '',
    kind: project.kind || '',
    cwd: project.cwd || '',
    summary: project.summary || '',
    updatedAt: project.updatedAt || ''
  };
}

function summarizeDelivery(delivery = null) {
  if (!delivery?.id) return null;
  return {
    id: delivery.id,
    direction: delivery.direction || '',
    status: delivery.status || '',
    text: toText(delivery?.payload?.fullText || delivery?.payload?.text || delivery?.payload?.summary || ''),
    createdAt: delivery.createdAt || '',
    updatedAt: delivery.updatedAt || ''
  };
}

function deriveState({ assistantRun, runtimeSession, latestTurn, task, conversation }) {
  return (
    assistantRun?.status
    || runtimeSession?.status
    || latestTurn?.status
    || task?.status
    || conversation?.runtimeStatus
    || 'idle'
  );
}

function deriveWaitingReason({ conversation, runtimeDetail }) {
  if (conversation?.waitingReason) {
    return conversation.waitingReason;
  }
  if ((runtimeDetail?.pendingApprovals || []).length > 0) {
    return `approval: ${runtimeDetail.pendingApprovals[0]?.title || 'pending approval'}`;
  }
  if ((runtimeDetail?.pendingQuestions || []).length > 0) {
    return `user input: ${runtimeDetail.pendingQuestions[0]?.text || 'pending question'}`;
  }
  return '';
}

function deriveSummary({ assistantRun, latestTurn, runtimeSession, task, conversation }) {
  return (
    toText(assistantRun?.summary)
    || toText(latestTurn?.summary)
    || toText(task?.summary)
    || toText(runtimeSession?.summary)
    || toText(conversation?.runtimeSummary)
    || ''
  );
}

function deriveResultPreview({ assistantRun, task, latestTurn, latestDelivery }) {
  return (
    toText(assistantRun?.result)
    || toText(task?.result)
    || toText(latestTurn?.stats?.lastMessage)
    || toText(latestDelivery?.text)
    || ''
  );
}

function deriveLastUserVisibleMessage(deliveries = []) {
  const outbound = [...deliveries]
    .filter((entry) => entry?.direction === 'outbound')
    .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')));
  return summarizeDelivery(outbound[0] || null);
}

function isTerminalTaskState(state = '') {
  return ['completed', 'failed', 'cancelled'].includes(String(state || '').trim());
}

function buildTaskRelationshipSummary(record = null) {
  const task = record?.task || null;
  if (!task?.id) return '';
  if (task.originKind === 'retry_task') {
    return task.sourceTaskId
      ? `This task is a retry of source task ${task.sourceTaskId}.`
      : 'This task is a retry execution.';
  }
  if (task.originKind === 'return_to_source') {
    return task.sourceTaskId
      ? `This task returns to source task ${task.sourceTaskId}.`
      : 'This task returns to an earlier source task.';
  }
  if (task.originKind === 'related_sibling') {
    return task.sourceTaskId
      ? `This task is a related sibling derived from source task ${task.sourceTaskId}.`
      : 'This task is a related sibling task.';
  }
  if (task.originKind === 'remembered_follow_up') {
    return task.sourceTaskId
      ? `This task continues remembered work linked to source task ${task.sourceTaskId}.`
      : 'This task continues remembered work from the conversation.';
  }
  return '';
}

function buildFocusTaskReason({
  focusTask = null,
  waitingTasks = [],
  activeTasks = [],
  currentTaskId = ''
} = {}) {
  if (!focusTask) return '';
  if (focusTask.taskId && focusTask.taskId === String(currentTaskId || '').trim()) {
    return 'This is the current focus task from supervisor memory.';
  }
  if (waitingTasks.length === 1 && waitingTasks[0]?.taskId === focusTask.taskId) {
    return 'This task is focused because it is the only waiting task.';
  }
  if (activeTasks[0]?.taskId === focusTask.taskId) {
    return 'This task is focused because it is the most relevant active task.';
  }
  if (['completed', 'failed', 'cancelled'].includes(String(focusTask.state || '').trim())) {
    return 'This task is focused because no active task is available and it is the most relevant recent task. Recent completed tasks can still be the default follow-up target when the user is continuing the same workflow with different parameters.';
  }
  return 'This task is the current best candidate for follow-up.';
}

function buildExecutionContinuity(record = null) {
  if (!record) {
    return {
      preferredRuntimeSessionId: '',
      preferredAssistantExecutionId: '',
      preferredTaskExecutionId: '',
      source: 'none',
      canContinue: false,
      reason: 'No execution target is available for continuation.'
    };
  }

  const assistantExecution = record?.assistantDomain?.execution || null;
  const latestExecutionId = String(record?.task?.latestExecutionId || '').trim();
  const primaryExecutionId = String(record?.task?.primaryExecutionId || '').trim();
  const runtimeSessionId = String(record?.runtimeSession?.id || record?.task?.runtimeSessionId || '').trim();
  const assistantRuntimeSessionId = String(assistantExecution?.currentRuntimeSessionId || '').trim();
  const assistantExecutionId = String(assistantExecution?.id || '').trim();

  if (assistantRuntimeSessionId) {
    return {
      preferredRuntimeSessionId: assistantRuntimeSessionId,
      preferredAssistantExecutionId: assistantExecutionId,
      preferredTaskExecutionId: assistantExecutionId,
      source: 'assistant_execution_runtime',
      canContinue: true,
      reason: 'Assistant domain execution points to the latest runtime session for this task.'
    };
  }

  if (latestExecutionId) {
    return {
      preferredRuntimeSessionId: latestExecutionId,
      preferredAssistantExecutionId: assistantExecutionId,
      preferredTaskExecutionId: assistantExecutionId,
      source: 'task_latest_execution',
      canContinue: true,
      reason: primaryExecutionId && primaryExecutionId !== latestExecutionId
        ? 'Task metadata exposes a newer execution than the primary execution, so continue the latest execution.'
        : 'Task metadata exposes a latest execution target for continuation.'
    };
  }

  if (runtimeSessionId) {
    return {
      preferredRuntimeSessionId: runtimeSessionId,
      preferredAssistantExecutionId: assistantExecutionId,
      preferredTaskExecutionId: assistantExecutionId,
      source: 'runtime_session',
      canContinue: true,
      reason: 'The runtime session linked to this task is the best continuation target.'
    };
  }

  if (primaryExecutionId) {
    return {
      preferredRuntimeSessionId: primaryExecutionId,
      preferredAssistantExecutionId: assistantExecutionId,
      preferredTaskExecutionId: assistantExecutionId,
      source: 'task_primary_execution',
      canContinue: true,
      reason: 'Only the primary execution is available, so use it as the continuation target.'
    };
  }

  if (assistantExecutionId) {
    return {
      preferredRuntimeSessionId: '',
      preferredAssistantExecutionId: assistantExecutionId,
      preferredTaskExecutionId: '',
      source: 'assistant_execution_only',
      canContinue: false,
      reason: 'Assistant domain execution exists, but it is not linked to a live runtime session.'
    };
  }

  return {
    preferredRuntimeSessionId: '',
    preferredAssistantExecutionId: '',
    preferredTaskExecutionId: '',
    source: 'none',
    canContinue: false,
    reason: 'No execution target is available for continuation.'
  };
}

function buildDecisionHints({ focusTask = null, waitingTasks = [], activeTasks = [] } = {}) {
  const shouldClarify = activeTasks.length > 1 && waitingTasks.length !== 1 && !focusTask;
  let preferredAction = 'inspect_task_space';
  let reason = 'Inspect task space before choosing a task.';
  let preferredTaskId = '';
  const focusTaskExecutionContinuity = buildExecutionContinuity(focusTask);
  const focusTaskState = String(focusTask?.state || '').trim();
  const focusTaskIsRecentCompleted = ['completed', 'failed', 'cancelled'].includes(focusTaskState);

  if (waitingTasks.length === 1) {
    preferredAction = 'continue_waiting_task';
    preferredTaskId = waitingTasks[0]?.taskId || '';
    reason = 'There is exactly one waiting task, so it should be handled first.';
  } else if (focusTask) {
    preferredAction = 'continue_focus_task';
    preferredTaskId = focusTask.taskId || '';
    reason = focusTaskIsRecentCompleted
      ? 'No active task is available, so the most relevant recent task should still be reused by default for follow-up, including same-workflow requests with different parameters.'
      : 'A focus task is available and is the best default task for follow-up.';
  } else if (activeTasks.length > 1) {
    preferredAction = 'clarify_task';
    reason = 'There are multiple active tasks and no single clear task to continue safely.';
  } else if (activeTasks.length === 1) {
    preferredAction = 'continue_active_task';
    preferredTaskId = activeTasks[0]?.taskId || '';
    reason = 'There is one active task, so it is the default continuation candidate.';
  }

  return {
    shouldClarify,
    preferredAction,
    preferredTaskId,
    reason,
    shouldPreferStatusOverview: activeTasks.length > 1,
    shouldPreferWaitingTask: waitingTasks.length === 1,
    shouldReuseFocusTask: Boolean(focusTask?.taskId),
    shouldReuseRecentCompletedTask: focusTaskIsRecentCompleted,
    waitingTaskCount: waitingTasks.length,
    activeTaskCount: activeTasks.length,
    focusTaskRelationship: buildTaskRelationshipSummary(focusTask),
    focusTaskExecutionTarget: focusTaskExecutionContinuity.preferredRuntimeSessionId,
    focusTaskExecutionContinuity
  };
}

export class AssistantTaskViewService {
  constructor({
    conversationStore = chatUiConversationStore,
    runtimeSessionManager = agentRuntimeSessionManager,
    taskStore = agentTaskStore,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    deliveryStore = agentChannelDeliveryStore,
    assistantRunStore: runStore = assistantRunStore,
    assistantTaskStore = assistantDomainTaskStore,
    assistantExecutionStore = assistantDomainExecutionStore,
    assistantProjectStore = assistantDomainProjectStore
  } = {}) {
    this.conversationStore = conversationStore;
    this.runtimeSessionManager = runtimeSessionManager;
    this.taskStore = taskStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.deliveryStore = deliveryStore;
    this.assistantRunStore = runStore;
    this.assistantTaskStore = assistantTaskStore;
    this.assistantExecutionStore = assistantExecutionStore;
    this.assistantProjectStore = assistantProjectStore;
  }

  _buildAssistantDomainLink(task = null) {
    const metadata = task?.metadata && typeof task.metadata === 'object'
      ? task.metadata
      : {};
    const assistantTask = metadata.assistantTaskId
      ? this.assistantTaskStore?.get?.(metadata.assistantTaskId) || null
      : null;
    const assistantExecution = metadata.assistantExecutionId
      ? this.assistantExecutionStore?.get?.(metadata.assistantExecutionId) || null
      : null;
    const assistantProject = metadata.assistantProjectId
      ? this.assistantProjectStore?.get?.(metadata.assistantProjectId) || null
      : null;

    if (!assistantTask && !assistantExecution && !assistantProject) {
      return null;
    }

    return {
      task: summarizeAssistantDomainTask(assistantTask),
      execution: summarizeAssistantDomainExecution(assistantExecution),
      project: summarizeAssistantDomainProject(assistantProject)
    };
  }

  _buildLatestAssistantRunMap() {
    const runs = this.assistantRunStore.list({ limit: 500 });
    return buildAssistantRunIndex(runs);
  }

  _buildRuntimeCandidateMap(conversation = null) {
    const trackedSessionIds = [...new Set([
      conversation?.activeRuntimeSessionId || '',
      resolvePendingApprovalSessionId(conversation, this.runtimeSessionManager),
      resolvePendingQuestionSessionId(conversation, this.runtimeSessionManager),
      ...buildTrackedSupervisorSessionIds(conversation?.metadata?.supervisor?.taskMemory || null)
    ].filter(Boolean))];
    return new Map(trackedSessionIds
      .map((sessionId) => {
        const session = this.runtimeSessionManager.getSession(sessionId);
        if (!session) return null;
        const turns = this.runtimeSessionManager.listTurns(session.id, { limit: 20 });
        return [sessionId, {
          session,
          latestTurn: turns[0] || null,
          turns,
          pendingApprovals: this.runtimeSessionManager.approvalService.listPending(session.id),
          pendingQuestions: this.runtimeSessionManager.listPendingQuestions(session.id)
            .filter((entry) => entry.status === 'pending')
        }];
      })
      .filter(Boolean));
  }

  _buildConversationTaskEntries(conversation, { latestAssistantRunMap = null } = {}) {
    if (!conversation?.id) return [];
    const supervisorTasks = this.supervisorTaskStore.listByConversationId(conversation.id, { limit: 50 }).map(normalizeSupervisorStoreTask).filter(Boolean);
    const persistedTasks = supervisorTasks.length > 0
      ? supervisorTasks
      : this.taskStore.list({ conversationId: conversation.id, limit: 50 }).map(summarizeTask).filter(Boolean);
    const workingSet = conversation?.metadata?.assistantDomain?.workingSet || {};
    if (persistedTasks.length === 0 && String(workingSet?.primaryTaskId || '').trim()) {
      const assistantTask = this.assistantTaskStore?.get?.(workingSet.primaryTaskId) || null;
      const executionFromRuntime = conversation?.activeRuntimeSessionId
        ? this.assistantExecutionStore?.findByRuntimeSessionId?.(conversation.activeRuntimeSessionId) || null
        : null;
      const preferredExecutionId = String(
        executionFromRuntime?.id
          || assistantTask?.activeExecutionIds?.[assistantTask.activeExecutionIds.length - 1]
          || assistantTask?.allExecutionIds?.[assistantTask.allExecutionIds.length - 1]
          || ''
      ).trim();
      const assistantExecution = preferredExecutionId
        ? this.assistantExecutionStore?.get?.(preferredExecutionId) || executionFromRuntime || null
        : executionFromRuntime;
      const resolvedAssistantTask = assistantTask
        || (assistantExecution?.taskId ? this.assistantTaskStore?.get?.(assistantExecution.taskId) || null : null);
      const assistantProject = resolvedAssistantTask?.projectId
        ? this.assistantProjectStore?.get?.(resolvedAssistantTask.projectId) || null
        : null;
      const runtimeSessionId = String(
        conversation?.activeRuntimeSessionId
          || assistantExecution?.currentRuntimeSessionId
          || ''
      ).trim();
      const runtimeSession = runtimeSessionId
        ? this.runtimeSessionManager.getSession(runtimeSessionId)
        : null;
      const fallbackTask = buildAssistantDomainTaskRecord({
        assistantTask: resolvedAssistantTask,
        assistantExecution,
        assistantProject,
        runtimeSession
      });
      if (fallbackTask) {
        persistedTasks.push(fallbackTask);
      }
    }
    const runtimeCandidateMap = this._buildRuntimeCandidateMap(conversation);
    const deliveries = this.deliveryStore.listByConversation(conversation.id, { limit: 50 });
    const latestDelivery = deriveLastUserVisibleMessage(deliveries);
    const supervisorBrief = conversation?.metadata?.supervisor?.brief || null;

    return persistedTasks
      .map((task) => {
        const runtimeCandidate = task?.runtimeSessionId
          ? runtimeCandidateMap.get(task.runtimeSessionId) || null
          : null;
        const runtimeSession = runtimeCandidate?.session || null;
        const latestTurn = runtimeCandidate?.latestTurn || null;
        const runtimeDetail = runtimeCandidate
          ? {
              pendingApprovals: runtimeCandidate.pendingApprovals,
              pendingQuestions: runtimeCandidate.pendingQuestions
            }
          : { pendingApprovals: [], pendingQuestions: [] };
        const assistantRun = resolveAssistantRunForTask({
          conversation,
          task,
          runtimeSession,
          assistantRunIndex: latestAssistantRunMap
        });

        return {
          id: String(task.id),
          taskId: String(task.id),
          conversationId: conversation.id,
          state: deriveState({
            assistantRun: null,
            runtimeSession,
            latestTurn,
            task,
            conversation: supervisorBrief
          }),
          waitingReason: deriveWaitingReason({
            conversation: task?.id === supervisorBrief?.taskId ? supervisorBrief : null,
            runtimeDetail
          }),
          summary: deriveSummary({
            assistantRun: null,
            latestTurn,
            runtimeSession,
            task,
            conversation: task?.id === supervisorBrief?.taskId ? supervisorBrief : null
          }),
          resultPreview: deriveResultPreview({
            assistantRun: null,
            task,
            latestTurn,
            latestDelivery
          }),
          updatedAt: [
            task?.updatedAt,
            latestTurn?.updatedAt,
            runtimeSession?.updatedAt,
            conversation?.updatedAt
          ].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || '',
          conversation: summarizeConversation(conversation),
          assistantRun: summarizeAssistantRun(assistantRun),
          runtimeSession: summarizeRuntimeSession(runtimeSession, latestTurn),
          latestTurn: summarizeTurn(latestTurn),
          task: summarizeTask(task),
          assistantDomain: this._buildAssistantDomainLink(task),
          pending: {
            approvalCount: Number(runtimeDetail.pendingApprovals.length || 0),
            questionCount: Number(runtimeDetail.pendingQuestions.length || 0)
          }
        };
      })
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  }

  _buildTaskRecord(conversation, { latestAssistantRunMap = null } = {}) {
    const taskMemory = conversation?.metadata?.supervisor?.taskMemory || null;
    const trackedTaskIds = [...new Set([
      ...buildTrackedSupervisorTaskIds(conversation?.metadata?.supervisor?.taskMemory || null),
      String(conversation?.metadata?.assistantDomain?.workingSet?.primaryTaskId || '').trim()
    ].filter(Boolean))];
    const trackedSessionIds = [...new Set([
      conversation?.activeRuntimeSessionId || '',
      resolvePendingApprovalSessionId(conversation, this.runtimeSessionManager),
      resolvePendingQuestionSessionId(conversation, this.runtimeSessionManager),
      ...buildTrackedSupervisorSessionIds(conversation?.metadata?.supervisor?.taskMemory || null)
    ].filter(Boolean))];
    const supervisorTasks = this.supervisorTaskStore.listByConversationId(conversation.id, { limit: 50 }).map(normalizeSupervisorStoreTask).filter(Boolean);
    const persistedTasks = supervisorTasks.length > 0
      ? supervisorTasks
      : this.taskStore.list({ conversationId: conversation.id, limit: 50 });
    if (persistedTasks.length === 0) {
      const workingSet = conversation?.metadata?.assistantDomain?.workingSet || {};
      const assistantTask = String(workingSet?.primaryTaskId || '').trim()
        ? this.assistantTaskStore?.get?.(workingSet.primaryTaskId) || null
        : null;
      const executionFromRuntime = conversation?.activeRuntimeSessionId
        ? this.assistantExecutionStore?.findByRuntimeSessionId?.(conversation.activeRuntimeSessionId) || null
        : null;
      const preferredExecutionId = String(
        executionFromRuntime?.id
          || assistantTask?.activeExecutionIds?.[assistantTask.activeExecutionIds.length - 1]
          || assistantTask?.allExecutionIds?.[assistantTask.allExecutionIds.length - 1]
          || ''
      ).trim();
      const assistantExecution = preferredExecutionId
        ? this.assistantExecutionStore?.get?.(preferredExecutionId) || executionFromRuntime || null
        : executionFromRuntime;
      const resolvedAssistantTask = assistantTask
        || (assistantExecution?.taskId ? this.assistantTaskStore?.get?.(assistantExecution.taskId) || null : null);
      const assistantProject = resolvedAssistantTask?.projectId
        ? this.assistantProjectStore?.get?.(resolvedAssistantTask.projectId) || null
        : null;
      const runtimeSessionId = String(
        conversation?.activeRuntimeSessionId
          || assistantExecution?.currentRuntimeSessionId
          || ''
      ).trim();
      const runtimeSession = runtimeSessionId
        ? this.runtimeSessionManager.getSession(runtimeSessionId)
        : null;
      const fallbackTask = buildAssistantDomainTaskRecord({
        assistantTask: resolvedAssistantTask,
        assistantExecution,
        assistantProject,
        runtimeSession
      });
      if (fallbackTask) {
        persistedTasks.push(fallbackTask);
      }
    }
    const selectedTask = chooseTaskFromSupervisorMemory(taskMemory, persistedTasks);
    const runtimeCandidates = trackedSessionIds
      .map((sessionId) => {
        const session = this.runtimeSessionManager.getSession(sessionId);
        if (!session) return null;
        const turns = this.runtimeSessionManager.listTurns(session.id, { limit: 20 });
        return {
          session,
          latestTurn: turns[0] || null,
          turns,
          pendingApprovals: this.runtimeSessionManager.approvalService.listPending(session.id),
          pendingQuestions: this.runtimeSessionManager.listPendingQuestions(session.id)
            .filter((entry) => entry.status === 'pending')
        };
      })
      .filter(Boolean);
    const taskRuntimeCandidate = selectedTask?.runtimeSessionId
      ? runtimeCandidates.find((entry) => entry.session.id === selectedTask.runtimeSessionId)
      : null;
    const activeRuntimeCandidate = runtimeCandidates.find((entry) => entry.session.id === conversation?.activeRuntimeSessionId) || null;
    const selectedRuntimeCandidate = taskRuntimeCandidate
      || activeRuntimeCandidate
      || [...runtimeCandidates].sort((left, right) => String(right?.session?.updatedAt || '').localeCompare(String(left?.session?.updatedAt || '')))[0]
      || null;
    const runtimeSession = selectedRuntimeCandidate?.session || null;
    const latestTurn = selectedRuntimeCandidate?.latestTurn || null;
    const runtimeDetail = selectedRuntimeCandidate
      ? {
          pendingApprovals: selectedRuntimeCandidate.pendingApprovals,
          pendingQuestions: selectedRuntimeCandidate.pendingQuestions
        }
      : { pendingApprovals: [], pendingQuestions: [] };
    const task = selectedTask;
    const assistantRun = resolveAssistantRunForTask({
      conversation,
      task,
      runtimeSession,
      assistantRunIndex: latestAssistantRunMap
    });
    const deliveries = this.deliveryStore.listByConversation(conversation.id, { limit: 50 });
    const latestDelivery = deriveLastUserVisibleMessage(deliveries);
    const supervisorBrief = conversation?.metadata?.supervisor?.brief || null;

    const recordId = task?.id || assistantRun?.id || runtimeSession?.id || conversation.id;
    return {
      id: String(recordId || conversation.id),
      conversationId: conversation.id,
      taskId: task?.id || supervisorBrief?.taskId || runtimeSession?.id || conversation.id,
      state: deriveState({
        assistantRun,
        runtimeSession,
        latestTurn,
        task,
        conversation: supervisorBrief
      }),
      waitingReason: deriveWaitingReason({
        conversation: supervisorBrief,
        runtimeDetail
      }),
      summary: deriveSummary({
        assistantRun,
        latestTurn,
        runtimeSession,
        task,
        conversation: supervisorBrief
      }),
      resultPreview: deriveResultPreview({
        assistantRun,
        task,
        latestTurn,
        latestDelivery
      }),
      lastUserVisibleMessage: latestDelivery,
      updatedAt: [
        assistantRun?.updatedAt,
        task?.updatedAt,
        latestTurn?.updatedAt,
        runtimeSession?.updatedAt,
        conversation?.updatedAt
      ].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || '',
      conversation: summarizeConversation(conversation),
      trackedTaskIds,
      assistantRun: summarizeAssistantRun(assistantRun),
      runtimeSession: summarizeRuntimeSession(runtimeSession, latestTurn),
      latestTurn: summarizeTurn(latestTurn),
      task: summarizeTask(task),
      assistantDomain: this._buildAssistantDomainLink(task),
      supervisorBrief,
      pending: {
        approvalCount: Number(runtimeDetail.pendingApprovals.length || 0),
        questionCount: Number(runtimeDetail.pendingQuestions.length || 0)
      }
    };
  }

  listTasks({ limit = 20, state = '', conversationId = '' } = {}) {
    const latestAssistantRunMap = this._buildLatestAssistantRunMap();
    return this.conversationStore.list({ limit: Math.max(limit * 5, 200) })
      .filter((conversation) => !conversationId || conversation.id === String(conversationId))
      .map((conversation) => this._buildTaskRecord(conversation, { latestAssistantRunMap }))
      .filter((record) => !state || String(record.state || '') === String(state))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  getConversationTaskSpace(conversationId, {
    activeLimit = 5,
    waitingLimit = 5,
    recentLimit = 5
  } = {}) {
    const conversation = this.conversationStore.get(String(conversationId || ''));
    if (!conversation) return null;
    const latestAssistantRunMap = this._buildLatestAssistantRunMap();
    const records = this._buildConversationTaskEntries(conversation, { latestAssistantRunMap });
    const activeTasks = records
      .filter((record) => !isTerminalTaskState(record.state))
      .slice(0, Math.max(1, activeLimit));
    const waitingTasks = activeTasks
      .filter((record) => record.pending.approvalCount > 0 || record.pending.questionCount > 0 || ['waiting_approval', 'waiting_user'].includes(record.state))
      .slice(0, Math.max(1, waitingLimit));
    const recentCompletedTasks = records
      .filter((record) => record.state === 'completed')
      .slice(0, Math.max(1, recentLimit));
    const recentFailedTasks = records
      .filter((record) => ['failed', 'cancelled'].includes(record.state))
      .slice(0, Math.max(1, recentLimit));
    const currentTaskId = String(
      conversation?.metadata?.supervisor?.taskMemory?.activeTaskId
      || conversation?.metadata?.supervisor?.taskMemory?.currentTask?.taskId
      || conversation?.metadata?.supervisor?.taskMemory?.current?.taskId
      || ''
    ).trim();
    const pendingApprovalSessionId = resolvePendingApprovalSessionId(conversation, this.runtimeSessionManager);
    const pendingQuestionSessionId = resolvePendingQuestionSessionId(conversation, this.runtimeSessionManager);
    const focusTask = records.find((record) => record.taskId === currentTaskId)
      || records.find((record) => (
        record.runtimeSession?.id
        && record.runtimeSession.id === pendingApprovalSessionId
      ))
      || records.find((record) => (
        record.runtimeSession?.id
        && record.runtimeSession.id === pendingQuestionSessionId
      ))
      || records.find((record) => record.runtimeSession?.id && record.runtimeSession.id === conversation.activeRuntimeSessionId)
      || (waitingTasks.length === 1 ? waitingTasks[0] : null)
      || activeTasks[0]
      || recentCompletedTasks[0]
      || recentFailedTasks[0]
      || null;

    return {
      conversation: summarizeConversation(conversation),
      focusTask,
      activeTasks,
      waitingTasks,
      recentCompletedTasks,
      recentFailedTasks,
      recentTasks: records.slice(0, Math.max(1, recentLimit)),
      focusTaskReason: buildFocusTaskReason({
        focusTask,
        waitingTasks,
        activeTasks,
        currentTaskId
      }),
      taskRelationshipSummary: focusTask ? buildTaskRelationshipSummary(focusTask) : '',
      decisionHints: buildDecisionHints({
        focusTask,
        waitingTasks,
        activeTasks
      }),
      summary: {
        taskCount: records.length,
        activeCount: records.filter((record) => !isTerminalTaskState(record.state)).length,
        waitingCount: records.filter((record) => (
          record.pending.approvalCount > 0
          || record.pending.questionCount > 0
          || ['waiting_approval', 'waiting_user'].includes(record.state)
        )).length,
        completedCount: records.filter((record) => record.state === 'completed').length,
        failedCount: records.filter((record) => ['failed', 'cancelled'].includes(record.state)).length
      }
    };
  }

  getTask(taskId) {
    const normalizedId = String(taskId || '');
    const conversations = this.conversationStore.list({ limit: 500 });
    const latestAssistantRunMap = this._buildLatestAssistantRunMap();
    for (const conversation of conversations) {
      const taskEntries = this._buildConversationTaskEntries(conversation, { latestAssistantRunMap });
      const matchedTask = taskEntries.find((entry) => entry.id === normalizedId || entry.taskId === normalizedId);
      if (matchedTask) {
        return matchedTask;
      }
      const record = this._buildTaskRecord(conversation, { latestAssistantRunMap });
      if (record.id === normalizedId) {
        return record;
      }
    }
    return null;
  }
}

export const assistantTaskViewService = new AssistantTaskViewService();

export default assistantTaskViewService;
