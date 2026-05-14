function toId(value) {
  return String(value || '').trim();
}

function uniqueIds(values = []) {
  return [...new Set(values.map(toId).filter(Boolean))];
}

function getCurrentTaskSessionId(conversation = null) {
  return toId(
    conversation?.metadata?.supervisor?.taskMemory?.currentTask?.sessionId
    || conversation?.metadata?.supervisor?.taskMemory?.current?.sessionId
  );
}

function listTrackedRuntimeSessionIds(conversation = null) {
  return uniqueIds([
    conversation?.activeRuntimeSessionId,
    ...(Array.isArray(conversation?.trackedRuntimeSessionIds) ? conversation.trackedRuntimeSessionIds : [])
  ]);
}

function findPendingQuestion(runtimeSessionManager, sessionId, questionId) {
  if (!runtimeSessionManager || !sessionId || !questionId) return null;
  return runtimeSessionManager.listPendingQuestions(sessionId)
    .find((entry) => (
      toId(entry?.questionId) === questionId
      && toId(entry?.status) === 'pending'
    )) || null;
}

export function resolvePendingApprovalSessionId(conversation = null, runtimeSessionManager = null) {
  const approvalId = toId(conversation?.lastPendingApprovalId);
  if (!approvalId || !runtimeSessionManager) return '';

  const hintedSessionId = toId(conversation?.lastPendingApprovalSessionId);
  if (hintedSessionId) {
    const hintedApproval = runtimeSessionManager.approvalService?.getApproval?.(hintedSessionId, approvalId);
    if (hintedApproval?.status === 'pending') {
      return hintedSessionId;
    }
  }

  const candidateSessionIds = uniqueIds([
    getCurrentTaskSessionId(conversation),
    ...listTrackedRuntimeSessionIds(conversation)
  ]);

  for (const sessionId of candidateSessionIds) {
    const approval = runtimeSessionManager.approvalService?.getApproval?.(sessionId, approvalId);
    if (approval?.status === 'pending') {
      return sessionId;
    }
  }

  return '';
}

export function resolvePendingQuestionSessionId(conversation = null, runtimeSessionManager = null) {
  const questionId = toId(conversation?.lastPendingQuestionId);
  if (!questionId || !runtimeSessionManager) return '';

  const hintedSessionId = toId(conversation?.lastPendingQuestionSessionId);
  if (hintedSessionId && findPendingQuestion(runtimeSessionManager, hintedSessionId, questionId)) {
    return hintedSessionId;
  }

  const candidateSessionIds = uniqueIds([
    getCurrentTaskSessionId(conversation),
    ...listTrackedRuntimeSessionIds(conversation)
  ]);

  for (const sessionId of candidateSessionIds) {
    if (findPendingQuestion(runtimeSessionManager, sessionId, questionId)) {
      return sessionId;
    }
  }

  return '';
}

export function getConversationPendingRuntimeState(conversation = null, runtimeSessionManager = null) {
  const approvalSessionId = resolvePendingApprovalSessionId(conversation, runtimeSessionManager);
  const questionSessionId = resolvePendingQuestionSessionId(conversation, runtimeSessionManager);
  const activeRuntimeSessionId = toId(conversation?.activeRuntimeSessionId);

  const activeRuntime = activeRuntimeSessionId
    ? runtimeSessionManager?.getSession?.(activeRuntimeSessionId) || null
    : null;
  const pendingApproval = approvalSessionId
    ? runtimeSessionManager?.approvalService?.getApproval?.(approvalSessionId, toId(conversation?.lastPendingApprovalId)) || null
    : null;
  const pendingQuestion = questionSessionId
    ? findPendingQuestion(runtimeSessionManager, questionSessionId, toId(conversation?.lastPendingQuestionId))
    : null;
  const pendingApprovalRuntime = approvalSessionId
    ? runtimeSessionManager?.getSession?.(approvalSessionId) || null
    : null;
  const pendingQuestionRuntime = questionSessionId
    ? runtimeSessionManager?.getSession?.(questionSessionId) || null
    : null;

  return {
    activeRuntime,
    pendingApprovalSessionId: approvalSessionId || '',
    pendingQuestionSessionId: questionSessionId || '',
    pendingApproval,
    pendingQuestion,
    pendingApprovalRuntime,
    pendingQuestionRuntime
  };
}

export function buildPendingRuntimeMarkerPatch(conversation = null, runtimeSessionManager = null) {
  const patch = {};
  const approvalId = toId(conversation?.lastPendingApprovalId);
  const approvalSessionId = resolvePendingApprovalSessionId(conversation, runtimeSessionManager);
  if (approvalId) {
    if (!approvalSessionId) {
      patch.lastPendingApprovalId = null;
      patch.lastPendingApprovalSessionId = null;
    } else if (approvalSessionId !== toId(conversation?.lastPendingApprovalSessionId)) {
      patch.lastPendingApprovalSessionId = approvalSessionId;
    }
  } else if (toId(conversation?.lastPendingApprovalSessionId)) {
    patch.lastPendingApprovalSessionId = null;
  }

  const questionId = toId(conversation?.lastPendingQuestionId);
  const questionSessionId = resolvePendingQuestionSessionId(conversation, runtimeSessionManager);
  if (questionId) {
    if (!questionSessionId) {
      patch.lastPendingQuestionId = null;
      patch.lastPendingQuestionSessionId = null;
    } else if (questionSessionId !== toId(conversation?.lastPendingQuestionSessionId)) {
      patch.lastPendingQuestionSessionId = questionSessionId;
    }
  } else if (toId(conversation?.lastPendingQuestionSessionId)) {
    patch.lastPendingQuestionSessionId = null;
  }

  return patch;
}

export default {
  buildPendingRuntimeMarkerPatch,
  getConversationPendingRuntimeState,
  resolvePendingApprovalSessionId,
  resolvePendingQuestionSessionId
};
