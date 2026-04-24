import supervisorTaskStore from './supervisor-task-store.js';
import {
  finalizeSupervisorTaskMemory,
  normalizeSupervisorTaskMemory,
  upsertSupervisorTaskRecord
} from './supervisor-task-memory.js';
import { buildSupervisorBrief } from './supervisor-brief.js';
import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';

function nowIso() {
  return new Date().toISOString();
}

function toText(value) {
  return String(value || '').trim();
}

export function deriveTaskStatus(session = null, { pendingApproval = null, pendingQuestion = null, fallbackStatus = '' } = {}) {
  if (pendingQuestion) return 'waiting_user';
  if (pendingApproval) return 'waiting_approval';
  return toText(fallbackStatus || session?.status) || 'starting';
}

export function deriveAwaitingState({ pendingApproval = null, pendingQuestion = null } = {}) {
  if (pendingQuestion) {
    return {
      awaitingKind: 'user_input',
      awaitingPayload: {
        questionId: pendingQuestion.questionId || '',
        text: pendingQuestion.text || ''
      }
    };
  }
  if (pendingApproval) {
    return {
      awaitingKind: 'approval',
      awaitingPayload: {
        approvalId: pendingApproval.approvalId || '',
        title: pendingApproval.title || ''
      }
    };
  }
  return {
    awaitingKind: '',
    awaitingPayload: null
  };
}

export function syncSupervisorTaskForRuntimeStart({
  conversation = null,
  session = null,
  supervisorContext = null,
  taskMemory = null,
  pendingApproval = null,
  pendingQuestion = null,
  userInput = '',
  originKind = 'direct',
  activate = true,
  store = supervisorTaskStore
} = {}) {
  if (!conversation?.id || !session?.id) {
    const normalizedTaskMemory = normalizeSupervisorTaskMemory(taskMemory);
    return {
      supervisorTask: null,
      taskMemory: normalizedTaskMemory,
      brief: buildSupervisorBrief({
        taskMemory: normalizedTaskMemory,
        session
      })
    };
  }

  const awaiting = deriveAwaitingState({ pendingApproval, pendingQuestion });
  const status = deriveTaskStatus(session, {
    pendingApproval,
    pendingQuestion,
    fallbackStatus: session.status
  });
  const title = toText(supervisorContext?.title || session.title || userInput || '');
  const summary = toText(supervisorContext?.summary || '');
  const normalizedTaskMemory = normalizeSupervisorTaskMemory(taskMemory);
  const rememberedTask = normalizedTaskMemory.bySession?.[session.id] || null;
  const activeTaskId = toText(normalizedTaskMemory.activeTaskId);
  const supervisorTask = store.upsertForRuntime({
    taskId: rememberedTask?.taskId || activeTaskId || '',
    conversationId: conversation.id,
    runtimeSessionId: session.id,
    provider: session.provider,
    title,
    goal: toText(userInput || rememberedTask?.title || title),
    status,
    summary,
    result: '',
    error: '',
    awaitingKind: awaiting.awaitingKind,
    awaitingPayload: awaiting.awaitingPayload,
    lastUserTurnAt: nowIso(),
    sourceTaskId: supervisorContext?.sourceTaskId || '',
    metadata: {
      originKind: toText(supervisorContext?.kind || originKind),
      sourceTitle: toText(supervisorContext?.sourceTitle),
      sourceProvider: toText(supervisorContext?.sourceProvider),
      sourceStatus: toText(supervisorContext?.sourceStatus)
    }
  });

  const nextTaskMemory = upsertSupervisorTaskRecord(normalizedTaskMemory, session.id, {
    taskId: supervisorTask.id,
    provider: session.provider,
    title,
    status,
    startedAt: session.createdAt || nowIso(),
    lastUpdateAt: session.updatedAt || nowIso(),
    summary,
    result: '',
    error: '',
    originKind: toText(supervisorContext?.kind || originKind),
    sourceTitle: toText(supervisorContext?.sourceTitle),
    sourceProvider: toText(supervisorContext?.sourceProvider),
    sourceStatus: toText(supervisorContext?.sourceStatus),
    pendingApprovalTitle: toText(pendingApproval?.title),
    pendingQuestion: toText(pendingQuestion?.text)
  }, { activate });

  return {
    supervisorTask,
    taskMemory: nextTaskMemory,
    brief: buildSupervisorBrief({
      taskMemory: nextTaskMemory,
      session
    })
  };
}

