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

export function resolveGlobalUserScopeRef({ conversation = null, metadata = {} } = {}) {
  const explicit = normalizeText(
    metadata?.globalUserId
      || metadata?.userId
      || conversation?.externalUserId
      || conversation?.metadata?.assistantCore?.globalUserId
      || conversation?.metadata?.channelContext?.externalUserId
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
  buildScopeRefs,
  buildScopeCandidates
};
