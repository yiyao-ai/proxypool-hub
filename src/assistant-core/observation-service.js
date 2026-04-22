import chatUiConversationStore from '../chat-ui/conversation-store.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentTaskStore from '../agent-core/task-store.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import assistantMemoryService from './memory-service.js';
import assistantPolicyService from './policy-service.js';

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

function summarizeTurnStats(stats = {}) {
  return {
    messageCount: Number(stats?.messageCount || 0),
    commandCount: Number(stats?.commandCount || 0),
    fileChangeCount: Number(stats?.fileChangeCount || 0),
    approvalCount: Number(stats?.approvalCount || 0),
    approvalResolvedCount: Number(stats?.approvalResolvedCount || 0),
    questionCount: Number(stats?.questionCount || 0),
    failureCount: Number(stats?.failureCount || 0),
    lastMessage: String(stats?.lastMessage || '')
  };
}

function aggregateTurnStats(turns = []) {
  return turns.reduce((acc, turn) => {
    const stats = summarizeTurnStats(turn?.stats || {});
    acc.turnCount += 1;
    acc.messageCount += stats.messageCount;
    acc.commandCount += stats.commandCount;
    acc.fileChangeCount += stats.fileChangeCount;
    acc.approvalCount += stats.approvalCount;
    acc.approvalResolvedCount += stats.approvalResolvedCount;
    acc.questionCount += stats.questionCount;
    acc.failureCount += stats.failureCount;
    return acc;
  }, {
    turnCount: 0,
    messageCount: 0,
    commandCount: 0,
    fileChangeCount: 0,
    approvalCount: 0,
    approvalResolvedCount: 0,
    questionCount: 0,
    failureCount: 0
  });
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
    deliveryStore = agentChannelDeliveryStore,
    memoryService = assistantMemoryService,
    policyService = assistantPolicyService
  } = {}) {
    this.conversationStore = conversationStore;
    this.runtimeSessionManager = runtimeSessionManager;
    this.taskStore = taskStore;
    this.deliveryStore = deliveryStore;
    this.memoryService = memoryService;
    this.policyService = policyService;
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
      .map((entry) => {
        const turns = this.runtimeSessionManager.listTurns(entry.id, { limit: 20 });
        const latestTurn = turns[0] || null;
        return {
          ...summarizeRuntimeSession(entry),
          latestTurn: summarizeRuntimeTurn(latestTurn),
          turnStats: aggregateTurnStats(turns)
        };
      })
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
    const turns = this.runtimeSessionManager.listTurns(session.id, { limit: 20 });

    return {
      session: {
        ...summarizeRuntimeSession(session),
        latestTurn: summarizeRuntimeTurn(turns[0] || null),
        turnStats: aggregateTurnStats(turns)
      },
      turns: turns.map(summarizeRuntimeTurn).filter(Boolean),
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
        turnId: entry.turnId || '',
        title: entry.title || '',
        summary: entry.summary || '',
        createdAt: entry.createdAt || '',
        rawRequest: entry.rawRequest || null
      })),
      pendingQuestions: pendingQuestions.map((entry) => ({
        questionId: entry.questionId,
        turnId: entry.turnId || '',
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

  getRuntimeTurnDetail(sessionId, turnId, { eventLimit = 50 } = {}) {
    const session = this.runtimeSessionManager.getSession(String(sessionId || ''));
    if (!session) return null;

    const turn = this.runtimeSessionManager.getTurn(session.id, String(turnId || ''));
    if (!turn) return null;

    const pendingApprovals = this.runtimeSessionManager.approvalService.listPending(session.id)
      .filter((entry) => String(entry?.turnId || session.currentTurnId || '') === turn.id);
    const pendingQuestions = this.runtimeSessionManager.listPendingQuestions(session.id)
      .filter((entry) => entry.status === 'pending')
      .filter((entry) => String(entry?.turnId || session.currentTurnId || '') === turn.id);
    const events = this.runtimeSessionManager.listTurnEvents(session.id, turn.id, {
      limit: Math.max(1, eventLimit)
    });

    return {
      session: summarizeRuntimeSession(session),
      turn: summarizeRuntimeTurn(turn),
      pendingApprovals: pendingApprovals.map((entry) => ({
        approvalId: entry.approvalId,
        turnId: entry.turnId || '',
        title: entry.title || '',
        summary: entry.summary || '',
        createdAt: entry.createdAt || '',
        rawRequest: entry.rawRequest || null
      })),
      pendingQuestions: pendingQuestions.map((entry) => ({
        questionId: entry.questionId,
        turnId: entry.turnId || '',
        text: entry.text || '',
        options: entry.options || [],
        createdAt: entry.createdAt || '',
        rawRequest: entry.rawRequest || null
      })),
      recentEvents: events
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

    const memory = this.memoryService.resolvePreferences({
      conversation,
      runtimeSession: activeRuntime,
      cwd: activeRuntime?.cwd || ''
    });
    const policy = {
      conversation: this.policyService.listPolicies({
        scope: 'conversation',
        scopeRef: conversation.id
      }),
      runtimeSession: activeRuntime?.id
        ? this.policyService.listPolicies({
            scope: 'runtime_session',
            scopeRef: activeRuntime.id
          })
        : [],
      workspace: activeRuntime?.cwd
        ? this.policyService.listPolicies({
            scope: 'workspace',
            scopeRef: activeRuntime.cwd
          })
        : []
    };

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
      assistantState: conversation?.metadata?.assistantCore || null,
      memory,
      policy
    };
  }

  getWorkspaceContext({ runtimeLimit = 10, conversationLimit = 10 } = {}) {
    const runtimeSessions = this.listRuntimeSessions({ limit: runtimeLimit });
    const conversations = this.listConversations({ limit: conversationLimit });
    const memory = this.memoryService.resolvePreferences({});
    const policy = {
      globalUser: this.policyService.listPolicies({
        scope: 'global_user',
        scopeRef: 'default-user'
      })
    };

    return {
      summary: {
        runtimeCount: runtimeSessions.length,
        conversationCount: conversations.length,
        turnCount: runtimeSessions.reduce((sum, entry) => sum + Number(entry?.turnStats?.turnCount || 0), 0),
        waitingApproval: runtimeSessions.filter((entry) => entry.status === 'waiting_approval').length,
        waitingUser: runtimeSessions.filter((entry) => entry.status === 'waiting_user').length,
        running: runtimeSessions.filter((entry) => ['starting', 'running'].includes(entry.status)).length,
        failed: runtimeSessions.filter((entry) => entry.status === 'failed').length
      },
      turnStats: runtimeSessions.reduce((acc, entry) => ({
        turnCount: acc.turnCount + Number(entry?.turnStats?.turnCount || 0),
        messageCount: acc.messageCount + Number(entry?.turnStats?.messageCount || 0),
        commandCount: acc.commandCount + Number(entry?.turnStats?.commandCount || 0),
        fileChangeCount: acc.fileChangeCount + Number(entry?.turnStats?.fileChangeCount || 0),
        approvalCount: acc.approvalCount + Number(entry?.turnStats?.approvalCount || 0),
        approvalResolvedCount: acc.approvalResolvedCount + Number(entry?.turnStats?.approvalResolvedCount || 0),
        questionCount: acc.questionCount + Number(entry?.turnStats?.questionCount || 0),
        failureCount: acc.failureCount + Number(entry?.turnStats?.failureCount || 0)
      }), {
        turnCount: 0,
        messageCount: 0,
        commandCount: 0,
        fileChangeCount: 0,
        approvalCount: 0,
        approvalResolvedCount: 0,
        questionCount: 0,
        failureCount: 0
      }),
      memory,
      policy,
      runtimeSessions,
      conversations
    };
  }

  searchProjectMemory({ query = '', limit = 10 } = {}) {
    const source = String(query || '').trim().toLowerCase();
    const taskMatches = this.taskStore.list({ limit: Math.max(limit * 5, limit) })
      .filter((entry) => {
        if (!source) return true;
        return [
          entry.title,
          entry.summary,
          entry.result,
          entry.error,
          entry.input
        ].some((value) => String(value || '').toLowerCase().includes(source));
      })
      .slice(0, Math.max(1, limit))
      .map((entry) => ({
        kind: 'task',
        id: entry.id,
        conversationId: entry.conversationId || '',
        runtimeSessionId: entry.runtimeSessionId || '',
        provider: entry.provider || '',
        title: entry.title || '',
        status: entry.status || '',
        summary: entry.summary || '',
        updatedAt: entry.updatedAt || ''
      }));

    const conversationMatches = this.conversationStore.list({ limit: Math.max(limit * 5, limit) })
      .map((entry) => summarizeConversation(entry))
      .filter((entry) => {
        if (!source) return true;
        return [
          entry.title,
          entry.runtimeTitle,
          entry.runtimeSummary
        ].some((value) => String(value || '').toLowerCase().includes(source));
      })
      .slice(0, Math.max(1, limit))
      .map((entry) => ({
        kind: 'conversation',
        id: entry.id,
        title: entry.title || '',
        assistantMode: entry.assistantMode || '',
        activeRuntimeSessionId: entry.activeRuntimeSessionId || '',
        runtimeTitle: entry.runtimeTitle || '',
        runtimeSummary: entry.runtimeSummary || '',
        updatedAt: entry.updatedAt || ''
      }));

    return {
      query: String(query || ''),
      tasks: taskMatches,
      conversations: conversationMatches
    };
  }
}

function summarizeRuntimeTurn(turn = {}) {
  if (!turn?.id) return null;
  return {
    id: turn.id,
    sessionId: turn.sessionId || '',
    status: turn.status || 'unknown',
    input: turn.input || '',
    summary: turn.summary || '',
    error: turn.error || '',
    eventCount: Number(turn.eventCount || 0),
    stats: summarizeTurnStats(turn?.stats || {}),
    startedAt: turn.startedAt || '',
    completedAt: turn.completedAt || '',
    updatedAt: turn.updatedAt || ''
  };
}

export const assistantObservationService = new AssistantObservationService();

export default assistantObservationService;
