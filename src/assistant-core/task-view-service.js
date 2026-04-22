import chatUiConversationStore from '../chat-ui/conversation-store.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentTaskStore from '../agent-core/task-store.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import assistantRunStore from './run-store.js';

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
    updatedAt: run.updatedAt || ''
  };
}

function summarizeTask(task = null) {
  if (!task?.id) return null;
  return {
    id: task.id,
    conversationId: task.conversationId || '',
    runtimeSessionId: task.runtimeSessionId || '',
    provider: task.provider || '',
    title: task.title || '',
    status: task.status || '',
    input: task.input || '',
    summary: task.summary || '',
    result: task.result || '',
    error: task.error || '',
    originKind: task.originKind || '',
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

export class AssistantTaskViewService {
  constructor({
    conversationStore = chatUiConversationStore,
    runtimeSessionManager = agentRuntimeSessionManager,
    taskStore = agentTaskStore,
    deliveryStore = agentChannelDeliveryStore,
    assistantRunStore: runStore = assistantRunStore
  } = {}) {
    this.conversationStore = conversationStore;
    this.runtimeSessionManager = runtimeSessionManager;
    this.taskStore = taskStore;
    this.deliveryStore = deliveryStore;
    this.assistantRunStore = runStore;
  }

  _buildTaskRecord(conversation) {
    const runtimeSession = conversation?.activeRuntimeSessionId
      ? this.runtimeSessionManager.getSession(conversation.activeRuntimeSessionId)
      : null;
    const runtimeTurns = runtimeSession?.id
      ? this.runtimeSessionManager.listTurns(runtimeSession.id, { limit: 20 })
      : [];
    const latestTurn = runtimeTurns[0] || null;
    const runtimeDetail = runtimeSession?.id
      ? {
          pendingApprovals: this.runtimeSessionManager.approvalService.listPending(runtimeSession.id),
          pendingQuestions: this.runtimeSessionManager.listPendingQuestions(runtimeSession.id)
            .filter((entry) => entry.status === 'pending')
        }
      : { pendingApprovals: [], pendingQuestions: [] };
    const task = this.taskStore.findLatestByConversation(conversation.id);
    const assistantRuns = this.assistantRunStore.listByConversationId(conversation.id, { limit: 20 });
    const assistantRun = assistantRuns[0] || null;
    const deliveries = this.deliveryStore.listByConversation(conversation.id, { limit: 50 });
    const latestDelivery = deriveLastUserVisibleMessage(deliveries);
    const supervisorBrief = conversation?.metadata?.supervisor?.brief || null;

    const recordId = task?.id || assistantRun?.id || runtimeSession?.id || conversation.id;
    return {
      id: String(recordId || conversation.id),
      conversationId: conversation.id,
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
    return this.conversationStore.list({ limit: Math.max(limit * 5, 200) })
      .filter((conversation) => !conversationId || conversation.id === String(conversationId))
      .map((conversation) => this._buildTaskRecord(conversation))
      .filter((record) => !state || String(record.state || '') === String(state))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  getTask(taskId) {
    const normalizedId = String(taskId || '');
    const conversations = this.conversationStore.list({ limit: 500 });
    for (const conversation of conversations) {
      const record = this._buildTaskRecord(conversation);
      if (record.id === normalizedId) {
        return record;
      }
    }
    return null;
  }
}

export const assistantTaskViewService = new AssistantTaskViewService();

export default assistantTaskViewService;
