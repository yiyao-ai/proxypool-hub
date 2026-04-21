import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';
import { buildSupervisorBrief } from './supervisor-brief.js';

export function buildConversationSupervisorPatch({ conversation, session, event }) {
  const metadata = {
    ...(conversation?.metadata || {})
  };
  const supervisor = {
    ...((metadata.supervisor && typeof metadata.supervisor === 'object') ? metadata.supervisor : {})
  };
  const taskMemory = {
    ...((supervisor.taskMemory && typeof supervisor.taskMemory === 'object') ? supervisor.taskMemory : {})
  };

  if (event?.type === AGENT_EVENT_TYPE.STARTED) {
    taskMemory.current = {
      sessionId: session?.id || event?.sessionId || null,
      provider: session?.provider || '',
      title: session?.title || event?.payload?.title || '',
      status: 'running',
      startedAt: event?.ts || new Date().toISOString(),
      lastUpdateAt: event?.ts || new Date().toISOString(),
      summary: '',
      result: ''
    };
  }

  if (event?.type === AGENT_EVENT_TYPE.APPROVAL_REQUEST && taskMemory.current) {
    taskMemory.current.status = 'waiting_approval';
    taskMemory.current.lastUpdateAt = event?.ts || new Date().toISOString();
    taskMemory.current.pendingApprovalTitle = event?.payload?.title || '';
  }

  if (event?.type === AGENT_EVENT_TYPE.QUESTION && taskMemory.current) {
    taskMemory.current.status = 'waiting_user';
    taskMemory.current.lastUpdateAt = event?.ts || new Date().toISOString();
    taskMemory.current.pendingQuestion = event?.payload?.text || '';
  }

  if (event?.type === AGENT_EVENT_TYPE.COMPLETED && taskMemory.current) {
    taskMemory.current.status = 'completed';
    taskMemory.current.lastUpdateAt = event?.ts || new Date().toISOString();
    taskMemory.current.summary = String(session?.summary || event?.payload?.summary || '').trim();
    taskMemory.current.result = String(event?.payload?.result || '').trim();
    taskMemory.lastCompleted = {
      sessionId: taskMemory.current.sessionId,
      provider: taskMemory.current.provider,
      title: taskMemory.current.title,
      completedAt: event?.ts || new Date().toISOString(),
      summary: taskMemory.current.summary,
      result: taskMemory.current.result
    };
  }

  if (event?.type === AGENT_EVENT_TYPE.FAILED && taskMemory.current) {
    taskMemory.current.status = 'failed';
    taskMemory.current.lastUpdateAt = event?.ts || new Date().toISOString();
    taskMemory.current.error = String(event?.payload?.message || session?.error || '').trim();
    taskMemory.lastFailed = {
      sessionId: taskMemory.current.sessionId,
      provider: taskMemory.current.provider,
      title: taskMemory.current.title,
      failedAt: event?.ts || new Date().toISOString(),
      error: taskMemory.current.error
    };
  }

  supervisor.taskMemory = taskMemory;
  supervisor.brief = buildSupervisorBrief({ taskMemory, session });
  metadata.supervisor = supervisor;
  return { metadata };
}

export default {
  buildConversationSupervisorPatch
};
