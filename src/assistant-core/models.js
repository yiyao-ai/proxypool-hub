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

export const ASSISTANT_RUN_CLOSURE_STATE = Object.freeze({
  ASSISTANT_DONE: 'assistant_done',
  EXECUTOR_DONE: 'executor_done',
  AWAITING_SUMMARY: 'awaiting_summary',
  WAITING_RUNTIME: 'waiting_runtime',
  WAITING_USER: 'waiting_user',
  PARTIAL: 'partial',
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

export function createAssistantRunCheckpoint({
  plan = null,
  completedStepCount = 0,
  toolResults = [],
  lastCompletedStep = null,
  resumable = false
} = {}) {
  return {
    resumable: resumable === true,
    completedStepCount: Number(completedStepCount || 0),
    pendingStepCount: Math.max(0, Number(plan?.steps?.length || 0) - Number(completedStepCount || 0)),
    lastCompletedStep: lastCompletedStep && typeof lastCompletedStep === 'object' ? lastCompletedStep : null,
    toolResults: Array.isArray(toolResults) ? toolResults : [],
    updatedAt: nowIso()
  };
}

export function createPendingClarification({
  conversationId = '',
  question = '',
  candidates = [],
  ttlSec = 1800,
  status = 'pending'
} = {}) {
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    conversationId: String(conversationId || ''),
    askedAt: now,
    question: String(question || ''),
    candidates: Array.isArray(candidates)
      ? candidates.map((entry, index) => ({
          kind: String(entry?.kind || 'free'),
          id: String(entry?.id || `candidate_${index + 1}`),
          label: String(entry?.label || entry?.id || `Candidate ${index + 1}`),
          confidence: Number.isFinite(Number(entry?.confidence)) ? Number(entry.confidence) : undefined
        }))
      : [],
    status: String(status || 'pending'),
    ttlSec: Math.max(0, Number(ttlSec || 0)) || 1800,
    resolution: null,
    createdAt: now,
    updatedAt: now
  };
}
