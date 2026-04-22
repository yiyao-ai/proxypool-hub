import chatUiConversationStore from '../chat-ui/conversation-store.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentTaskStore from '../agent-core/task-store.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function summarizeRuntimeSession(session = {}) {
  if (!session?.id) return null;
  return {
    id: session.id,
    provider: session.provider,
    providerLabel: providerLabel(session.provider),
    status: session.status || 'unknown',
    title: session.title || '',
    summary: session.summary || '',
    error: session.error || '',
    updatedAt: session.updatedAt || ''
  };
}

function summarizeConversation(conversation = {}) {
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
    runtimeTitle: brief.title || '',
    runtimeProvider: brief.provider || '',
    runtimeProviderLabel: brief.providerLabel || providerLabel(brief.provider),
    runtimeSummary: brief.summary || '',
    updatedAt: conversation.updatedAt || ''
  };
}

export class AssistantObservationService {
  constructor({
    conversationStore = chatUiConversationStore,
    runtimeSessionManager = agentRuntimeSessionManager,
    taskStore = agentTaskStore,
    deliveryStore = agentChannelDeliveryStore
  } = {}) {
    this.conversationStore = conversationStore;
    this.runtimeSessionManager = runtimeSessionManager;
    this.taskStore = taskStore;
    this.deliveryStore = deliveryStore;
  }

  buildConversationObservation(conversation) {
    const activeRuntime = conversation?.activeRuntimeSessionId
      ? this.runtimeSessionManager.getSession(conversation.activeRuntimeSessionId)
      : null;
    const latestTask = conversation?.id
      ? this.taskStore.findLatestByConversation(conversation.id)
      : null;
    const sessions = this.runtimeSessionManager.listSessions({ limit: 10 });
    const conversations = this.conversationStore.list({ limit: 10 });

    const waitingApproval = sessions.filter((entry) => entry.status === 'waiting_approval');
    const waitingUser = sessions.filter((entry) => entry.status === 'waiting_user');
    const running = sessions.filter((entry) => ['starting', 'running'].includes(entry.status));
    const failed = sessions.filter((entry) => entry.status === 'failed');

    return {
      currentConversation: summarizeConversation(conversation),
      activeRuntime: summarizeRuntimeSession(activeRuntime),
      latestTask: latestTask
        ? {
            id: latestTask.id,
            title: latestTask.title || '',
            status: latestTask.status || '',
            provider: latestTask.provider || '',
            summary: latestTask.summary || '',
            result: latestTask.result || '',
            error: latestTask.error || '',
            updatedAt: latestTask.updatedAt || ''
          }
        : null,
      runtimeQueues: {
        waitingApproval: waitingApproval.length,
        waitingUser: waitingUser.length,
        running: running.length,
        failed: failed.length
      },
      recentRuntimeSessions: sessions.map(summarizeRuntimeSession).filter(Boolean),
      recentConversations: conversations.map(summarizeConversation)
    };
  }

  listRuntimeSessions({ limit = 20, status = '' } = {}) {
    return this.runtimeSessionManager.listSessions({ limit: Math.max(limit * 3, limit) })
      .filter((entry) => !status || String(entry.status || '') === String(status))
      .slice(0, Math.max(1, limit))
      .map(summarizeRuntimeSession)
      .filter(Boolean);
  }

