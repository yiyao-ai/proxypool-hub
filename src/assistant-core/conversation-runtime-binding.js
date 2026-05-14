import { CHANNEL_CONVERSATION_MODE } from '../agent-channels/models.js';
import { syncSupervisorTaskForRuntimeStart } from '../agent-orchestrator/supervisor-task-sync.js';
import { buildConversationSupervisorPatch } from '../agent-orchestrator/conversation-supervisor-state.js';
import { syncSupervisorTaskForRuntimeEvent } from '../agent-orchestrator/supervisor-task-sync.js';

// Migration-time facade for conversation aggregate patches only.
// This file must not become a new business truth source; durable facts belong in StateCoordinator/domain stores.
function findPendingQuestion(messageService, sessionId = '') {
  return messageService.listPendingQuestions(sessionId)
    .find((entry) => entry.status === 'pending') || null;
}

export function bindConversationToRuntimeStart({
  conversationStore,
  messageService,
  supervisorTaskStore,
  conversation,
  session,
  supervisorContext = {},
  userInput = '',
  originKind = 'direct',
  activate = true,
  assistantMetadata = null
} = {}) {
  if (!conversationStore || !messageService || !conversation?.id || !session?.id) {
    return null;
  }

  const latestConversation = conversationStore.get(conversation.id) || conversation;
  const pendingApproval = messageService.listPendingApprovals(session.id)[0] || null;
  const pendingQuestion = findPendingQuestion(messageService, session.id);
  const synced = syncSupervisorTaskForRuntimeStart({
    conversation: latestConversation,
    session,
    supervisorContext,
    taskMemory: latestConversation.metadata?.supervisor?.taskMemory || null,
    pendingApproval,
    pendingQuestion,
    userInput,
    originKind: String(originKind || '').trim() || 'direct',
    activate,
    store: supervisorTaskStore
  });

  return conversationStore.bindRuntimeSession(conversation.id, session.id, {
    mode: CHANNEL_CONVERSATION_MODE.AGENT_RUNTIME,
    lastPendingApprovalId: pendingApproval?.approvalId || null,
    lastPendingApprovalSessionId: pendingApproval ? session.id : null,
    lastPendingQuestionId: pendingQuestion?.questionId || null,
    lastPendingQuestionSessionId: pendingQuestion ? session.id : null,
    activeTaskId: synced.taskMemory?.activeTaskId || latestConversation.activeTaskId || null,
    trackedTaskIds: synced.taskMemory?.taskOrder || latestConversation.trackedTaskIds || [],
    metadata: {
      ...(latestConversation.metadata || {}),
      ...(assistantMetadata ? { assistantCore: assistantMetadata } : {}),
      supervisor: {
        ...((latestConversation.metadata?.supervisor && typeof latestConversation.metadata.supervisor === 'object')
          ? latestConversation.metadata.supervisor
          : {}),
        taskMemory: synced.taskMemory,
        brief: synced.brief
      }
    }
  });
}

export function buildPendingResolutionPatch(kind = '') {
  const normalized = String(kind || '').trim();
  if (normalized === 'approval') {
    return {
      lastPendingApprovalId: null,
      lastPendingApprovalSessionId: null
    };
  }
  if (normalized === 'question') {
    return {
      lastPendingQuestionId: null,
      lastPendingQuestionSessionId: null
    };
  }
  return {};
}

export function buildPendingRuntimeEventPatch(event = null) {
  const eventType = String(event?.type || '').trim();
  if (eventType === 'worker.approval_request') {
    return {
      lastPendingApprovalId: event?.payload?.approvalId || null,
      lastPendingApprovalSessionId: event?.sessionId || null
    };
  }
  if (eventType === 'worker.approval_resolved') {
    return {
      lastPendingApprovalId: null,
      lastPendingApprovalSessionId: null
    };
  }
  if (eventType === 'worker.question') {
    return {
      lastPendingQuestionId: event?.payload?.questionId || null,
      lastPendingQuestionSessionId: event?.sessionId || null
    };
  }
  if (eventType === 'worker.completed' || eventType === 'worker.failed') {
    return {
      lastPendingApprovalId: null,
      lastPendingApprovalSessionId: null,
      lastPendingQuestionId: null,
      lastPendingQuestionSessionId: null
    };
  }
  return {};
}

export function buildConversationRuntimeEventPatch({
  conversation = null,
  session = null,
  event = null,
  supervisorTaskStore = null
} = {}) {
  if (!conversation?.id || !event?.type) {
    return {};
  }

  const taskIdFromSession = String(session?.metadata?.taskId || '').trim();
  const normalizedSession = taskIdFromSession
    ? {
        ...session,
        metadata: {
          ...(session?.metadata || {}),
          taskId: taskIdFromSession
        }
      }
    : session;
  const supervisorPatch = buildConversationSupervisorPatch({
    conversation,
    session: normalizedSession,
    event
  });
  const synced = syncSupervisorTaskForRuntimeEvent({
    conversation,
    session: normalizedSession,
    event,
    taskMemory: supervisorPatch?.metadata?.supervisor?.taskMemory || conversation?.metadata?.supervisor?.taskMemory || null,
    store: supervisorTaskStore
  });

  return {
    ...supervisorPatch,
    ...buildPendingRuntimeEventPatch(event),
    metadata: {
      ...(supervisorPatch?.metadata || {}),
      supervisor: {
        ...((supervisorPatch?.metadata?.supervisor && typeof supervisorPatch.metadata.supervisor === 'object')
          ? supervisorPatch.metadata.supervisor
          : {}),
        taskMemory: synced.taskMemory,
        brief: synced.brief
      }
    }
  };
}

export default {
  bindConversationToRuntimeStart,
  buildPendingResolutionPatch,
  buildPendingRuntimeEventPatch,
  buildConversationRuntimeEventPatch
};
