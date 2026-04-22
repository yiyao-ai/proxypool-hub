import crypto from 'crypto';

export const AGENT_SESSION_STATUS = Object.freeze({
  STARTING: 'starting',
  RUNNING: 'running',
  WAITING_USER: 'waiting_user',
  WAITING_APPROVAL: 'waiting_approval',
  READY: 'ready',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export const AGENT_EVENT_TYPE = Object.freeze({
  STARTED: 'worker.started',
  PROGRESS: 'worker.progress',
  MESSAGE: 'worker.message',
  COMMAND: 'worker.command',
  FILE_CHANGE: 'worker.file_change',
  QUESTION: 'worker.question',
  APPROVAL_REQUEST: 'worker.approval_request',
  APPROVAL_RESOLVED: 'worker.approval_resolved',
  COMPLETED: 'worker.completed',
  FAILED: 'worker.failed'
});

export const AGENT_TURN_STATUS = Object.freeze({
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  WAITING_USER: 'waiting_user',
  READY: 'ready',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

export function createAgentSession({
  provider,
  input,
  cwd = process.cwd(),
  model = '',
  title = '',
  metadata = {}
} = {}) {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    provider,
    status: AGENT_SESSION_STATUS.STARTING,
    cwd,
    model,
    title: title || summarizeTitle(input),
    summary: '',
    createdAt: now,
    updatedAt: now,
    providerSessionId: null,
    currentTurnId: null,
    turnCount: 0,
    pid: null,
    error: null,
    metadata
  };
}

export function createAgentEvent(sessionId, seq, type, payload = {}) {
  return {
    sessionId,
    turnId: payload?.turnId || null,
    seq,
    ts: new Date().toISOString(),
    type,
    payload
  };
}

export function createAgentTurn({
  sessionId,
  turnId,
  input = '',
  status = AGENT_TURN_STATUS.RUNNING,
  summary = '',
  error = null,
  eventCount = 0,
  stats = {}
} = {}) {
  const now = new Date().toISOString();
  return {
    id: String(turnId || crypto.randomUUID()),
    sessionId: String(sessionId || ''),
    status,
    input: String(input || ''),
    summary: String(summary || ''),
    error,
    eventCount: Number(eventCount || 0),
    stats: {
      messageCount: Number(stats?.messageCount || 0),
      commandCount: Number(stats?.commandCount || 0),
      fileChangeCount: Number(stats?.fileChangeCount || 0),
      approvalCount: Number(stats?.approvalCount || 0),
      approvalResolvedCount: Number(stats?.approvalResolvedCount || 0),
      questionCount: Number(stats?.questionCount || 0),
      failureCount: Number(stats?.failureCount || 0),
      lastMessage: String(stats?.lastMessage || '')
    },
    startedAt: now,
    completedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

export function summarizeTitle(input) {
  const text = String(input || '').trim().replace(/\s+/g, ' ');
  return text.slice(0, 80) || 'Untitled agent task';
}

