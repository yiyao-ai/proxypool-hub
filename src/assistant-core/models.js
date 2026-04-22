import crypto from 'crypto';

export const ASSISTANT_CONTROL_MODE = Object.freeze({
  DIRECT_RUNTIME: 'direct-runtime',
  ASSISTANT: 'assistant'
});

export const ASSISTANT_RUN_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_RUNTIME: 'waiting_runtime',
  WAITING_USER: 'waiting_user',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

function nowIso() {
  return new Date().toISOString();
}

export function createAssistantSession({
  conversationId = '',
  title = '',
  metadata = {}
} = {}) {
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    conversationId: String(conversationId || ''),
    title: String(title || 'CliGate Assistant Session'),
    lastRunId: null,
    lastUserMessage: '',
    lastAssistantSummary: '',
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: now,
    updatedAt: now
  };
}

export function createAssistantRun({
  assistantSessionId = '',
  conversationId = '',
  triggerText = '',
  mode = 'one-shot',
  status = ASSISTANT_RUN_STATUS.QUEUED,
  summary = '',
  result = '',
  steps = [],
  relatedRuntimeSessionIds = [],
  metadata = {}
} = {}) {
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    assistantSessionId: String(assistantSessionId || ''),
    conversationId: String(conversationId || ''),
    triggerText: String(triggerText || ''),
    mode: String(mode || 'one-shot'),
    status: String(status || ASSISTANT_RUN_STATUS.QUEUED),
    summary: String(summary || ''),
    result: String(result || ''),
    steps: Array.isArray(steps) ? steps : [],
    relatedRuntimeSessionIds: Array.isArray(relatedRuntimeSessionIds) ? relatedRuntimeSessionIds : [],
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: now,
    updatedAt: now
  };
}
