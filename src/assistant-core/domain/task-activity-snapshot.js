const ACTIVE_EXECUTION_STATUSES = new Set(['ready', 'running', 'waiting_approval', 'waiting_user']);
const TERMINAL_EXECUTION_STATUSES = new Set(['cancelled', 'done', 'failed']);

export function buildTaskActivitySnapshot(executions = []) {
  const list = Array.isArray(executions) ? executions.filter(Boolean) : [];
  const activeExecutionCount = list.filter((entry) => ACTIVE_EXECUTION_STATUSES.has(String(entry.status || '').trim())).length;
  const hasRunningExecution = list.some((entry) => String(entry.status || '').trim() === 'running');
  const hasPendingApproval = list.some((entry) => String(entry.status || '').trim() === 'waiting_approval');
  const hasPendingQuestion = list.some((entry) => String(entry.status || '').trim() === 'waiting_user');
  const hasBlockingIssue = list.some((entry) => (
    String(entry.status || '').trim() === 'failed'
    || (Array.isArray(entry.handoffInbox) && entry.handoffInbox.some((packet) => String(packet?.kind || '').trim() === 'review_request'))
  ));
  const hasStuckExecution = list.some((entry) => Boolean(entry?.metadata?.stuck === true));
  const allExecutionsTerminal = list.length > 0
    ? list.every((entry) => TERMINAL_EXECUTION_STATUSES.has(String(entry.status || '').trim()))
    : false;

  return {
    activeExecutionCount,
    hasRunningExecution,
    hasPendingApproval,
    hasPendingQuestion,
    hasBlockingIssue,
    hasStuckExecution,
    allExecutionsTerminal
  };
}

export default buildTaskActivitySnapshot;
