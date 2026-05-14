import chatUiConversationStore from '../chat-ui/conversation-store.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentTaskStore from '../agent-core/task-store.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import assistantMemoryService from './memory-service.js';
import assistantPolicyService from './policy-service.js';
import assistantWorkspaceStore from './workspace-store.js';
import assistantClarificationStore from './clarification-store.js';
import assistantDomainTaskStore from './domain/task-store.js';
import assistantDomainExecutionStore from './domain/execution-store.js';
import assistantDomainProjectStore from './domain/project-store.js';
import { getAssistantControlMode } from './assistant-state.js';
import { resolveWorkspaceScopeRef, buildWorkspaceMetadata, buildScopeRefs } from './scope-resolver.js';
import { buildTrackedSupervisorSessionIds, buildTrackedSupervisorTaskIds } from '../agent-orchestrator/supervisor-task-memory.js';
import supervisorTaskStore from '../agent-orchestrator/supervisor-task-store.js';
import { normalizeWorkspaceRef } from './workspace-store.js';
import { getConversationPendingRuntimeState } from './pending-runtime-state.js';

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
    cwd: session.cwd || session?.metadata?.cwd || '',
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
  const workingSet = conversation?.metadata?.assistantDomain?.workingSet || {};
  const assistantState = conversation?.metadata?.assistantCore || {};
  const trackedRuntimeSessionIds = buildTrackedSupervisorSessionIds(conversation?.metadata?.supervisor?.taskMemory || null);
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
    trackedRuntimeSessionIds,
    trackedTaskIds,
    assistantMode: getAssistantControlMode(conversation),
    assistantSessionId: assistantState.assistantSessionId || null,
    assistantLastRunId: assistantState.lastRunId || null,
    runtimeStatus: brief.status || '',
    runtimeTitle: brief.title || '',
    runtimeTaskId: brief.taskId || '',
    runtimeProvider: brief.provider || '',
    runtimeProviderLabel: brief.providerLabel || providerLabel(brief.provider),
    runtimeSummary: brief.summary || '',
    updatedAt: conversation.updatedAt || ''
  };
}

function projectTaskRecord(task = null) {
  if (!task?.id) return null;
  return {
    id: task.id,
    conversationId: task.conversationId || '',
    runtimeSessionId: task.runtimeSessionId || task.primaryExecutionId || '',
    provider: task.provider || task.executorStrategy || task.metadata?.provider || '',
    title: task.title || '',
    status: task.status || '',
    summary: task.summary || '',
    result: task.result || '',
    error: task.error || '',
    cwd: task.cwd || task.metadata?.cwd || '',
    cwdBasename: task.cwdBasename || task.metadata?.cwdBasename || '',
    lastConversationId: task.lastConversationId || task.metadata?.lastConversationId || task.conversationId || '',
    metadata: task.metadata && typeof task.metadata === 'object'
      ? { ...task.metadata }
      : {},
    updatedAt: task.updatedAt || task.lastUpdateAt || ''
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
    provider: assistantExecution?.provider || runtimeSession?.provider || '',
    title: assistantTask.title || '',
    status: runtimeSession?.status || assistantExecution?.status || assistantTask.lifecycleState || '',
    summary: assistantTask.summary || assistantExecution?.lastTurnSummary || runtimeSession?.summary || '',
    result: '',
    error: runtimeSession?.error || '',
    cwd: assistantProject?.cwd || runtimeSession?.cwd || '',
    cwdBasename: '',
    lastConversationId: assistantTask.lastConversationId || '',
    metadata: {
      assistantProjectId: assistantProject?.id || assistantTask.projectId || '',
      assistantTaskId: assistantTask.id,
      assistantExecutionId: assistantExecution?.id || ''
    },
    updatedAt: runtimeSession?.updatedAt || assistantExecution?.updatedAt || assistantTask.updatedAt || ''
  };
}

