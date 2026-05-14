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
  return normalized || fallback || nowIso();
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

export function createScheduledTask({
  id = '',
  personId = '',
  projectId = '',
  taskId = '',
  executionId = '',
  kind = 'check_in',
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
  metadata = {}
} = {}) {
  const now = nowIso();
  return {
    id: toText(id) || crypto.randomUUID(),
    personId: toText(personId),
    projectId: toText(projectId),
    taskId: toText(taskId),
    executionId: toText(executionId),
    kind: ['check_in', 'reminder', 'run_task', 'retry', 'summarize'].includes(toText(kind))
      ? toText(kind)
      : 'check_in',
    title: toText(title) || 'Untitled Scheduled Task',
    schedule: {
      type: ['once', 'daily', 'weekly', 'cron'].includes(toText(schedule?.type))
        ? toText(schedule.type)
        : 'once',
      triggerAt: toText(schedule?.triggerAt),
      cron: toText(schedule?.cron),
      timezone: toText(schedule?.timezone) || 'Asia/Shanghai'
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
