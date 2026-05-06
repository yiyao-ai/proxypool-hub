import chatUiConversationStore from '../chat-ui/conversation-store.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentTaskStore from '../agent-core/task-store.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import assistantRunStore from './run-store.js';
import { buildTrackedSupervisorSessionIds, buildTrackedSupervisorTaskIds } from '../agent-orchestrator/supervisor-task-memory.js';
import supervisorTaskStore from '../agent-orchestrator/supervisor-task-store.js';

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
  const assistantState = conversation?.metadata?.assistantCore || {};
  return {
    id: conversation.id,
    channel: conversation.channel || '',
    title: conversation.title || '',
    activeRuntimeSessionId: conversation.activeRuntimeSessionId || null,
    activeTaskId: conversation?.metadata?.supervisor?.taskMemory?.activeTaskId || brief.taskId || null,
    assistantMode: assistantState.mode || 'direct-runtime',
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
    updatedAt: task.updatedAt || task.lastUpdateAt || ''
  };
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
    updatedAt: task.updatedAt || ''
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
    return 'This task is focused because no active task is available and it is the most relevant recent task.';
  }
  return 'This task is the current best candidate for follow-up.';
}

function buildDecisionHints({ focusTask = null, waitingTasks = [], activeTasks = [] } = {}) {
  const shouldClarify = activeTasks.length > 1 && waitingTasks.length !== 1 && !focusTask;
  let preferredAction = 'inspect_task_space';
  let reason = 'Inspect task space before choosing a task.';
  let preferredTaskId = '';

  if (waitingTasks.length === 1) {
    preferredAction = 'continue_waiting_task';
    preferredTaskId = waitingTasks[0]?.taskId || '';
    reason = 'There is exactly one waiting task, so it should be handled first.';
  } else if (focusTask) {
    preferredAction = 'continue_focus_task';
    preferredTaskId = focusTask.taskId || '';
    reason = 'A focus task is available and is the best default task for follow-up.';
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
    waitingTaskCount: waitingTasks.length,
    activeTaskCount: activeTasks.length,
    focusTaskRelationship: buildTaskRelationshipSummary(focusTask),
    focusTaskExecutionTarget: focusTask?.task?.latestExecutionId || focusTask?.runtimeSession?.id || ''
  };
}

export class AssistantTaskViewService {
  constructor({
    conversationStore = chatUiConversationStore,
    runtimeSessionManager = agentRuntimeSessionManager,
    taskStore = agentTaskStore,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    deliveryStore = agentChannelDeliveryStore,
    assistantRunStore: runStore = assistantRunStore
  } = {}) {
    this.conversationStore = conversationStore;
    this.runtimeSessionManager = runtimeSessionManager;
    this.taskStore = taskStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.deliveryStore = deliveryStore;
    this.assistantRunStore = runStore;
  }

  _buildLatestAssistantRunMap() {
    const runs = this.assistantRunStore.list({ limit: 500 });
    const latestByConversationId = new Map();
    for (const run of runs) {
      const conversationId = String(run?.conversationId || '');
      if (!conversationId || latestByConversationId.has(conversationId)) {
        continue;
      }
      latestByConversationId.set(conversationId, run);
    }
    return latestByConversationId;
  }

  _buildRuntimeCandidateMap(conversation = null) {
    const trackedSessionIds = [...new Set([
      conversation?.activeRuntimeSessionId || '',
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
    const runtimeCandidateMap = this._buildRuntimeCandidateMap(conversation);
    const assistantRun = latestAssistantRunMap?.get(conversation.id) || this.assistantRunStore.listByConversationId(conversation.id, { limit: 1 })[0] || null;
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
    const trackedTaskIds = buildTrackedSupervisorTaskIds(conversation?.metadata?.supervisor?.taskMemory || null);
    const trackedSessionIds = [...new Set([
      conversation?.activeRuntimeSessionId || '',
      ...buildTrackedSupervisorSessionIds(conversation?.metadata?.supervisor?.taskMemory || null)
    ].filter(Boolean))];
    const supervisorTasks = this.supervisorTaskStore.listByConversationId(conversation.id, { limit: 50 }).map(normalizeSupervisorStoreTask).filter(Boolean);
    const persistedTasks = supervisorTasks.length > 0
      ? supervisorTasks
      : this.taskStore.list({ conversationId: conversation.id, limit: 50 });
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
    const assistantRun = latestAssistantRunMap?.get(conversation.id) || this.assistantRunStore.listByConversationId(conversation.id, { limit: 1 })[0] || null;
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
    const focusTask = records.find((record) => record.taskId === currentTaskId)
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
