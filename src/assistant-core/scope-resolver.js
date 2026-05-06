function normalizeText(value) {
  return String(value || '').trim();
}

export function normalizeScope(scope = '') {
  const value = normalizeText(scope);
  if (!value) return '';
  if (value === 'global') return 'global_user';
  if (value === 'session') return 'runtime_session';
  return value;
}

export function resolveWorkspaceScopeRef({ conversation = null, runtimeSession = null, cwd = '', metadata = {} } = {}) {
  const explicit = normalizeText(
    metadata?.workspaceId
      || metadata?.workspaceRef
      || conversation?.metadata?.workspaceId
      || runtimeSession?.metadata?.workspaceId
      || cwd
      || runtimeSession?.cwd
  );
  return explicit || '';
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

export function resolveGlobalUserScopeRef({ conversation = null, metadata = {} } = {}) {
  // v2.5: UserProfile 是 per-CliGate-install 单一身份（§7.5）。同一 CliGate
  // 用户在钉钉 / 飞书 / chat-ui 的体验应当共享语言、provider、风格等长期偏好。
  // 因此 global_user scope 默认归一到 'default-user'，仅当上层显式提供
  // metadata.globalUserId / metadata.userId / 对话里登记过 assistantCore.globalUserId
  // 时才采用其他身份（为多用户预留扩展点，但暂未启用）。
  // 不再以 conversation.externalUserId（钉钉用户名 / chat-ui 'local-user'）
  // 作为 global_user 身份——那些值是 channel 标识，不是 CliGate 用户身份。
  const explicit = normalizeText(
    metadata?.globalUserId
      || metadata?.userId
      || conversation?.metadata?.assistantCore?.globalUserId
  );
  return explicit || 'default-user';
}

export function buildScopeRefs({
  conversation = null,
  runtimeSession = null,
  cwd = '',
  metadata = {}
} = {}) {
  return {
    global_user: resolveGlobalUserScopeRef({ conversation, metadata }),
    workspace: resolveWorkspaceScopeRef({ conversation, runtimeSession, cwd, metadata }),
    conversation: normalizeText(conversation?.id),
    runtime_session: normalizeText(runtimeSession?.id)
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
    refs.runtime_session ? { scope: 'runtime_session', scopeRef: refs.runtime_session } : null,
    refs.conversation ? { scope: 'conversation', scopeRef: refs.conversation } : null,
    refs.workspace ? { scope: 'workspace', scopeRef: refs.workspace } : null,
    refs.global_user ? { scope: 'global_user', scopeRef: refs.global_user } : null
  ].filter(Boolean);
}

export default {
  normalizeScope,
  resolveWorkspaceScopeRef,
  resolveGlobalUserScopeRef,
  buildWorkspaceMetadata,
  buildScopeRefs,
  buildScopeCandidates
};