function chooseTaskFromConversation(
  conversation = null,
  taskStore = null,
  supervisorTaskStoreArg = null,
  {
    assistantTaskStore = null,
    assistantExecutionStore = null,
    assistantProjectStore = null,
    runtimeSessionManager = null
  } = {}
) {
  if (!conversation?.id) return null;
  const supervisorTasks = supervisorTaskStoreArg?.listByConversationId?.(conversation.id, { limit: 50 }) || [];
  const tasks = supervisorTasks.length > 0
    ? supervisorTasks.map(projectTaskRecord).filter(Boolean)
    : (taskStore ? taskStore.list({ conversationId: conversation.id, limit: 50 }) : []);
  const currentTask = conversation?.metadata?.supervisor?.taskMemory?.currentTask
    || conversation?.metadata?.supervisor?.taskMemory?.current
    || null;
  if (currentTask?.sessionId) {
    const matched = tasks.find((entry) => entry.runtimeSessionId === currentTask.sessionId);
    if (matched) return matched;
  }
  if (currentTask?.taskId || currentTask?.sessionId) {
    return {
      id: currentTask.taskId || currentTask.sessionId,
      runtimeSessionId: currentTask.sessionId || '',
      provider: currentTask.provider || '',
      title: currentTask.title || '',
      status: currentTask.status || '',
      summary: currentTask.summary || '',
      result: currentTask.result || '',
      error: currentTask.error || '',
      updatedAt: currentTask.lastUpdateAt || ''
    };
  }
  if (tasks[0]) {
    return tasks[0];
  }

  const workingSet = conversation?.metadata?.assistantDomain?.workingSet || {};
  const assistantTaskId = String(workingSet?.primaryTaskId || '').trim();
  const assistantTask = assistantTaskId
    ? assistantTaskStore?.get?.(assistantTaskId) || null
    : null;
  const activeRuntimeSessionId = String(conversation?.activeRuntimeSessionId || '').trim();
  const executionFromRuntime = activeRuntimeSessionId
    ? assistantExecutionStore?.findByRuntimeSessionId?.(activeRuntimeSessionId) || null
    : null;
  const preferredExecutionId = String(
    executionFromRuntime?.id
      || assistantTask?.activeExecutionIds?.[assistantTask.activeExecutionIds.length - 1]
      || assistantTask?.allExecutionIds?.[assistantTask.allExecutionIds.length - 1]
      || ''
  ).trim();
  const assistantExecution = preferredExecutionId
    ? assistantExecutionStore?.get?.(preferredExecutionId) || executionFromRuntime || null
    : executionFromRuntime;
  const resolvedAssistantTask = assistantTask
    || (assistantExecution?.taskId ? assistantTaskStore?.get?.(assistantExecution.taskId) || null : null);
  const assistantProject = resolvedAssistantTask?.projectId
    ? assistantProjectStore?.get?.(resolvedAssistantTask.projectId) || null
    : null;
  const runtimeSessionId = String(
    activeRuntimeSessionId
      || assistantExecution?.currentRuntimeSessionId
      || ''
  ).trim();
  const runtimeSession = runtimeSessionId
    ? runtimeSessionManager?.getSession?.(runtimeSessionId) || null
    : null;

  return buildAssistantDomainTaskRecord({
    assistantTask: resolvedAssistantTask,
    assistantExecution,
    assistantProject,
    runtimeSession
  });
}

export class AssistantObservationService {
  constructor({
    conversationStore = chatUiConversationStore,
    runtimeSessionManager = agentRuntimeSessionManager,
    taskStore = agentTaskStore,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    deliveryStore = agentChannelDeliveryStore,
    memoryService = assistantMemoryService,
    policyService = assistantPolicyService,
    workspaceStore = assistantWorkspaceStore,
    assistantTaskStore = assistantDomainTaskStore,
    assistantExecutionStore = assistantDomainExecutionStore,
    assistantProjectStore = assistantDomainProjectStore
  } = {}) {
    this.conversationStore = conversationStore;
    this.runtimeSessionManager = runtimeSessionManager;
    this.taskStore = taskStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.deliveryStore = deliveryStore;
    this.memoryService = memoryService;
    this.policyService = policyService;
    this.workspaceStore = workspaceStore;
    this.clarificationStore = assistantClarificationStore;
    this.assistantTaskStore = assistantTaskStore;
    this.assistantExecutionStore = assistantExecutionStore;
    this.assistantProjectStore = assistantProjectStore;
  }

