import { countOtherActiveSupervisorTasks, pickCurrentSupervisorTask } from './supervisor-task-memory.js';

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function buildCurrentNextSuggestion(current) {
  if (!current || typeof current !== 'object') {
    return '';
  }

  if (current.pendingApprovalTitle) {
    return 'Reply with approval or denial so the task can continue.';
  }

  if (current.pendingQuestion) {
    return 'Reply with the missing information so the task can continue.';
  }

  if (current.status === 'starting' || current.status === 'running') {
    return 'You can wait for completion, ask for a status update, or send /cancel to stop this run.';
  }

  if (current.status === 'completed') {
    if (current.originKind === 'retry_task') {
      return 'You can review this retry result, retry again if needed, or branch into a related task.';
    }
    if (current.originKind === 'return_to_source') {
      return 'You can continue refining the source task, ask for a wrap-up, or branch into a related task.';
    }
    if (current.originKind === 'related_sibling') {
      return 'You can refine this related task, ask for a wrap-up, or branch into another related task.';
    }
    if (current.originKind === 'remembered_follow_up') {
      return 'You can keep revising this continued task, ask for a wrap-up, or branch into a related task.';
    }
    return 'You can ask for a revision, a follow-up change, or start a related task.';
  }

  if (current.status === 'failed') {
    if (current.originKind === 'retry_task' && current.sourceTitle) {
      return `You can retry again, revise the request, or return to "${current.sourceTitle}".`;
    }
    if (current.originKind === 'return_to_source' && current.sourceTitle) {
      return `You can retry the source task, revise it, or start a fresh task from "${current.sourceTitle}".`;
    }
    if (current.originKind === 'remembered_follow_up' && current.sourceTitle) {
      return `You can retry this follow-up task, revise the request, or return to "${current.sourceTitle}".`;
    }
    if (current.originKind === 'related_sibling' && current.sourceTitle) {
      return `You can retry this related task, revise it, or start over from "${current.sourceTitle}".`;
    }
    return 'You can retry this task, revise the request, or start a new one.';
  }

  return '';
}

function buildTaskHeadline(current) {
  const title = String(current?.title || '').trim() || 'Untitled task';
  if (current?.status === 'waiting_approval') {
    return `Task "${title}" is waiting for approval.`;
  }
  if (current?.status === 'waiting_user') {
    return `Task "${title}" is waiting for your reply.`;
  }
  if (current?.status === 'starting' || current?.status === 'running') {
    return `Task "${title}" is in progress.`;
  }
  if (current?.status === 'completed') {
    return `Task "${title}" is completed.`;
  }
  if (current?.status === 'failed') {
    return `Task "${title}" failed.`;
  }
  return '';
}

export function buildSupervisorBrief({ taskMemory, session = null } = {}) {
  const current = pickCurrentSupervisorTask(taskMemory);
  const normalizedTaskMemory = taskMemory && typeof taskMemory === 'object' ? taskMemory : {};
  const lastCompleted = normalizedTaskMemory?.lastCompletedTask || normalizedTaskMemory?.lastCompleted || null;
  const lastFailed = normalizedTaskMemory?.lastFailedTask || normalizedTaskMemory?.lastFailed || null;
  const otherActiveCount = countOtherActiveSupervisorTasks(taskMemory, current?.taskId || current?.sessionId || '');

  if (current) {
    const originSummary = current.sourceTitle
      ? (current.originKind === 'related_sibling'
        ? `Derived from remembered task "${current.sourceTitle}".`
        : (current.originKind === 'retry_task'
          ? `Retrying remembered task "${current.sourceTitle}".`
          : (current.originKind === 'return_to_source'
            ? `Returned to remembered source task "${current.sourceTitle}".`
        : (current.originKind === 'remembered_follow_up'
          ? `Continuing remembered task "${current.sourceTitle}".`
          : ''))))
      : '';
    return {
      kind: 'current',
      title: current.title || 'Untitled task',
      provider: current.provider || session?.provider || '',
      providerLabel: providerLabel(current.provider || session?.provider || ''),
      taskId: current.taskId || current.sessionId || '',
      sessionId: current.sessionId || '',
      status: current.status || session?.status || 'unknown',
      summary: [
        buildTaskHeadline(current),
        String(current.summary || '').trim(),
        originSummary,
        otherActiveCount > 0 ? `${otherActiveCount} other active task(s) are still in flight in this conversation.` : ''
      ].filter(Boolean).join(' '),
      result: String(current.result || '').trim(),
      error: String(current.error || '').trim(),
      waitingReason: current.pendingApprovalTitle
        ? `approval: ${current.pendingApprovalTitle}`
        : (current.pendingQuestion ? `user input: ${current.pendingQuestion}` : ''),
      nextSuggestion: buildCurrentNextSuggestion(current)
    };
  }

  if (lastCompleted) {
    return {
      kind: 'last_completed',
      title: lastCompleted.title || 'Untitled task',
      provider: lastCompleted.provider || '',
      providerLabel: providerLabel(lastCompleted.provider || ''),
      taskId: lastCompleted.taskId || lastCompleted.sessionId || '',
      sessionId: lastCompleted.sessionId || '',
      status: 'completed',
      summary: String(lastCompleted.summary || '').trim(),
      result: String(lastCompleted.result || '').trim(),
      error: '',
      waitingReason: '',
      nextSuggestion: 'You can ask for a revision, a follow-up change, or start a related task.'
    };
  }

  if (lastFailed) {
    return {
      kind: 'last_failed',
      title: lastFailed.title || 'Untitled task',
      provider: lastFailed.provider || '',
      providerLabel: providerLabel(lastFailed.provider || ''),
      taskId: lastFailed.taskId || lastFailed.sessionId || '',
      sessionId: lastFailed.sessionId || '',
      status: 'failed',
      summary: '',
      result: '',
      error: String(lastFailed.error || '').trim(),
      waitingReason: '',
      nextSuggestion: 'You can ask me to retry, revise the task, or start a new one.'
    };
  }

  return {
    kind: 'empty',
    title: '',
    provider: '',
    providerLabel: 'agent',
    taskId: '',
    sessionId: '',
    status: 'idle',
    summary: '',
    result: '',
    error: '',
    waitingReason: '',
    nextSuggestion: ''
  };
}

export default {
  buildSupervisorBrief
};
