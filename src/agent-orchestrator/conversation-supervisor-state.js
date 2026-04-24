import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';
import { buildSupervisorBrief } from './supervisor-brief.js';
import {
  finalizeSupervisorTaskMemory,
  normalizeSupervisorTaskMemory,
  upsertSupervisorTaskRecord
} from './supervisor-task-memory.js';

export function buildConversationSupervisorPatch({ conversation, session, event }) {
  const metadata = {
    ...(conversation?.metadata || {})
  };
  const supervisor = {
    ...((metadata.supervisor && typeof metadata.supervisor === 'object') ? metadata.supervisor : {})
  };
  let taskMemory = normalizeSupervisorTaskMemory(supervisor.taskMemory);
  const sessionId = session?.id || event?.sessionId || null;
  const rememberedTask = sessionId ? taskMemory.bySession?.[sessionId] || null : null;
  const taskId = rememberedTask?.taskId || sessionId;
  const taskTitle = rememberedTask?.title || session?.title || event?.payload?.title || '';
  const taskProvider = rememberedTask?.provider || session?.provider || '';
  const shouldActivate = conversation?.activeTaskId
    ? conversation.activeTaskId === taskId
    : conversation?.activeRuntimeSessionId === sessionId;

  if (event?.type === AGENT_EVENT_TYPE.STARTED && sessionId) {
    taskMemory = upsertSupervisorTaskRecord(taskMemory, sessionId, {
      taskId,
      provider: taskProvider,
      title: taskTitle,
      status: 'running',
      startedAt: event?.ts || new Date().toISOString(),
      lastUpdateAt: event?.ts || new Date().toISOString(),
      summary: '',
      result: ''
    }, { activate: shouldActivate });
  }

  if (event?.type === AGENT_EVENT_TYPE.APPROVAL_REQUEST && sessionId) {
    taskMemory = upsertSupervisorTaskRecord(taskMemory, sessionId, {
      taskId,
      provider: taskProvider,
      title: taskTitle,
      status: 'waiting_approval',
      lastUpdateAt: event?.ts || new Date().toISOString(),
      pendingApprovalTitle: event?.payload?.title || ''
    }, { activate: shouldActivate });
  }

  if (event?.type === AGENT_EVENT_TYPE.QUESTION && sessionId) {
    taskMemory = upsertSupervisorTaskRecord(taskMemory, sessionId, {
      taskId,
      provider: taskProvider,
      title: taskTitle,
      status: 'waiting_user',
      lastUpdateAt: event?.ts || new Date().toISOString(),
      pendingQuestion: event?.payload?.text || ''
    }, { activate: shouldActivate });
  }

  if (event?.type === AGENT_EVENT_TYPE.COMPLETED && sessionId) {
    taskMemory = finalizeSupervisorTaskMemory(taskMemory, sessionId, {
      taskId,
      provider: taskProvider,
      title: taskTitle,
      status: 'completed',
      lastUpdateAt: event?.ts || new Date().toISOString(),
      summary: String(session?.summary || event?.payload?.summary || '').trim(),
      result: String(event?.payload?.result || '').trim(),
      pendingApprovalTitle: '',
      pendingQuestion: ''
    }, 'completed');
  }

  if (event?.type === AGENT_EVENT_TYPE.FAILED && sessionId) {
    taskMemory = finalizeSupervisorTaskMemory(taskMemory, sessionId, {
      taskId,
      provider: taskProvider,
      title: taskTitle,
      status: 'failed',
      lastUpdateAt: event?.ts || new Date().toISOString(),
      error: String(event?.payload?.message || session?.error || '').trim(),
      pendingApprovalTitle: '',
      pendingQuestion: ''
    }, 'failed');
  }

  supervisor.taskMemory = taskMemory;
  supervisor.brief = buildSupervisorBrief({ taskMemory, session });
  metadata.supervisor = supervisor;
  return { metadata };
}

export default {
  buildConversationSupervisorPatch
};
