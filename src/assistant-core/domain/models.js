import crypto from 'crypto';

function nowIso() {
  return new Date().toISOString();
}

function toText(value) {
  return String(value || '').trim();
}

function normalizeStringList(value, { lowercase = false } = {}) {
  const seen = new Set();
  const list = [];
  for (const entry of Array.isArray(value) ? value : []) {
    const normalized = lowercase
      ? toText(entry).toLowerCase()
      : toText(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    list.push(normalized);
  }
  return list;
}

function normalizeIso(value, fallback = '') {
  const normalized = toText(value);
  if (normalized) return normalized;
  const normalizedFallback = toText(fallback);
  if (normalizedFallback) return normalizedFallback;
  // When BOTH value and fallback are blank, return empty — not nowIso().
  // Defaulting to "now" silently fabricated triggerAt/nextRunAt values that
  // made the scheduler think a half-formed task should fire immediately.
  return '';
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

export function createPerson({
  id = '',
  externalIdentities = [],
  profile = {},
  globalApprovalPolicies = [],
  knownProjectIds = [],
  miscProjectId = '',
  createdAt = '',
  updatedAt = ''
} = {}) {
  const now = nowIso();
  return {
    id: toText(id) || crypto.randomUUID(),
    externalIdentities: (Array.isArray(externalIdentities) ? externalIdentities : [])
      .map((entry) => ({
        channel: toText(entry?.channel).toLowerCase(),
        externalUserId: toText(entry?.externalUserId)
      }))
      .filter((entry) => entry.channel && entry.externalUserId),
    profile: {
      primaryLanguage: toText(profile?.primaryLanguage) || 'zh-CN',
      timezone: toText(profile?.timezone) || 'Asia/Shanghai',
      preferredProvider: toText(profile?.preferredProvider),
      styleHints: normalizeStringList(profile?.styleHints),
      autonomy: normalizeObject(profile?.autonomy)
    },
    globalApprovalPolicies: Array.isArray(globalApprovalPolicies) ? globalApprovalPolicies : [],
    knownProjectIds: normalizeStringList(knownProjectIds),
    miscProjectId: toText(miscProjectId),
    createdAt: normalizeIso(createdAt, now),
    updatedAt: normalizeIso(updatedAt, now)
  };
}

export function createProject({
  id = '',
  ownerPersonId = '',
  name = '',
  aliases = [],
  kind = 'misc',
  cwd = '',
  summary = '',
  decisions = [],
  preferredProviders = [],
  approvalPolicies = [],
  autonomy = {},
  state = 'active',
  lastActiveAt = '',
  lastConversationId = '',
  activeTaskIds = [],
  archivedTaskIds = [],
  createdAt = '',
  updatedAt = '',
  metadata = {}
} = {}) {
  const now = nowIso();
  return {
    id: toText(id) || crypto.randomUUID(),
    ownerPersonId: toText(ownerPersonId),
    name: toText(name) || 'Untitled Project',
    aliases: normalizeStringList(aliases, { lowercase: true }),
    kind: toText(kind) === 'code_project' ? 'code_project' : 'misc',
    cwd: toText(cwd),
    summary: toText(summary),
    decisions: Array.isArray(decisions) ? decisions : [],
    preferredProviders: normalizeStringList(preferredProviders),
    approvalPolicies: Array.isArray(approvalPolicies) ? approvalPolicies : [],
    autonomy: normalizeObject(autonomy),
    state: ['active', 'paused', 'archived'].includes(toText(state)) ? toText(state) : 'active',
    lastActiveAt: normalizeIso(lastActiveAt, now),
    lastConversationId: toText(lastConversationId),
    activeTaskIds: normalizeStringList(activeTaskIds),
    archivedTaskIds: normalizeStringList(archivedTaskIds),
    metadata: normalizeObject(metadata),
    createdAt: normalizeIso(createdAt, now),
    updatedAt: normalizeIso(updatedAt, now)
  };
}

export function createTask({
  id = '',
  projectId = '',
  ownerPersonId = '',
  title = '',
  goal = '',
  aliases = [],
  summary = '',
  plan = [],
  todos = [],
  openQuestions = [],
  blockers = [],
  approvalPolicies = [],
  autonomy = {},
  completionCriteria = 'explicit_user_close',
  lifecycleState = 'open',
  lastActiveAt = '',
  lastConversationId = '',
  activeExecutionIds = [],
  allExecutionIds = [],
  postmortem = null,
  idleAutoArchiveDays = 180,
  assistantRationale = null,
  createdAt = '',
  updatedAt = '',
  metadata = {}
} = {}) {
  const now = nowIso();
  return {
    id: toText(id) || crypto.randomUUID(),
    projectId: toText(projectId),
    ownerPersonId: toText(ownerPersonId),
    title: toText(title) || 'Untitled Task',
    goal: toText(goal),
    aliases: normalizeStringList(aliases, { lowercase: true }),
    summary: toText(summary),
    plan: Array.isArray(plan) ? plan : [],
    todos: Array.isArray(todos) ? todos : [],
    openQuestions: Array.isArray(openQuestions) ? openQuestions : [],
    blockers: Array.isArray(blockers) ? blockers : [],
    approvalPolicies: Array.isArray(approvalPolicies) ? approvalPolicies : [],
    autonomy: normalizeObject(autonomy),
    completionCriteria: toText(completionCriteria) === 'deliverable_completed'
      ? 'deliverable_completed'
      : 'explicit_user_close',
    lifecycleState: ['open', 'paused', 'completed', 'failed', 'cancelled'].includes(toText(lifecycleState))
      ? toText(lifecycleState)
      : 'open',
    lastActiveAt: normalizeIso(lastActiveAt, now),
    lastConversationId: toText(lastConversationId),
    activeExecutionIds: normalizeStringList(activeExecutionIds),
    allExecutionIds: normalizeStringList(allExecutionIds),
    postmortem: postmortem && typeof postmortem === 'object' ? postmortem : null,
    idleAutoArchiveDays: Number.isFinite(Number(idleAutoArchiveDays)) ? Math.max(1, Number(idleAutoArchiveDays)) : 180,
    assistantRationale: assistantRationale && typeof assistantRationale === 'object' ? assistantRationale : null,
    metadata: normalizeObject(metadata),
    createdAt: normalizeIso(createdAt, now),
    updatedAt: normalizeIso(updatedAt, now)
  };
}

export function createExecution({
  id = '',
  taskId = '',
  ownerPersonId = '',
  provider = 'codex',
  role = 'free',
  objective = '',
  currentRuntimeSessionId = '',
  runtimeSessionHistory = [],
  providerSessionId = '',
  status = 'spawning',
  lastTurnAt = '',
  lastTurnSummary = '',
  lastMeaningfulProgressAt = '',
  lastInputPreview = '',
  recentScope = [],
  recentCommands = [],
  approvalsResolved = 0,
  questionsAnswered = 0,
  handoffInbox = [],
  autonomy = {},
  assistantRationale = null,
  createdAt = '',
  updatedAt = '',
  metadata = {}
} = {}) {
  const now = nowIso();
  return {
    id: toText(id) || crypto.randomUUID(),
    taskId: toText(taskId),
    ownerPersonId: toText(ownerPersonId),
    provider: toText(provider) || 'codex',
    role: toText(role) || 'free',
    objective: toText(objective),
    currentRuntimeSessionId: toText(currentRuntimeSessionId),
    runtimeSessionHistory: normalizeStringList(runtimeSessionHistory),
    providerSessionId: toText(providerSessionId),
    status: ['spawning', 'ready', 'running', 'waiting_approval', 'waiting_user', 'failed', 'cancelled', 'done'].includes(toText(status))
      ? toText(status)
      : 'spawning',
    lastTurnAt: normalizeIso(lastTurnAt, ''),
    lastTurnSummary: toText(lastTurnSummary),
    lastMeaningfulProgressAt: normalizeIso(lastMeaningfulProgressAt, ''),
    lastInputPreview: toText(lastInputPreview),
    recentScope: normalizeStringList(recentScope),
    recentCommands: normalizeStringList(recentCommands),
    approvalsResolved: Number.isFinite(Number(approvalsResolved)) ? Number(approvalsResolved) : 0,
    questionsAnswered: Number.isFinite(Number(questionsAnswered)) ? Number(questionsAnswered) : 0,
    handoffInbox: Array.isArray(handoffInbox) ? handoffInbox : [],
    autonomy: normalizeObject(autonomy),
    assistantRationale: assistantRationale && typeof assistantRationale === 'object' ? assistantRationale : null,
    metadata: normalizeObject(metadata),
    createdAt: normalizeIso(createdAt, now),
    updatedAt: normalizeIso(updatedAt, now)
  };
}

function normalizeScheduleRecurrence(value) {
  const text = toText(value).toLowerCase();
  return ['once', 'daily', 'weekly', 'monthly', 'yearly'].includes(text) ? text : 'once';
}

function normalizeScheduleDayOfWeek(value) {
  // Stored as an array of integers 0..6 (Sunday=0). Empty array means
  // "not applicable for this recurrence". Validation is enforced by the
  // tool layer; the model just normalizes whatever it was given.
  if (value === null || value === undefined || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  const out = new Set();
  for (const entry of list) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 && entry <= 7) {
      out.add(entry === 7 ? 0 : entry);
    } else {
      const key = String(entry || '').trim().toLowerCase().slice(0, 3);
      const mapping = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      if (Object.prototype.hasOwnProperty.call(mapping, key)) {
        out.add(mapping[key]);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

function normalizeScheduleNumber(value, { min, max } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

function normalizeNotifyTargets(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const kind = toText(entry.kind);
    if (kind !== 'conversation') continue;
    const conversationId = toText(entry.conversationId);
    if (!conversationId || seen.has(conversationId)) continue;
    seen.add(conversationId);
    out.push({ kind, conversationId });
  }
  return out;
}

export function createScheduledTask({
  id = '',
  personId = '',
  projectId = '',
  taskId = '',
  executionId = '',
  kind = 'reminder',
  title = '',
  schedule = {},
  payload = null,
  state = 'scheduled',
  lastRunAt = '',
  nextRunAt = '',
  lastResultPreview = '',
  lastError = '',
  source = 'system',
  createdAt = '',
  updatedAt = '',
  metadata = {},
  // Each task owns a dedicated conversation that scopes its assistant
  // runs. Notifications go to `notifyTargets[]` (separate); the scope
  // conversation never receives outbound pushes and never pollutes any
  // user-facing chat thread.
  scopeConversationId = '',
  // List of external conversations to ping when the task fires. Each
  // entry: { kind: 'conversation', conversationId }. Empty array means
  // background-only execution (run history is still recorded).
  notifyTargets = [],
  // When true, all runs of this task continue the same runtime session
  // (shared LLM context across runs). When false (default) each run
  // starts a fresh runtime, so e.g. "daily PR summary" is a clean slate
  // every morning.
  sharedContext = false,
  // Optional working directory for assistant runs.
  cwd = ''
} = {}) {
  const now = nowIso();
  const normalizedSchedule = schedule && typeof schedule === 'object' ? schedule : {};
  return {
    id: toText(id) || crypto.randomUUID(),
    personId: toText(personId),
    projectId: toText(projectId),
    taskId: toText(taskId),
    executionId: toText(executionId),
    kind: ['check_in', 'reminder', 'run_task', 'retry', 'summarize'].includes(toText(kind))
      ? toText(kind)
      : 'reminder',
    title: toText(title) || 'Untitled Scheduled Task',
    // Declarative schedule: the LLM passes recurrence + wall-clock fields,
    // the scheduler recomputes the next firing instant from these every
    // time. We deliberately do NOT store a fixed UTC anchor here — anchors
    // drift across DST and lead to "fired at the wrong wall-clock time
    // tomorrow" bugs.
    schedule: {
      recurrence: normalizeScheduleRecurrence(normalizedSchedule.recurrence),
      timezone: toText(normalizedSchedule.timezone) || 'Asia/Shanghai',
      localTime: toText(normalizedSchedule.localTime),
      dayOfWeek: normalizeScheduleDayOfWeek(normalizedSchedule.dayOfWeek),
      dayOfMonth: normalizeScheduleNumber(normalizedSchedule.dayOfMonth, { min: 1, max: 31 }),
      month: normalizeScheduleNumber(normalizedSchedule.month, { min: 1, max: 12 }),
      date: toText(normalizedSchedule.date)
    },
    payload: payload && typeof payload === 'object' ? payload : null,
    state: ['scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'].includes(toText(state))
      ? toText(state)
      : 'scheduled',
    lastRunAt: normalizeIso(lastRunAt, ''),
    nextRunAt: normalizeIso(nextRunAt, ''),
    lastResultPreview: toText(lastResultPreview),
    lastError: toText(lastError),
    source: toText(source) || 'system',
    metadata: normalizeObject(metadata),
    scopeConversationId: toText(scopeConversationId),
    notifyTargets: normalizeNotifyTargets(notifyTargets),
    sharedContext: Boolean(sharedContext),
    cwd: toText(cwd),
    createdAt: normalizeIso(createdAt, now),
    updatedAt: normalizeIso(updatedAt, now)
  };
}

export function createEpisode({
  id = '',
  kind = '',
  personId = '',
  projectId = '',
  taskId = '',
  executionId = '',
  runtimeSessionId = '',
  conversationId = '',
  payload = {},
  createdAt = '',
  metadata = {}
} = {}) {
  const now = nowIso();
  return {
    id: toText(id) || crypto.randomUUID(),
    kind: toText(kind) || 'unknown',
    personId: toText(personId),
    projectId: toText(projectId),
    taskId: toText(taskId),
    executionId: toText(executionId),
    runtimeSessionId: toText(runtimeSessionId),
    conversationId: toText(conversationId),
    payload: normalizeObject(payload),
    metadata: normalizeObject(metadata),
    createdAt: normalizeIso(createdAt, now)
  };
}

export function normalizeConversationWorkingSet(value = {}) {
  const source = normalizeObject(value);
  return {
    primaryProjectId: toText(source.primaryProjectId),
    primaryTaskId: toText(source.primaryTaskId),
    recentTaskIds: normalizeStringList(source.recentTaskIds).slice(0, 10),
    mentionedProjectIds: normalizeStringList(source.mentionedProjectIds).slice(0, 5)
  };
}

export function normalizeRecentMessages(value, limit = 20) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => ({
      role: toText(entry?.role) || 'user',
      text: toText(entry?.text),
      createdAt: normalizeIso(entry?.createdAt, nowIso())
    }))
    .filter((entry) => entry.text)
    .slice(-Math.max(1, limit));
}

export function buildStructuredRationale(value = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    routeReason: toText(value.routeReason),
    candidateEvidence: Array.isArray(value.candidateEvidence) ? value.candidateEvidence : [],
    approvalReason: toText(value.approvalReason),
    presentationReason: toText(value.presentationReason),
    updatedAt: nowIso()
  };
}

export function appendUniqueId(list, id, limit = 50) {
  const normalizedId = toText(id);
  if (!normalizedId) {
    return normalizeStringList(list).slice(-Math.max(1, limit));
  }
  return normalizeStringList([...(Array.isArray(list) ? list : []), normalizedId]).slice(-Math.max(1, limit));
}

export { nowIso, toText, normalizeStringList, normalizeObject };