export function syncSupervisorTaskForRuntimeTerminal({
  conversationId = '',
  session = null,
  taskMemory = null,
  patch = {},
  terminalKind = '',
  store = supervisorTaskStore
} = {}) {
  if (!session?.id) {
    const normalizedTaskMemory = normalizeSupervisorTaskMemory(taskMemory);
    return {
      supervisorTask: null,
      taskMemory: normalizedTaskMemory,
      brief: buildSupervisorBrief({
        taskMemory: normalizedTaskMemory,
        session
      })
    };
  }

  const normalizedTaskMemory = normalizeSupervisorTaskMemory(taskMemory);
  const currentRecord = normalizedTaskMemory.bySession?.[session.id] || null;
  const nextStatus = toText(patch?.status || (terminalKind === 'completed' ? 'completed' : 'failed')) || 'completed';
  const summary = patch?.summary !== undefined ? patch.summary : session.summary;
  const result = patch?.result !== undefined ? patch.result : '';
  const error = patch?.error !== undefined ? patch.error : session.error;
  const supervisorTask = store.upsertForRuntime({
    taskId: toText(patch?.taskId || currentRecord?.taskId),
    conversationId: toText(conversationId),
    runtimeSessionId: session.id,
    provider: session.provider,
    title: toText(patch?.title || currentRecord?.title || session.title),
    goal: toText(currentRecord?.title || session.title),
    status: nextStatus,
    summary,
    result,
    error,
    awaitingKind: '',
    awaitingPayload: null,
    lastAssistantTurnAt: nowIso(),
    metadata: {
      originKind: toText(currentRecord?.originKind)
    }
  });

  const nextTaskMemory = finalizeSupervisorTaskMemory(normalizedTaskMemory, session.id, {
    ...patch,
    taskId: supervisorTask.id
  }, terminalKind);

  return {
    supervisorTask,
    taskMemory: nextTaskMemory,
    brief: buildSupervisorBrief({
      taskMemory: nextTaskMemory,
      session
    })
  };
}

export function syncSupervisorTaskForRuntimeEvent({
  conversation = null,
  session = null,
  event = null,
  taskMemory = null,
  store = supervisorTaskStore
} = {}) {
  if (!session?.id || !event?.type) {
    const normalizedTaskMemory = normalizeSupervisorTaskMemory(taskMemory);
    return {
      supervisorTask: null,
      taskMemory: normalizedTaskMemory,
      brief: buildSupervisorBrief({
        taskMemory: normalizedTaskMemory,
        session
      })
    };
  }

  const pendingApproval = event?.type === AGENT_EVENT_TYPE.APPROVAL_REQUEST
    ? {
        approvalId: event?.payload?.approvalId || '',
        title: event?.payload?.title || ''
      }
    : null;
  const pendingQuestion = event?.type === AGENT_EVENT_TYPE.QUESTION
    ? {
        questionId: event?.payload?.questionId || '',
        text: event?.payload?.text || ''
      }
    : null;

  if ([AGENT_EVENT_TYPE.STARTED, AGENT_EVENT_TYPE.APPROVAL_REQUEST, AGENT_EVENT_TYPE.QUESTION].includes(event.type)) {
    return syncSupervisorTaskForRuntimeStart({
      conversation,
      session,
      supervisorContext: {
        kind: 'direct',
        title: session.title || event?.payload?.title || '',
        summary: ''
      },
      taskMemory,
      pendingApproval,
      pendingQuestion,
      userInput: session.title || '',
      originKind: 'direct',
      activate: conversation?.activeRuntimeSessionId === session.id,
      store
    });
  }

  if (event.type === AGENT_EVENT_TYPE.COMPLETED) {
    return syncSupervisorTaskForRuntimeTerminal({
      conversationId: conversation?.id || '',
      session,
      taskMemory,
      patch: {
        status: 'completed',
        lastUpdateAt: event?.ts || session.updatedAt || nowIso(),
        summary: toText(session.summary || event?.payload?.summary),
        result: toText(event?.payload?.result),
        pendingApprovalTitle: '',
        pendingQuestion: ''
      },
      terminalKind: 'completed',
      store
    });
  }

  if (event.type === AGENT_EVENT_TYPE.FAILED) {
    return syncSupervisorTaskForRuntimeTerminal({
      conversationId: conversation?.id || '',
      session,
      taskMemory,
      patch: {
        status: 'failed',
        lastUpdateAt: event?.ts || session.updatedAt || nowIso(),
        error: toText(event?.payload?.message || session.error),
        pendingApprovalTitle: '',
        pendingQuestion: ''
      },
      terminalKind: 'failed',
      store
    });
  }

  const normalizedTaskMemory = normalizeSupervisorTaskMemory(taskMemory);
  return {
    supervisorTask: null,
    taskMemory: normalizedTaskMemory,
    brief: buildSupervisorBrief({
      taskMemory: normalizedTaskMemory,
      session
    })
  };
}
