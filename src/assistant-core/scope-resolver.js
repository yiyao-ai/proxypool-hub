function normalizeText(value) {
  return String(value || '').trim();
}

function looksLikeWorkspacePath(value = '') {
  const text = normalizeText(value);
  if (!text) return false;
  return /^[A-Za-z]:[\\/]/.test(text)
    || text.startsWith('\\\\')
    || text.startsWith('/');
}

const CANONICAL_SCOPE_BY_ALIAS = {
  execution: 'execution',
  runtime_session: 'execution',
  session: 'execution',
  task: 'task',
  conversation: 'task',
  project: 'project',
  workspace: 'project',
  person: 'person',
  global_user: 'person',
  global: 'person'
};

const LEGACY_SCOPE_ALIASES = {
  execution: ['runtime_session', 'session'],
  task: ['conversation'],
  project: ['workspace'],
  person: ['global_user', 'global']
};

export function normalizeScope(scope = '') {
  const value = normalizeText(scope);
  if (!value) return '';
  return CANONICAL_SCOPE_BY_ALIAS[value] || value;
}

export function listCompatibleScopes(scope = '') {
  const canonical = normalizeScope(scope);
  if (!canonical) return [];
  return [canonical, ...(LEGACY_SCOPE_ALIASES[canonical] || [])];
}

export function resolveWorkspaceScopeRef({ conversation = null, runtimeSession = null, cwd = '', metadata = {} } = {}) {
  const projectLike = [
    metadata?.workspaceId,
    metadata?.workspaceRef,
    conversation?.metadata?.workspaceId,
    cwd,
    runtimeSession?.cwd
  ].map(normalizeText).find(looksLikeWorkspacePath);
  if (projectLike) {
    return projectLike;
  }

  const fallback = [
    metadata?.projectId,
    metadata?.assistantProjectId,
    conversation?.metadata?.assistantDomain?.workingSet?.primaryProjectId,
    runtimeSession?.metadata?.assistantProjectId,
    runtimeSession?.metadata?.workspaceId
  ].map(normalizeText).find(Boolean);
  return fallback || '';
}

export function buildWorkspaceMetadata({ workspace = null, workspaceRef = '' } = {}) {
  const ref = normalizeText(workspace?.workspaceRef || workspaceRef);
  if (!ref) return null;
  return {
    id: normalizeText(workspace?.id),
    workspaceRef: ref,
    name: normalizeText(workspace?.name) || ref,
    defaultRuntimeProvider: normalizeText(workspace?.defaultRuntimeProvider),
    allowedScopeBoundary: normalizeText(workspace?.allowedScopeBoundary) || ref
  };
}

export function resolveGlobalUserScopeRef({ conversation = null, runtimeSession = null, metadata = {} } = {}) {
  // v2.5: UserProfile 是 per-CliGate-install 单一身份（§7.5）。同一 CliGate
  // 用户在钉钉 / 飞书 / chat-ui 的体验应当共享语言、provider、风格等长期偏好。
  // 因此 global_user scope 默认归一到 'default-user'，仅当上层显式提供
  // metadata.globalUserId / metadata.userId / 对话里登记过 assistantCore.globalUserId
  // 时才采用其他身份（为多用户预留扩展点，但暂未启用）。
  // 不再以 conversation.externalUserId（钉钉用户名 / chat-ui 'local-user'）
  // 作为 global_user 身份——那些值是 channel 标识，不是 CliGate 用户身份。
  const explicit = normalizeText(
    metadata?.personId
      || metadata?.assistantPersonId
      || metadata?.globalUserId
      || metadata?.userId
      || conversation?.metadata?.assistantDomain?.workingSet?.primaryPersonId
      || runtimeSession?.metadata?.assistantPersonId
      || conversation?.metadata?.assistantCore?.globalUserId
  );
  return explicit || 'default-user';
}

export function resolveTaskScopeRef({ conversation = null, runtimeSession = null, metadata = {} } = {}) {
  // CRITICAL: when a runtime session is present, its metadata.taskId is the
  // authoritative task for THIS execution and is the only source both the
  // policy-store path (resolveApproval) and the policy-lookup path
  // (session-manager.onApprovalRequest) can see consistently. Putting the
  // conversation-level working-set fallback ahead of this caused the two
  // paths to compute different scopeRefs (working set is a stale focus hint
  // that lags real task creation), which silently broke every remembered
  // approval at task scope — even wildcard policies never matched.
  const explicit = normalizeText(
    metadata?.taskId
      || metadata?.assistantTaskId
      || runtimeSession?.metadata?.taskId
      || runtimeSession?.metadata?.assistantTaskId
      || conversation?.metadata?.assistantDomain?.workingSet?.primaryTaskId
      || conversation?.metadata?.supervisor?.taskMemory?.activeTaskId
      || conversation?.id
  );
  return explicit || '';
}

export function resolveExecutionScopeRef({ runtimeSession = null, metadata = {} } = {}) {
  return normalizeText(
    metadata?.executionId
      || metadata?.assistantExecutionId
      || metadata?.runtimeSessionId
      || runtimeSession?.metadata?.assistantExecutionId
      || runtimeSession?.id
  );
}

export function buildScopeRefs({
  conversation = null,
  runtimeSession = null,
  cwd = '',
  metadata = {}
} = {}) {
  const person = resolveGlobalUserScopeRef({ conversation, runtimeSession, metadata });
  const project = resolveWorkspaceScopeRef({ conversation, runtimeSession, cwd, metadata });
  const task = resolveTaskScopeRef({ conversation, runtimeSession, metadata });
  const execution = resolveExecutionScopeRef({ runtimeSession, metadata });
  return {
    person,
    project,
    task,
    execution,
    global_user: person,
    workspace: project,
    conversation: task,
    runtime_session: execution
  };
}

export function buildScopeCandidates({
  conversation = null,
  runtimeSession = null,
  cwd = '',
  metadata = {}
} = {}) {
  const refs = buildScopeRefs({ conversation, runtimeSession, cwd, metadata });
  return [
    refs.execution ? { scope: 'execution', scopeRef: refs.execution } : null,
    refs.task ? { scope: 'task', scopeRef: refs.task } : null,
    refs.project ? { scope: 'project', scopeRef: refs.project } : null,
    refs.person ? { scope: 'person', scopeRef: refs.person } : null
  ].filter(Boolean);
}

export default {
  normalizeScope,
  listCompatibleScopes,
  resolveWorkspaceScopeRef,
  resolveGlobalUserScopeRef,
  resolveTaskScopeRef,
  resolveExecutionScopeRef,
  buildWorkspaceMetadata,
  buildScopeRefs,
  buildScopeCandidates
};
