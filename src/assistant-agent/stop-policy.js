import { ASSISTANT_RUN_CLOSURE_STATE, ASSISTANT_RUN_STATUS } from '../assistant-core/models.js';

function normalizeStatus(value) {
  return String(value || '').trim();
}

function collectSessionCandidates(toolResults = []) {
  return toolResults.flatMap((entry) => {
    const result = entry?.result;
    if (!result || typeof result !== 'object') return [];
    if (result.session?.id) return [result.session];
    if (result.id && result.provider && result.status) return [result];
    return [];
  });
}

function hasPendingContent(toolResults = []) {
  return toolResults.some((entry) => {
    const result = entry?.result;
    if (!result || typeof result !== 'object') return false;
    const approvals = Array.isArray(result.pendingApprovals) ? result.pendingApprovals.length : Number(result.pendingApprovals || 0);
    const questions = Array.isArray(result.pendingQuestions) ? result.pendingQuestions.length : Number(result.pendingQuestions || 0);
    return approvals > 0 || questions > 0;
  });
}

function deriveWaitingReason(toolResults = []) {
  for (const entry of [...toolResults].reverse()) {
    const result = entry?.result;
    const status = normalizeStatus(result?.session?.status || result?.status);
    const approvals = Array.isArray(result?.pendingApprovals) ? result.pendingApprovals.length : Number(result?.pendingApprovals || 0);
    const questions = Array.isArray(result?.pendingQuestions) ? result.pendingQuestions.length : Number(result?.pendingQuestions || 0);
    if (status === 'waiting_approval' || approvals > 0) {
      return 'runtime_waiting_approval';
    }
    if (status === 'waiting_user' || questions > 0) {
      return 'runtime_waiting_user_input';
    }
  }
  return 'runtime_waiting_on_user';
}

export function deriveAssistantRunStopState({
  toolResults = [],
  assistantText = '',
  maxIterationsReached = false
} = {}) {
  const sessions = collectSessionCandidates(toolResults);
  const statuses = sessions.map((entry) => normalizeStatus(entry?.status));
  const hasText = Boolean(String(assistantText || '').trim());
  const hasToolResults = toolResults.length > 0;
  const pendingFound = hasPendingContent(toolResults);

  if (statuses.some((status) => status === 'failed')) {
    return {
      status: ASSISTANT_RUN_STATUS.FAILED,
      closure: ASSISTANT_RUN_CLOSURE_STATE.FAILED,
      reason: 'runtime_failed'
    };
  }

  if (statuses.some((status) => ['waiting_user', 'waiting_approval'].includes(status)) || pendingFound) {
    return {
      status: ASSISTANT_RUN_STATUS.WAITING_USER,
      closure: ASSISTANT_RUN_CLOSURE_STATE.WAITING_USER,
      reason: deriveWaitingReason(toolResults)
    };
  }

  if (statuses.some((status) => ['starting', 'running'].includes(status))) {
    return {
      status: ASSISTANT_RUN_STATUS.WAITING_RUNTIME,
      closure: hasText
        ? ASSISTANT_RUN_CLOSURE_STATE.PARTIAL
        : ASSISTANT_RUN_CLOSURE_STATE.WAITING_RUNTIME,
      reason: hasText ? 'runtime_running_with_partial_reply' : 'runtime_running'
    };
  }

  if (maxIterationsReached && hasToolResults && !hasText) {
    return {
      status: ASSISTANT_RUN_STATUS.COMPLETED,
      closure: ASSISTANT_RUN_CLOSURE_STATE.AWAITING_SUMMARY,
      reason: 'tool_phase_finished_without_assistant_summary'
    };
  }

  if (hasToolResults && !hasText) {
    return {
      status: ASSISTANT_RUN_STATUS.COMPLETED,
      closure: ASSISTANT_RUN_CLOSURE_STATE.EXECUTOR_DONE,
      reason: 'tool_phase_finished'
    };
  }

  return {
    status: ASSISTANT_RUN_STATUS.COMPLETED,
    closure: hasText
      ? ASSISTANT_RUN_CLOSURE_STATE.ASSISTANT_DONE
      : ASSISTANT_RUN_CLOSURE_STATE.EXECUTOR_DONE,
    reason: hasText ? 'assistant_reply_completed' : 'no_follow_up_required'
  };
}

export function deriveAssistantRunStatus(input = {}) {
  return deriveAssistantRunStopState(input).status;
}

export default {
  deriveAssistantRunStatus,
  deriveAssistantRunStopState
};