  buildAssistantDomainLink(task = null) {
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

  buildConversationObservation(conversation) {
    const activeRuntime = conversation?.activeRuntimeSessionId
      ? this.runtimeSessionManager.getSession(conversation.activeRuntimeSessionId)
      : null;
    const latestTask = chooseTaskFromConversation(conversation, this.taskStore, this.supervisorTaskStore, {
      assistantTaskStore: this.assistantTaskStore,
      assistantExecutionStore: this.assistantExecutionStore,
      assistantProjectStore: this.assistantProjectStore,
      runtimeSessionManager: this.runtimeSessionManager
    });
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
            assistantDomain: this.buildAssistantDomainLink(latestTask),
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
        if (entry?.cwd) {
          this.workspaceStore.upsert({
            workspaceRef: entry.cwd,
            patch: {
              defaultRuntimeProvider: entry.provider || '',
              metadata: {
                source: 'runtime_session_list'
              }
            }
          });
        }
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

  getRuntimeSessionDetail(sessionId, { eventLimit = 50, rememberMemory = true } = {}) {
    const session = this.runtimeSessionManager.getSession(String(sessionId || ''));
    if (!session) return null;

    const pendingApprovals = this.runtimeSessionManager.approvalService.listPending(session.id);
    const pendingQuestions = this.runtimeSessionManager.listPendingQuestions(session.id)
      .filter((entry) => entry.status === 'pending');
    const events = this.runtimeSessionManager.getEvents(session.id, {
      afterSeq: 0,
      limit: Math.max(1, eventLimit)
    });
    const task = this.supervisorTaskStore.findByRuntimeSessionId(session.id) || this.taskStore.findByRuntimeSessionId(session.id);
    const deliveries = this.deliveryStore.listBySession(session.id, { limit: 20 });
    const turns = this.runtimeSessionManager.listTurns(session.id, { limit: 20 });

    const detail = {
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
    let runtimeSessionMemory = [];
    if (rememberMemory) {
      try {
        runtimeSessionMemory = this.memoryService.rememberRuntimeSessionState({
          runtimeSession: session,
          detail,
          metadata: {
            workspaceRef: session.cwd || '',
            conversationId: session?.metadata?.conversationId || session?.metadata?.source?.conversationId || ''
          }
        });
      } catch {
        runtimeSessionMemory = [];
      }
    }
    return {
      ...detail,
      runtimeSessionMemory
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

    const pendingRuntimeState = getConversationPendingRuntimeState(conversation, this.runtimeSessionManager);
    const activeRuntime = pendingRuntimeState.activeRuntime;
    const pendingApprovals = pendingRuntimeState.pendingApproval
      ? [pendingRuntimeState.pendingApproval]
      : [];
    const pendingQuestions = pendingRuntimeState.pendingQuestion
      ? [pendingRuntimeState.pendingQuestion]
      : [];
    const latestTask = chooseTaskFromConversation(conversation, this.taskStore, this.supervisorTaskStore, {
      assistantTaskStore: this.assistantTaskStore,
      assistantExecutionStore: this.assistantExecutionStore,
      assistantProjectStore: this.assistantProjectStore,
      runtimeSessionManager: this.runtimeSessionManager
    });
    const pendingClarification = conversation?.lastPendingClarificationId
      ? this.clarificationStore.get(conversation.lastPendingClarificationId)
      : this.clarificationStore.getPendingByConversationId(conversation.id);
    const deliveries = this.deliveryStore.listByConversation(conversation.id, {
      limit: Math.max(1, deliveryLimit)
    });

    const workspaceRef = resolveWorkspaceScopeRef({
      conversation,
      runtimeSession: activeRuntime,
      cwd: activeRuntime?.cwd || '',
      metadata: conversation?.metadata || {}
    });
    const workspace = workspaceRef
      ? this.workspaceStore.upsert({
          workspaceRef,
          patch: {
            defaultRuntimeProvider: activeRuntime?.provider || '',
            metadata: {
              source: 'conversation_context'
            }
          }
        })
      : null;

    const scopeRefs = buildScopeRefs({
      conversation,
      runtimeSession: activeRuntime,
      cwd: activeRuntime?.cwd || ''
    });
    const memory = this.memoryService.resolvePreferences({
      conversation,
      runtimeSession: activeRuntime,
      cwd: activeRuntime?.cwd || ''
    });
    const policy = {
      task: scopeRefs.task
        ? this.policyService.listPolicies({
            scope: 'task',
            scopeRef: scopeRefs.task
          })
        : [],
      execution: scopeRefs.execution
        ? this.policyService.listPolicies({
            scope: 'execution',
            scopeRef: scopeRefs.execution
          })
        : [],
      project: scopeRefs.project
        ? this.policyService.listPolicies({
            scope: 'project',
            scopeRef: scopeRefs.project
          })
        : []
    };
    const runtimeSessionMemory = activeRuntime?.id
      ? this.memoryService.listRuntimeSessionMemory({
          sessionId: activeRuntime.id,
          limit: 20
        })
      : [];
    const runtimeSessionAuthorizations = runtimeSessionMemory
      .filter((entry) => entry.kind === 'authorization')
      .flatMap((entry) => Array.isArray(entry.value) ? entry.value : []);

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
            assistantDomain: this.buildAssistantDomainLink(latestTask),
            updatedAt: latestTask.updatedAt || ''
          }
        : null,
      pendingApprovals: pendingApprovals.map((entry) => ({
        approvalId: entry.approvalId,
        turnId: entry.turnId || '',
        sessionId: pendingRuntimeState.pendingApprovalSessionId || '',
        title: entry.title || '',
        summary: entry.summary || '',
        createdAt: entry.createdAt || '',
        rawRequest: entry.rawRequest || null
      })),
      pendingQuestions: pendingQuestions.map((entry) => ({
        questionId: entry.questionId,
        turnId: entry.turnId || '',
        sessionId: pendingRuntimeState.pendingQuestionSessionId || '',
        text: entry.text || '',
        options: entry.options || [],
        createdAt: entry.createdAt || '',
        rawRequest: entry.rawRequest || null
      })),
      pendingClarification: pendingClarification && pendingClarification.status === 'pending'
        ? {
            id: pendingClarification.id,
            question: pendingClarification.question,
            candidates: pendingClarification.candidates || [],
            askedAt: pendingClarification.askedAt || pendingClarification.createdAt || '',
            ttlSec: Number(pendingClarification.ttlSec || 0)
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
      currentTask: conversation?.metadata?.supervisor?.taskMemory?.currentTask || conversation?.metadata?.supervisor?.taskMemory?.current || null,
      assistantState: conversation?.metadata?.assistantCore || null,
      workspace: buildWorkspaceMetadata({ workspace, workspaceRef }),
      memory,
      runtimeSessionMemory,
      runtimeSessionAuthorizations,
      policy
    };
  }

  getWorkspaceContext({ runtimeLimit = 10, conversationLimit = 10 } = {}) {
    const runtimeSessions = this.listRuntimeSessions({ limit: runtimeLimit });
    const conversations = this.listConversations({ limit: conversationLimit });
    const memory = this.memoryService.resolvePreferences({});
    const workspaceEntries = this.workspaceStore.list({ limit: 50 });
    const workspaces = workspaceEntries.map((entry) => buildWorkspaceMetadata({ workspace: entry }));
    const knownCwds = workspaceEntries.map((entry) => ({
      ...buildWorkspaceMetadata({ workspace: entry }),
      aliases: Array.isArray(entry?.aliases) ? entry.aliases : [],
      summary: String(entry?.summary || '').trim(),
      taskIds: Array.isArray(entry?.taskIds) ? entry.taskIds : [],
      openTaskIds: Array.isArray(entry?.openTaskIds) ? entry.openTaskIds : [],
      lastTouchedAt: String(entry?.lastTouchedAt || entry?.updatedAt || '').trim()
    }));
    const policy = {
      person: this.policyService.listPolicies({
        scope: 'person',
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
      workspaces,
      knownCwds,
      runtimeSessions,
      conversations
    };
  }

  getRecentTasks({ limit = 20, conversationId = '' } = {}) {
    const tasks = this.supervisorTaskStore.list({
      conversationId: String(conversationId || ''),
      limit: Math.max(limit * 3, limit)
    }).map(projectTaskRecord).filter(Boolean);
    return tasks.slice(0, Math.max(1, limit));
  }

  getKnownCwds({ recent = true, limit = 20 } = {}) {
    const entries = this.workspaceStore.list({ limit: Math.max(limit * 3, limit) });
    const sorted = recent
      ? [...entries].sort((left, right) => String(right.lastTouchedAt || right.updatedAt || '').localeCompare(String(left.lastTouchedAt || left.updatedAt || '')))
      : entries;
    return sorted.slice(0, Math.max(1, limit)).map((entry) => ({
      ...buildWorkspaceMetadata({ workspace: entry }),
      aliases: Array.isArray(entry?.aliases) ? entry.aliases : [],
      summary: String(entry?.summary || '').trim(),
      taskIds: Array.isArray(entry?.taskIds) ? entry.taskIds : [],
      openTaskIds: Array.isArray(entry?.openTaskIds) ? entry.openTaskIds : [],
      lastTouchedAt: String(entry?.lastTouchedAt || entry?.updatedAt || '').trim()
    }));
  }

  getCwdInfo({ cwd = '', workspaceId = '' } = {}) {
    const normalizedWorkspaceId = String(workspaceId || '').trim();
    const normalizedCwd = normalizeWorkspaceRef(cwd);
    const workspace = normalizedWorkspaceId
      ? this.workspaceStore.list({ limit: 500 }).find((entry) => String(entry?.id || '').trim() === normalizedWorkspaceId) || null
      : this.workspaceStore.getByRef(normalizedCwd);
    if (!workspace) return null;

    const taskIds = Array.isArray(workspace?.taskIds) ? workspace.taskIds : [];
    const openTaskIds = new Set(Array.isArray(workspace?.openTaskIds) ? workspace.openTaskIds : []);
    const linkedTasks = taskIds
      .map((taskId) => this.supervisorTaskStore.get(taskId))
      .filter(Boolean)
      .map((task) => ({
        id: task.id,
        title: task.title || '',
        status: task.status || '',
        conversationId: task.conversationId || '',
        lastConversationId: task.lastConversationId || task.conversationId || '',
        cwd: task.cwd || '',
        cwdBasename: task.cwdBasename || '',
        isOpen: openTaskIds.has(task.id),
        updatedAt: task.updatedAt || task.lastUpdateAt || ''
      }))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));

    return {
      ...buildWorkspaceMetadata({ workspace }),
      aliases: Array.isArray(workspace?.aliases) ? workspace.aliases : [],
      summary: String(workspace?.summary || '').trim(),
      taskIds,
      openTaskIds: Array.from(openTaskIds),
      lastTouchedAt: String(workspace?.lastTouchedAt || workspace?.updatedAt || '').trim(),
      linkedTasks
    };
  }

  searchProjectMemory({ query = '', limit = 10 } = {}) {
    const source = String(query || '').trim().toLowerCase();
    const sourceTasks = this.supervisorTaskStore.list({ limit: Math.max(limit * 5, limit) }).length > 0
      ? this.supervisorTaskStore.list({ limit: Math.max(limit * 5, limit) }).map(projectTaskRecord).filter(Boolean)
      : this.taskStore.list({ limit: Math.max(limit * 5, limit) });
    const taskMatches = sourceTasks
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
        runtimeSessionId: entry.runtimeSessionId || entry.primaryExecutionId || '',
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
