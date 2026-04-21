import agentTaskStore from './task-store.js';

export function syncTaskFromRuntimeResult({
  conversation = null,
  result = null,
  userInput = '',
  store = agentTaskStore
} = {}) {
  const sessionId = String(result?.session?.id || '').trim();
  if (!sessionId) {
    return null;
  }

  const existing = store.findByRuntimeSessionId(sessionId);
  const title = String(
    result?.supervisorContext?.title
    || result?.session?.title
    || userInput
    || existing?.title
    || 'Untitled task'
  ).trim();
  const nextStatus = result?.type === 'runtime_continued'
    ? (existing?.status || result?.session?.status || 'running')
    : (result?.session?.status || 'starting');

  if (existing) {
    return store.save({
      ...existing,
      conversationId: String(conversation?.id || existing.conversationId || ''),
      provider: String(result?.session?.provider || result?.provider || existing.provider || ''),
      title,
      status: nextStatus,
      input: String(userInput || existing.input || ''),
      originKind: String(result?.supervisorContext?.kind || existing.originKind || 'direct'),
      metadata: {
        ...(existing.metadata || {}),
        supervisorContext: result?.supervisorContext || existing.metadata?.supervisorContext || null
      }
    });
  }

  return store.create({
    conversationId: String(conversation?.id || ''),
    runtimeSessionId: sessionId,
    provider: String(result?.session?.provider || result?.provider || ''),
    title,
    status: nextStatus,
    input: String(userInput || ''),
    originKind: String(result?.supervisorContext?.kind || 'direct'),
    metadata: {
      supervisorContext: result?.supervisorContext || null
    }
  });
}

export function syncTaskTerminalState({
  session = null,
  event = null,
  store = agentTaskStore
} = {}) {
  const sessionId = String(event?.sessionId || session?.id || '').trim();
  if (!sessionId) {
    return null;
  }

  const existing = store.findByRuntimeSessionId(sessionId);
  if (!existing) {
    return null;
  }

  if (event?.type === 'worker.completed') {
    return store.save({
      ...existing,
      status: 'completed',
      summary: String(session?.summary || event?.payload?.summary || existing.summary || ''),
      result: String(event?.payload?.result || existing.result || ''),
      error: ''
    });
  }

  if (event?.type === 'worker.failed') {
    return store.save({
      ...existing,
      status: 'failed',
      error: String(event?.payload?.message || session?.error || existing.error || '')
    });
  }

  if (event?.type === 'worker.question') {
    return store.save({
      ...existing,
      status: 'waiting_user'
    });
  }

  if (event?.type === 'worker.approval_request') {
    return store.save({
      ...existing,
      status: 'waiting_approval'
    });
  }

  if (event?.type === 'worker.started') {
    return store.save({
      ...existing,
      status: 'running'
    });
  }

  return existing;
}

export default {
  syncTaskFromRuntimeResult,
  syncTaskTerminalState
};