  getRuntimeSessionDetail(sessionId, { eventLimit = 50 } = {}) {
    const session = this.runtimeSessionManager.getSession(String(sessionId || ''));
    if (!session) return null;

    const pendingApprovals = this.runtimeSessionManager.approvalService.listPending(session.id);
    const pendingQuestions = this.runtimeSessionManager.listPendingQuestions(session.id)
      .filter((entry) => entry.status === 'pending');
    const events = this.runtimeSessionManager.getEvents(session.id, {
      afterSeq: 0,
      limit: Math.max(1, eventLimit)
    });
    const task = this.taskStore.findByRuntimeSessionId(session.id);
    const deliveries = this.deliveryStore.listBySession(session.id, { limit: 20 });

    return {
      session: summarizeRuntimeSession(session),
      task: task
        ? {
            id: task.id,
            title: task.title || '',
            status: task.status || '',
            summary: task.summary || '',
            result: task.result || '',
            error: task.error || '',
            updatedAt: task.updatedAt || ''
          }
        : null,
      pendingApprovals: pendingApprovals.map((entry) => ({
        approvalId: entry.approvalId,
        title: entry.title || '',
        summary: entry.summary || '',
        createdAt: entry.createdAt || '',
        rawRequest: entry.rawRequest || null
      })),
      pendingQuestions: pendingQuestions.map((entry) => ({
        questionId: entry.questionId,
        text: entry.text || '',
        options: entry.options || [],
        createdAt: entry.createdAt || '',
        rawRequest: entry.rawRequest || null
      })),
      recentEvents: events,
      deliveries: deliveries.map((entry) => ({
        id: entry.id,
        direction: entry.direction,
        status: entry.status,
        payload: entry.payload || {},
        createdAt: entry.createdAt || '',
        updatedAt: entry.updatedAt || ''
      }))
    };
  }

  listConversations({ limit = 20, mode = '' } = {}) {
    return this.conversationStore.list({ limit: Math.max(limit * 3, limit) })
      .map(summarizeConversation)
      .filter((entry) => !mode || String(entry.assistantMode || '') === String(mode))
      .slice(0, Math.max(1, limit));
  }

  getConversationContext(conversationId, { deliveryLimit = 20 } = {}) {
    const conversation = this.conversationStore.get(String(conversationId || ''));
    if (!conversation) return null;

    const activeRuntime = conversation.activeRuntimeSessionId
      ? this.runtimeSessionManager.getSession(conversation.activeRuntimeSessionId)
      : null;
    const latestTask = this.taskStore.findLatestByConversation(conversation.id);
    const deliveries = this.deliveryStore.listByConversation(conversation.id, {
      limit: Math.max(1, deliveryLimit)
    });

    return {
      conversation: summarizeConversation(conversation),
      activeRuntime: summarizeRuntimeSession(activeRuntime),
      latestTask: latestTask
        ? {
            id: latestTask.id,
            runtimeSessionId: latestTask.runtimeSessionId || '',
            provider: latestTask.provider || '',
            title: latestTask.title || '',
            status: latestTask.status || '',
            summary: latestTask.summary || '',
            result: latestTask.result || '',
            error: latestTask.error || '',
            updatedAt: latestTask.updatedAt || ''
          }
        : null,
      deliveries: deliveries.map((entry) => ({
        id: entry.id,
        direction: entry.direction,
        status: entry.status,
        payload: entry.payload || {},
        createdAt: entry.createdAt || '',
        updatedAt: entry.updatedAt || ''
      })),
      supervisor: conversation?.metadata?.supervisor || null,
      assistantState: conversation?.metadata?.assistantCore || null
    };
  }

  getWorkspaceContext({ runtimeLimit = 10, conversationLimit = 10 } = {}) {
    const runtimeSessions = this.listRuntimeSessions({ limit: runtimeLimit });
    const conversations = this.listConversations({ limit: conversationLimit });

    return {
      summary: {
        runtimeCount: runtimeSessions.length,
        conversationCount: conversations.length,
        waitingApproval: runtimeSessions.filter((entry) => entry.status === 'waiting_approval').length,
        waitingUser: runtimeSessions.filter((entry) => entry.status === 'waiting_user').length,
        running: runtimeSessions.filter((entry) => ['starting', 'running'].includes(entry.status)).length,
        failed: runtimeSessions.filter((entry) => entry.status === 'failed').length
      },
      runtimeSessions,
      conversations
    };
  }
}

export const assistantObservationService = new AssistantObservationService();

export default assistantObservationService;
