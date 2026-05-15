import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentRuntimeApprovalPolicyStore from '../agent-runtime/approval-policy-store.js';
import agentPreferenceStore from '../agent-core/preference-store.js';
import { buildPreferenceSavedMessage, saveConversationPreferences } from '../agent-core/preference-service.js';
import { selectRuntimeProvider } from '../agent-core/provider-selection.js';
import { AGENT_SESSION_STATUS } from '../agent-runtime/models.js';
import { buildSupervisorBrief } from './supervisor-brief.js';
import { AssistantMemoryService } from '../assistant-core/memory-service.js';
import { AssistantPolicyService } from '../assistant-core/policy-service.js';
import { AssistantTaskViewService } from '../assistant-core/task-view-service.js';
import { getAssistantControlMode } from '../assistant-core/assistant-state.js';
import { buildScopeRefs, normalizeScope } from '../assistant-core/scope-resolver.js';
import supervisorTaskStore from './supervisor-task-store.js';
import taskExecutionService, { TaskExecutionService } from './task-execution-service.js';
import { listSupervisorTaskRecords } from './supervisor-task-memory.js';
import stateCoordinator from '../assistant-core/domain/state-coordinator.js';
import agentChannelConversationStore from '../agent-channels/conversation-store.js';
import agentChannelDeliverySender from '../agent-channels/delivery-sender.js';

function parseLeadingCommand(input) {
  const text = String(input || '').trim();
  if (!text.startsWith('/')) {
    return null;
  }

  const match = text.match(/^\/([a-zA-Z-]+)(?:\s+(.+))?$/s);
  if (!match) return null;
  return {
    command: match[1].toLowerCase(),
    args: String(match[2] || '').trim()
  };
}

function parseProviderAlias(command, args) {
  const normalized = String(command || '').toLowerCase();
  if (normalized === 'cx') {
    return {
      provider: 'codex',
      input: String(args || '').trim()
    };
  }
  if (normalized === 'cc') {
    return {
      provider: 'claude-code',
      input: String(args || '').trim()
    };
  }
  return null;
}

function parseAgentCommand(args) {
  const match = String(args || '').match(/^(codex|claude(?:-code)?)\s+(.+)$/is);
  if (!match) return null;
  return {
    provider: match[1].toLowerCase().startsWith('claude') ? 'claude-code' : 'codex',
    input: String(match[2] || '').trim()
  };
}

function parseRuntimeTarget(args) {
  const command = parseLeadingCommand(`/${String(args || '').trim()}`);
  const alias = parseProviderAlias(command?.command, command?.args);
  if (alias) {
    return alias;
  }
  return parseAgentCommand(args);
}

function buildResetResponse(message, activeSessionId = null) {
  return {
    type: 'conversation_reset',
    message,
    previousSessionId: activeSessionId || null
  };
}

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function getTaskMemory(conversation) {
  return conversation?.metadata?.supervisor?.taskMemory || null;
}

function getCurrentTask(conversation) {
  const taskMemory = getTaskMemory(conversation);
  if (!taskMemory || typeof taskMemory !== 'object') return null;
  const activeTaskId = String(taskMemory.activeTaskId || '').trim();
  const byTask = taskMemory.byTask && typeof taskMemory.byTask === 'object'
    ? taskMemory.byTask
    : {};
  if (activeTaskId && byTask[activeTaskId]) {
    return byTask[activeTaskId];
  }
  return taskMemory.currentTask || taskMemory.current || null;
}

function getCurrentTaskSessionId(conversation) {
  return String(getCurrentTask(conversation)?.sessionId || '').trim() || null;
}

function getTrackedSupervisorTasks(conversation, store = supervisorTaskStore) {
  const memoryTasks = listSupervisorTaskRecords(getTaskMemory(conversation));
  const persisted = conversation?.id ? store.listByConversationId(conversation.id, { limit: 50 }) : [];
  if (persisted.length === 0) {
    return memoryTasks.map((entry) => ({
      taskId: String(entry?.taskId || entry?.sessionId || '').trim(),
      sessionId: String(entry?.sessionId || '').trim(),
      provider: String(entry?.provider || '').trim(),
      title: String(entry?.title || '').trim(),
      status: String(entry?.status || '').trim(),
      summary: String(entry?.summary || '').trim(),
      result: String(entry?.result || '').trim(),
      error: String(entry?.error || '').trim(),
      pendingApprovalTitle: String(entry?.pendingApprovalTitle || '').trim(),
      pendingQuestion: String(entry?.pendingQuestion || '').trim()
    })).filter((entry) => entry.taskId);
  }
  return persisted.map((entry) => ({
    taskId: String(entry?.id || '').trim(),
    sessionId: String(entry?.metadata?.latestExecutionId || entry?.metadata?.runtimeSessionId || entry?.primaryExecutionId || '').trim(),
    provider: String(entry?.metadata?.provider || entry?.executorStrategy || '').trim(),
    title: String(entry?.title || '').trim(),
    status: String(entry?.status || '').trim(),
    summary: String(entry?.summary || '').trim(),
    result: String(entry?.result || '').trim(),
    error: String(entry?.error || '').trim(),
    pendingApprovalTitle: String(entry?.awaitingKind === 'approval' ? entry?.awaitingPayload?.title : '').trim(),
    pendingQuestion: String(entry?.awaitingKind === 'user_input' ? entry?.awaitingPayload?.text : '').trim()
  })).filter((entry) => entry.taskId);
}

function isTerminalTaskStatus(status) {
  return ['completed', 'failed', 'cancelled'].includes(String(status || '').trim());
}

function normalizeComparableText(value) {
  return String(value || '').trim().toLowerCase();
}

function tokenizeComparableText(value) {
  return [...new Set(
    normalizeComparableText(value)
      .replace(/[^a-z0-9\u3400-\u9fff]+/g, ' ')
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 2)
  )];
}

function countTokenOverlap(text, candidates = []) {
  const sourceTokens = tokenizeComparableText(text);
  if (sourceTokens.length === 0) return 0;
  const candidateTokens = new Set(candidates.flatMap((entry) => tokenizeComparableText(entry)));
  return sourceTokens.filter((entry) => candidateTokens.has(entry)).length;
}

function isGenericAmbiguousFollowUp(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return [
    /^(继续|继续一下|继续刚才那个|继续这个|接着做|接着来|继续推进|看看进展|看下进展|进展如何|现在怎么样|状态如何)$/i,
    /^(continue|resume|keep going|follow up|status|progress|check progress)$/i
  ].some((pattern) => pattern.test(text));
}

function isDescriptiveTaskFollowUp(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  if (isGenericAmbiguousFollowUp(text)) return false;
  return [
    /(把.+改|改成|修一下|修复|调整|优化|补充|增加|新增|再加|基于刚才|基于这个|另外再做一个|相关任务|继续处理|继续做)/,
    /\b(change|update|fix|revise|add|adjust|refine|continue with|follow up on)\b/i
  ].some((pattern) => pattern.test(text));
}

function isAlternateTaskReference(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return [
    /(另外(那)?个任务|另一个任务|另一个呢|另外那个呢|剩下那个任务|另外一个呢|另一个怎么样了|另外那个怎么样了)/,
    /\b(the other task|another task|the remaining task|the other one)\b/i
  ].some((pattern) => pattern.test(text));
}

function scoreTaskCandidate(task, {
  text = '',
  currentTaskId = '',
  waitingTaskCount = 0
} = {}) {
  let score = 0;
  const normalizedText = normalizeComparableText(text);
  const normalizedTaskId = String(task?.taskId || '').trim();
  const isCurrent = normalizedTaskId && normalizedTaskId === String(currentTaskId || '').trim();

  if (isCurrent) score += 4;
  if (task?.status === 'waiting_user') score += 2;
  if (task?.status === 'waiting_approval') score += 2;
  if (waitingTaskCount === 1 && ['waiting_user', 'waiting_approval'].includes(String(task?.status || '').trim())) {
    score += 3;
  }
  if (normalizedText.includes(normalizeComparableText(task?.provider))) {
    score += 2;
  }

  score += Math.min(6, countTokenOverlap(text, [
    task?.title,
    task?.summary,
    task?.result,
    task?.error,
    task?.pendingApprovalTitle,
    task?.pendingQuestion
  ]) * 2);

  if (isDescriptiveTaskFollowUp(text) && isCurrent) {
    score += 4;
  }

  if (
    ['waiting_user', 'waiting_approval'].includes(String(task?.status || '').trim())
    && !isGenericAmbiguousFollowUp(text)
    && !isNaturalLanguageStatusIntent(text)
  ) {
    score += 1;
  }

  return score;
}

function chooseBestTaskMatch(tasks = [], {
  text = '',
  currentTaskId = ''
} = {}) {
  const waitingTaskCount = tasks.filter((entry) => ['waiting_user', 'waiting_approval'].includes(String(entry?.status || '').trim())).length;
  const ranked = tasks
    .map((task) => ({
      task,
      score: scoreTaskCandidate(task, {
        text,
        currentTaskId,
        waitingTaskCount
      })
    }))
    .sort((left, right) => right.score - left.score);

  const top = ranked[0] || null;
  const second = ranked[1] || null;
  if (!top || top.score <= 0) {
    return null;
  }
  if (second && top.score - second.score < 3 && isGenericAmbiguousFollowUp(text)) {
    return null;
  }
  if (second && top.score - second.score < 2 && top.score < 6) {
    return null;
  }
  return top.task;
}

function selectTaskRoute(conversation, { text = '', parsed = null, activeSession = null } = {}, store = supervisorTaskStore) {
  if (!conversation) {
    return {
      kind: 'none',
      task: null,
      activeTasks: []
    };
  }

  const currentTask = getCurrentTask(conversation);
  const tasks = getTrackedSupervisorTasks(conversation, store);
  const activeTasks = tasks.filter((entry) => !isTerminalTaskStatus(entry.status));
  const waitingTasks = activeTasks.filter((entry) => ['waiting_approval', 'waiting_user'].includes(entry.status));
  const currentTaskId = String(currentTask?.taskId || '').trim();
  const alternateTaskMatch = isAlternateTaskReference(text)
    ? activeTasks.find((entry) => String(entry?.taskId || '').trim() !== currentTaskId) || null
    : null;

  if (alternateTaskMatch) {
    return {
      kind: 'alternate_task',
      task: alternateTaskMatch,
      activeTasks
    };
  }

  if (currentTask?.taskId) {
    const matched = activeTasks.find((entry) => entry.taskId === String(currentTask.taskId).trim())
      || tasks.find((entry) => entry.taskId === String(currentTask.taskId).trim());
    if (matched) {
      return {
        kind: 'current_task',
        task: matched,
        activeTasks
      };
    }
  }

  if (!parsed && waitingTasks.length === 1 && !isNaturalLanguageStatusIntent(text)) {
    return {
      kind: 'single_waiting',
      task: waitingTasks[0],
      activeTasks
    };
  }

  if (!parsed && activeTasks.length === 1 && !isNaturalLanguageStatusIntent(text)) {
    return {
      kind: 'single_active',
      task: activeTasks[0],
      activeTasks
    };
  }

  if (!parsed && activeTasks.length > 1) {
    if (isNaturalLanguageStatusIntent(text)) {
      return {
        kind: 'status_overview',
        task: null,
        activeTasks
      };
    }
    const scoredMatch = chooseBestTaskMatch(activeTasks, {
      text,
      currentTaskId
    });
    if (scoredMatch) {
      return {
        kind: 'scored_match',
        task: scoredMatch,
        activeTasks
      };
    }
    return {
      kind: 'needs_clarification',
      task: null,
      activeTasks
    };
  }

  const activeRuntimeTask = activeSession?.id
    ? activeTasks.find((entry) => entry.sessionId === activeSession.id) || null
    : null;
  return {
    kind: activeRuntimeTask ? 'active_session' : 'none',
    task: activeRuntimeTask,
    activeTasks
  };
}

function buildTaskClarificationResponse(tasks = []) {
  const lines = tasks.slice(0, 5).map((entry, index) => {
    const waiting = entry.pendingApprovalTitle
      ? ` / waiting approval: ${entry.pendingApprovalTitle}`
      : (entry.pendingQuestion ? ` / waiting input: ${entry.pendingQuestion}` : '');
    return `${index + 1}. ${entry.title || entry.taskId} / ${providerLabel(entry.provider)} / ${entry.status || 'unknown'}${waiting}`;
  });
  return {
    type: 'supervisor_clarification',
    message: [
      'There are multiple active tasks in this conversation. Tell me which one to continue, or start a fresh one with /new.',
      lines.length > 0 ? lines.join('\n') : null
    ].filter(Boolean).join('\n')
  };
}

function buildConversationTaskStatusResponse(conversation, tasks = [], session = null) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return buildSupervisorStatusResponse(conversation, session);
  }

  const lines = tasks.slice(0, 5).map((entry, index) => {
    const waiting = entry.pendingApprovalTitle
      ? ` / waiting approval: ${entry.pendingApprovalTitle}`
      : (entry.pendingQuestion ? ` / waiting input: ${entry.pendingQuestion}` : '');
    const summary = String(entry.summary || entry.result || '').trim();
    return [
      `${index + 1}. ${entry.title || entry.taskId} / ${providerLabel(entry.provider)} / ${entry.status || 'unknown'}${waiting}`,
      summary ? `   ${summary}` : null
    ].filter(Boolean).join('\n');
  });

  return {
    type: 'supervisor_status',
    message: [
      `There are ${tasks.length} active task(s) in this conversation.`,
      lines.join('\n')
    ].filter(Boolean).join('\n')
  };
}

function getSupervisorBrief(conversation, session = null) {
  const existing = conversation?.metadata?.supervisor?.brief;
  if (existing && typeof existing === 'object' && existing.kind) {
    return existing;
  }
  return buildSupervisorBrief({
    taskMemory: getTaskMemory(conversation),
    session
  });
}

function getPreferredConversationProvider(conversation, session = null, defaultRuntimeProvider = 'codex') {
  const brief = getSupervisorBrief(conversation, session);
  const currentTask = getCurrentTask(conversation);
  return String(currentTask?.provider || session?.provider || brief?.provider || defaultRuntimeProvider || 'codex');
}

function isPreferenceMemoryIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return /(记住|以后|后续|默认|总是|prefer|always|default)/i.test(text)
    && /(中文|英文|claude|codex|简洁|详细|最小改动|concise|detailed|minimal)/i.test(text);
}

function buildSupervisorStatusResponse(conversation, session = null) {
  const brief = getSupervisorBrief(conversation, session);

  if (brief.kind !== 'empty') {
    return {
      type: 'supervisor_status',
      message: [
        `${brief.kind === 'current' ? 'Current task' : 'Remembered task'}: ${brief.title || 'Untitled task'}`,
        brief.taskId ? `Task ID: ${brief.taskId}` : null,
        `Provider: ${brief.providerLabel || providerLabel(brief.provider)}`,
        `Status: ${brief.status || 'unknown'}`,
        brief.summary ? `Summary: ${brief.summary}` : null,
        brief.result ? `Latest result: ${String(brief.result).slice(0, 400)}` : null,
        brief.error ? `Error: ${brief.error}` : null,
        brief.waitingReason ? `Waiting on: ${brief.waitingReason}` : null,
        brief.nextSuggestion ? `Next: ${brief.nextSuggestion}` : null
      ].filter(Boolean).join('\n')
    };
  }

  return {
    type: 'command_error',
    message: 'No remembered task status is available for this conversation yet.'
  };
}

function uniqueSessionIds(values = []) {
  return [...new Set(
    values
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function resolvePendingApprovalSessionId(service, {
  pendingApprovalId = '',
  pendingApprovalSessionId = '',
  resolvedSessionId = '',
  activeSessionId = '',
  taskSessionId = '',
  taskRoute = null,
  conversation = null
} = {}) {
  const approvalId = String(pendingApprovalId || '').trim();
  if (!approvalId) return null;

  const explicitSessionId = String(pendingApprovalSessionId || '').trim();
  if (explicitSessionId) {
    const approval = service.runtimeSessionManager?.approvalService?.getApproval?.(explicitSessionId, approvalId);
    if (approval?.status === 'pending') {
      return explicitSessionId;
    }
  }

  const candidateSessionIds = uniqueSessionIds([
    taskRoute?.task?.sessionId,
    taskSessionId,
    getCurrentTaskSessionId(conversation),
    resolvedSessionId,
    activeSessionId,
    conversation?.activeRuntimeSessionId,
    ...(Array.isArray(taskRoute?.activeTasks) ? taskRoute.activeTasks.map((entry) => entry?.sessionId) : [])
  ]);

  for (const sessionId of candidateSessionIds) {
    const approval = service.runtimeSessionManager?.approvalService?.getApproval?.(sessionId, approvalId);
    if (approval?.status === 'pending') {
      return sessionId;
    }
  }

  return null;
}

function resolvePendingQuestionSessionId(service, {
  pendingQuestionId = '',
  pendingQuestionSessionId = '',
  resolvedSessionId = '',
  activeSessionId = '',
  taskSessionId = '',
  taskRoute = null,
  conversation = null
} = {}) {
  const questionId = String(pendingQuestionId || '').trim();
  if (!questionId) return null;

  const explicitSessionId = String(pendingQuestionSessionId || '').trim();
  if (explicitSessionId) {
    const pendingQuestion = service.runtimeSessionManager?.listPendingQuestions?.(explicitSessionId)
      ?.find((entry) => entry?.status === 'pending' && String(entry?.questionId || '').trim() === questionId);
    if (pendingQuestion) {
      return explicitSessionId;
    }
  }

  const candidateSessionIds = uniqueSessionIds([
    taskRoute?.task?.sessionId,
    taskSessionId,
    getCurrentTaskSessionId(conversation),
    resolvedSessionId,
    activeSessionId,
    conversation?.activeRuntimeSessionId,
    ...(Array.isArray(taskRoute?.activeTasks) ? taskRoute.activeTasks.map((entry) => entry?.sessionId) : [])
  ]);

  for (const sessionId of candidateSessionIds) {
    const pendingQuestion = service.runtimeSessionManager?.listPendingQuestions?.(sessionId)
      ?.find((entry) => entry?.status === 'pending' && String(entry?.questionId || '').trim() === questionId);
    if (pendingQuestion) {
      return sessionId;
    }
  }

  return null;
}

function isNaturalLanguageStatusIntent(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return false;

  return [
    /^(status|progress|update)\b/i,
    /\b(what('| i)?s the status|how('| i)?s it going|progress update|current status)\b/i,
    /(进展如何|现在进度|现在怎么样|情况如何|状态如何|当前状态|现在什么情况|进展怎么样|目前怎么样)/
  ].some((pattern) => pattern.test(text));
}

function isNaturalLanguageTaskContinueIntent(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return false;

  return [
    /^(continue|resume|follow up|keep going)\b/i,
    /(继续刚才那个|继续这个|接着做|接着改|继续处理|继续推进|把刚才那个继续|继续一下)/
  ].some((pattern) => pattern.test(text));
}

function isRetryTaskIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return [
    /^(重试|再试一次|重新试|retry|try again)/i,
    /(重试刚才那个|重试这个|retry this|retry that)/i
  ].some((pattern) => pattern.test(text));
}

function isReturnToSourceIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return [
    /(回到上一个任务|回到原任务|回到刚才那个任务|回到原来的任务)/,
    /\b(return to (the )?(previous|source|original) task)\b/i
  ].some((pattern) => pattern.test(text));
}

function isRelatedSiblingIntent(input) {
  const text = String(input || '').trim();
  if (!text) return false;
  return [
    /(另外再做一个|基于刚才那个再做一个|相关任务|再做一个|再来一个)/,
    /\b(another one|related task|sibling task|based on that create another)\b/i
  ].some((pattern) => pattern.test(text));
}

function classifyRememberedTaskIntent(input, brief = null) {
  if (!brief || typeof brief !== 'object' || !String(brief.kind || '').trim()) {
    return null;
  }

  if (isRetryTaskIntent(input)) {
    return {
      originKind: 'retry_task',
      reuseTaskIdentity: true
    };
  }

  if (isReturnToSourceIntent(input)) {
    return {
      originKind: 'return_to_source',
      reuseTaskIdentity: false
    };
  }

  if (isRelatedSiblingIntent(input)) {
    return {
      originKind: 'related_sibling',
      reuseTaskIdentity: false
    };
  }

  if (isDescriptiveTaskFollowUp(input) || isNaturalLanguageTaskContinueIntent(input)) {
    return {
      originKind: 'remembered_follow_up',
      reuseTaskIdentity: true
    };
  }

  return null;
}

function shouldStartFreshFromRememberedContext(brief = null) {
  if (!brief || typeof brief !== 'object') return false;
  return ['last_completed', 'last_failed'].includes(String(brief.kind || ''));
}

function buildRememberedContextMessage(brief = null, rememberedIntent = null) {
  const sourceTitle = String(brief?.title || '').trim();
  const originKind = String(rememberedIntent?.originKind || '').trim();
  if (originKind === 'retry_task' && sourceTitle) {
    return `Retrying remembered task "${sourceTitle}" with a fresh execution.`;
  }
  if (originKind === 'return_to_source' && sourceTitle) {
    return `Returning to remembered source task "${sourceTitle}" with a fresh execution.`;
  }
  if (originKind === 'related_sibling' && sourceTitle) {
    return `Started a related task derived from "${sourceTitle}".`;
  }
  if (originKind === 'remembered_follow_up' && sourceTitle) {
    return `Continuing remembered task "${sourceTitle}" with a fresh execution.`;
  }
  if (!sourceTitle) {
    return 'Started a fresh task using remembered conversation context.';
  }
  return `Started a fresh task using remembered conversation context from "${sourceTitle}".`;
}

function buildRememberedSupervisorContext(brief = null, rememberedIntent = null) {
  return {
    kind: String(rememberedIntent?.originKind || 'direct'),
    title: '',
    summary: '',
    sourceTitle: String(brief?.title || '').trim(),
    sourceProvider: String(brief?.provider || '').trim(),
    sourceStatus: String(brief?.status || '').trim()
  };
}

function buildBusyResponse(session, conversation = null) {
  const currentTask = getCurrentTask(conversation);
  const current = session || {};
  const brief = getSupervisorBrief(conversation, session);
  const provider = currentTask?.provider || current.provider || brief.provider;
  const title = currentTask?.title || brief?.title || current.title || '';
  const intro = title
    ? `${brief.providerLabel || providerLabel(provider)} is still busy with "${title}".`
    : `I am still working on the current task with ${providerLabel(provider)}.`;

  if (current.status === AGENT_SESSION_STATUS.WAITING_APPROVAL) {
    return {
      type: 'command_error',
      message: `${intro} It is waiting on a permission decision from you.${brief?.waitingReason ? ` ${brief.waitingReason}.` : ''} Reply with /approve, /deny, or a natural-language reply like “同意” / “拒绝”.`
    };
  }

  if (current.status === AGENT_SESSION_STATUS.WAITING_USER) {
    return {
      type: 'command_error',
      message: `${intro} It still needs your answer before it can continue.${brief?.waitingReason ? ` ${brief.waitingReason}.` : ''} Reply directly to that question and I will pass it along.`
    };
  }

  return {
    type: 'command_error',
    message: `${intro}${brief?.summary ? ` ${brief.summary}.` : ''} Wait for that run to finish, ask for a status update, or send /cancel if you want me to stop it first.`
  };
}

function isSessionBusy(session) {
  return [
    AGENT_SESSION_STATUS.RUNNING,
    AGENT_SESSION_STATUS.WAITING_APPROVAL,
    AGENT_SESSION_STATUS.WAITING_USER,
    AGENT_SESSION_STATUS.STARTING
  ].includes(session?.status);
}

function normalizeDecisionText(input) {
  return String(input || '').trim().toLowerCase();
}

function isApprovalAffirmative(input) {
  const text = normalizeDecisionText(input);
  return /^(同意|可以|允许|继续|行|确认)(?:\s|$|这|该|后|本|给|让|吧)/.test(text)
    || /^(全部同意|都同意|一律同意)(?:\s|$|，|,|。|\.)/.test(text)
    || /^(approve|ok|okay|yes|y)\b/.test(text);
}

function isApprovalNegative(input) {
  const text = normalizeDecisionText(input);
  return /^(拒绝|不行|不要|停止)(?:\s|$|这|该|后|本|给|让|吧)/.test(text)
    || /^(deny|no|n)\b/.test(text);
}

function wantsRememberedApproval(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(后续|以后|本会话|别再问|都允许|全部允许|都同意|全部同意|一律同意|this session|from now on|remember|don'?t ask again)/i.test(text);
}

function wantsExecutionRememberedApproval(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(这个会话|当前会话|本会话|这条会话|runtime session|this session|current session)/i.test(text);
}

function wantsConversationRememberedApproval(input) {
  const text = String(input || '').trim().toLowerCase();
  return /(这个对话|这次对话|当前对话|这个聊天|this conversation|this chat)/i.test(text);
}

function resolveAssistantDomainBinding({
  supervisorTaskStore: supervisorTaskStoreArg,
  runtimeSessionManager,
  taskId = '',
  sessionId = ''
} = {}) {
  const normalizedTaskId = String(taskId || '').trim();
  const normalizedSessionId = String(sessionId || '').trim();
  const supervisorTask = normalizedTaskId
    ? supervisorTaskStoreArg?.get?.(normalizedTaskId) || null
    : (normalizedSessionId ? supervisorTaskStoreArg?.findByRuntimeSessionId?.(normalizedSessionId) || null : null);
  const runtimeSession = normalizedSessionId
    ? runtimeSessionManager?.getSession?.(normalizedSessionId) || null
    : null;
  const metadata = supervisorTask?.metadata && typeof supervisorTask.metadata === 'object'
    ? supervisorTask.metadata
    : {};

  return {
    supervisorTask,
    runtimeSession,
    assistantPersonId: String(metadata.assistantPersonId || runtimeSession?.metadata?.assistantPersonId || '').trim(),
    assistantProjectId: String(metadata.assistantProjectId || runtimeSession?.metadata?.assistantProjectId || '').trim(),
    assistantTaskId: String(metadata.assistantTaskId || runtimeSession?.metadata?.assistantTaskId || '').trim(),
    assistantExecutionId: String(metadata.assistantExecutionId || runtimeSession?.metadata?.assistantExecutionId || '').trim()
  };
}

function toText(value) {
  return String(value || '').trim();
}

function resolveApprovalRememberScope({
  remember = 'none',
  conversation = null,
  runtimeSession = null,
  metadata = {}
} = {}) {
  const normalizedRemember = normalizeScope(String(remember || 'none').trim());
  if (!normalizedRemember || normalizedRemember === 'none') {
    return null;
  }
  const refs = buildScopeRefs({
    conversation,
    runtimeSession,
    metadata
  });
  if (normalizedRemember === 'task') {
    return refs.task
      ? { scope: 'task', scopeRef: refs.task }
      : null;
  }
  if (normalizedRemember === 'project') {
    return refs.project
      ? { scope: 'project', scopeRef: refs.project }
      : null;
  }
  if (normalizedRemember === 'person') {
    return refs.person
      ? { scope: 'person', scopeRef: refs.person }
      : null;
  }
  return refs.execution
    ? { scope: 'execution', scopeRef: refs.execution }
    : null;
}

function resolvePhase2TaskRouting(taskSpace = null, { conversation = null, runtimeSessionManager = null } = {}) {
  if (!taskSpace && conversation) {
    const preferredTaskId = String(conversation?.metadata?.assistantDomain?.workingSet?.primaryTaskId || '').trim();
    const preferredRuntimeSessionId = String(conversation?.activeRuntimeSessionId || '').trim();
    const preferredRuntimeSession = preferredRuntimeSessionId && runtimeSessionManager?.getSession
      ? runtimeSessionManager.getSession(preferredRuntimeSessionId)
      : null;
    return {
      taskSpace: null,
      focusTask: null,
      preferredTaskId,
      preferredRuntimeSessionId,
      canContinuePreferredExecution: Boolean(preferredRuntimeSessionId && preferredRuntimeSession),
      shouldClarify: false,
      shouldPreferStatusOverview: false,
      preferredAction: preferredRuntimeSessionId ? 'continue_focus_task' : '',
      activeTasks: [],
      waitingTasks: []
    };
  }
  const decisionHints = taskSpace?.decisionHints || {};
  const focusTask = taskSpace?.focusTask || null;
  const preferredTaskId = String(decisionHints?.preferredTaskId || focusTask?.taskId || '').trim();
  const preferredRuntimeSessionId = String(
    decisionHints?.focusTaskExecutionContinuity?.preferredRuntimeSessionId
      || focusTask?.runtimeSession?.id
      || focusTask?.task?.runtimeSessionId
      || ''
  ).trim();
  const shouldClarify = decisionHints?.shouldClarify === true;
  const shouldPreferStatusOverview = decisionHints?.shouldPreferStatusOverview === true;
  const preferredAction = String(decisionHints?.preferredAction || '').trim();
  return {
    taskSpace,
    focusTask,
    preferredTaskId,
    preferredRuntimeSessionId,
    canContinuePreferredExecution: decisionHints?.focusTaskExecutionContinuity?.canContinue === true,
    shouldClarify,
    shouldPreferStatusOverview,
    preferredAction,
    activeTasks: Array.isArray(taskSpace?.activeTasks) ? taskSpace.activeTasks : [],
    waitingTasks: Array.isArray(taskSpace?.waitingTasks) ? taskSpace.waitingTasks : []
  };
}

function decidePhase2NaturalLanguageAction({
  text = '',
  parsed = null,
  phase2Route = null,
  taskRoute = null,
  resolvedSessionId = '',
  supervisorBrief = null
} = {}) {
  if (parsed?.command) {
    return { action: 'none' };
  }

  if (phase2Route?.shouldPreferStatusOverview || taskRoute?.kind === 'status_overview') {
    return { action: 'status_overview' };
  }

  if (phase2Route?.shouldClarify || taskRoute?.kind === 'needs_clarification') {
    return { action: 'clarify_task' };
  }

  if (isNaturalLanguageStatusIntent(text)) {
    if ((phase2Route?.activeTasks || []).length > 1 || taskRoute?.activeTasks?.length > 1) {
      return { action: 'status_overview' };
    }
    return { action: 'status_single' };
  }

  if (resolvedSessionId && isNaturalLanguageTaskContinueIntent(text)) {
    return { action: 'continue_existing' };
  }

  if (resolvedSessionId && phase2Route?.canContinuePreferredExecution) {
    return { action: 'continue_existing' };
  }

  const rememberedIntent = !resolvedSessionId
    ? classifyRememberedTaskIntent(text, supervisorBrief)
    : null;
  if (rememberedIntent) {
    return {
      action: 'start_fresh',
      rememberedIntent
    };
  }

  return { action: 'none' };
}

export class AgentOrchestratorMessageService {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    approvalPolicyStore = agentRuntimeApprovalPolicyStore,
    preferenceStore = agentPreferenceStore,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    taskExecutionService: taskExecutionServiceArg = null,
    taskViewService = null,
    memoryService = null,
    policyService = null,
    stateCoordinator: stateCoordinatorArg = stateCoordinator,
    conversationStore = agentChannelConversationStore,
    deliverySender = agentChannelDeliverySender
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.approvalPolicyStore = approvalPolicyStore;
    this.preferenceStore = preferenceStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.taskExecutionService = taskExecutionServiceArg instanceof TaskExecutionService
      ? taskExecutionServiceArg
      : (taskExecutionServiceArg || new TaskExecutionService({
          runtimeSessionManager: this.runtimeSessionManager,
          supervisorTaskStore: this.supervisorTaskStore
        }));
    this.memoryService = memoryService instanceof AssistantMemoryService
      ? memoryService
      : new AssistantMemoryService({
          preferenceStore: this.preferenceStore
        });
    this.taskViewService = taskViewService instanceof AssistantTaskViewService
      ? taskViewService
      : (taskViewService || new AssistantTaskViewService({
          runtimeSessionManager: this.runtimeSessionManager,
          supervisorTaskStore: this.supervisorTaskStore
        }));
    this.policyService = policyService instanceof AssistantPolicyService
      ? policyService
      : new AssistantPolicyService({
          approvalPolicyStore: this.approvalPolicyStore
        });
    this.stateCoordinator = stateCoordinatorArg;
    this.conversationStore = conversationStore;
    this.deliverySender = deliverySender;
  }

  syncConversationAssistantWorkingSet({
    conversation = null,
    taskId = '',
    sessionId = ''
  } = {}) {
    if (!conversation?.id || !this.stateCoordinator) {
      return null;
    }
    const binding = resolveAssistantDomainBinding({
      supervisorTaskStore: this.supervisorTaskStore,
      runtimeSessionManager: this.runtimeSessionManager,
      taskId,
      sessionId
    });
    if (!binding.assistantProjectId && !binding.assistantTaskId) {
      return null;
    }
    try {
      return this.stateCoordinator.updateConversationWorkingSet({
        conversationId: conversation.id,
        patch: {
          primaryProjectId: binding.assistantProjectId,
          primaryTaskId: binding.assistantTaskId,
          recentTaskIds: binding.assistantTaskId ? [binding.assistantTaskId] : [],
          mentionedProjectIds: binding.assistantProjectId ? [binding.assistantProjectId] : []
        }
      });
    } catch {
      return null;
    }
  }

  recordRuntimeEpisode({
    conversation = null,
    sessionId = '',
    taskId = '',
    kind = '',
    payload = {},
    metadata = {}
  } = {}) {
    if (!this.stateCoordinator || !kind) {
      return null;
    }
    const binding = resolveAssistantDomainBinding({
      supervisorTaskStore: this.supervisorTaskStore,
      runtimeSessionManager: this.runtimeSessionManager,
      taskId,
      sessionId
    });
    return this.stateCoordinator.recordRuntimeEpisode({
      kind,
      personId: binding.assistantPersonId,
      projectId: binding.assistantProjectId,
      taskId: binding.assistantTaskId,
      executionId: binding.assistantExecutionId,
      runtimeSessionId: toText(sessionId),
      conversationId: toText(conversation?.id),
      payload,
      metadata: {
        source: 'agent_orchestrator_message_service',
        ...((metadata && typeof metadata === 'object') ? metadata : {})
      }
    });
  }

  async startRuntimeTask({ provider, input, cwd, model = '', metadata = {} } = {}) {
    return this.taskExecutionService.startTaskExecution({
      taskId: metadata?.taskId || '',
      conversationId: metadata?.conversationId || '',
      provider,
      input,
      cwd,
      model,
      role: metadata?.executionRole || 'primary',
      metadata
    });
  }

  async continueRuntimeTask({ sessionId, taskId = '', input } = {}) {
    return this.taskExecutionService.continueTaskExecution({
      taskId,
      sessionId,
      input
    });
  }

  async resolveApproval({
    sessionId,
    approvalId,
    decision,
    remember = 'none',
    conversationId = '',
    conversation = null,
    metadata = {}
  } = {}) {
    const normalizedSessionId = String(sessionId || '');
    const normalizedApprovalId = String(approvalId || '');
    const normalizedDecision = String(decision || '');
    const normalizedRemember = String(remember || 'none');
    const runtimeSession = normalizedSessionId
      ? this.runtimeSessionManager.getSession(normalizedSessionId)
      : null;
    const resolvedConversation = conversation && typeof conversation === 'object'
      ? conversation
      : (conversationId ? { id: String(conversationId || '').trim() } : null);

    // v2.5 Bug 3：在 resolve 之前先抓 approval 详情（resolve 后状态会变），
    // 这样 remember 路径才能拿到 rawRequest / provider 等信息建 policy。
    const approvalSnapshot = normalizedRemember !== 'none' && normalizedDecision === 'approve'
      ? this.runtimeSessionManager.approvalService.getApproval(normalizedSessionId, normalizedApprovalId)
      : null;

    const resolved = await this.runtimeSessionManager.resolveApproval(
      normalizedSessionId,
      normalizedApprovalId,
      normalizedDecision
    );

    let policy = null;
    if (approvalSnapshot && resolved?.status === 'approved' && this.policyService?.rememberApproval) {
      const rememberScope = resolveApprovalRememberScope({
        remember: normalizedRemember,
        conversation: resolvedConversation,
        runtimeSession,
        metadata
      });
      if (rememberScope?.scopeRef) {
        policy = this.policyService.rememberApproval({
          approval: approvalSnapshot,
          scope: rememberScope.scope,
          scopeRef: rememberScope.scopeRef
        });
      }
    }

    if (policy) {
      const enriched = { ...resolved, policy };
      this.recordRuntimeEpisode({
        conversation: resolvedConversation,
        sessionId: normalizedSessionId,
        taskId: metadata?.taskId || '',
        kind: 'runtime.approval_resolved',
        payload: {
          approvalId: normalizedApprovalId,
          decision: enriched.status,
          remember: normalizedRemember,
          policyId: toText(policy?.id)
        }
      });
      return enriched;
    }
    this.recordRuntimeEpisode({
      conversation: resolvedConversation,
      sessionId: normalizedSessionId,
      taskId: metadata?.taskId || '',
      kind: 'runtime.approval_resolved',
      payload: {
        approvalId: normalizedApprovalId,
        decision: resolved?.status || normalizedDecision,
        remember: normalizedRemember
      }
    });
    return resolved;
  }

  async answerQuestion({ sessionId, questionId, answer } = {}) {
    const result = await this.runtimeSessionManager.answerQuestion(
      String(sessionId || ''),
      String(questionId || ''),
      answer
    );
    this.recordRuntimeEpisode({
      sessionId,
      kind: 'runtime.question_answered',
      payload: {
        questionId: toText(questionId),
        answer: toText(answer),
        status: toText(result?.status)
      }
    });
    return result;
  }

  cancelPendingQuestion({ sessionId, questionId, reason = '' } = {}) {
    const result = this.runtimeSessionManager.cancelPendingQuestion(
      String(sessionId || ''),
      String(questionId || ''),
      String(reason || '')
    );
    this.recordRuntimeEpisode({
      sessionId,
      kind: 'runtime.question_cancelled',
      payload: {
        questionId: toText(questionId),
        reason: toText(reason),
        status: toText(result?.status)
      }
    });
    return result;
  }

  cancelRuntimeSession({ sessionId, conversation = null, taskId = '' } = {}) {
    const result = this.runtimeSessionManager.cancelSession(String(sessionId || ''));
    this.recordRuntimeEpisode({
      conversation,
      sessionId,
      taskId,
      kind: 'runtime.cancelled',
      payload: {
        status: toText(result?.status),
        reason: 'user_cancelled'
      }
    });
    return result;
  }

  createExecutionHandoff({
    executionId,
    fromExecutionId = '',
    kind = 'progress',
    title = '',
    payload = null,
    conversationId = ''
  } = {}) {
    return this.stateCoordinator?.addExecutionHandoff?.({
      targetExecutionId: executionId,
      fromExecutionId,
      kind,
      title,
      payload,
      conversationId
    }) || null;
  }

  consumeExecutionHandoff({
    executionId,
    handoffId,
    conversationId = ''
  } = {}) {
    return this.stateCoordinator?.consumeExecutionHandoff?.({
      executionId,
      handoffId,
      conversationId
    }) || null;
  }

  createScheduledTask(input = {}) {
    return this.stateCoordinator?.createScheduledTask?.(input) || null;
  }

  updateScheduledTask(input = {}) {
    return this.stateCoordinator?.updateScheduledTask?.(input) || null;
  }

  cancelScheduledTask(input = {}) {
    return this.stateCoordinator?.cancelScheduledTask?.(input) || null;
  }

  listScheduledTasks({
    conversationId = '',
    includeCompleted = false,
    limit = 50
  } = {}) {
    const store = this.stateCoordinator?.scheduledTaskStore;
    if (!store) return [];
    const states = includeCompleted
      ? ['scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed']
      : ['scheduled', 'running', 'paused'];
    return store.listByConversation(String(conversationId || '').trim(), { limit, states });
  }

  /**
   * Resolve the targets a scheduled-task push should fan out to. Honors the
   * new `notifyTargets[]` shape and migrates the legacy single
   * `payload.conversationId` to the same fan-out path.
   */
  _resolveScheduledTaskNotifyTargets(scheduledTask = {}) {
    const explicit = Array.isArray(scheduledTask.notifyTargets) ? scheduledTask.notifyTargets : [];
    const targets = [];
    const seen = new Set();
    for (const entry of explicit) {
      const conversationId = String(entry?.conversationId || '').trim();
      if (!conversationId || seen.has(conversationId)) continue;
      seen.add(conversationId);
      targets.push({ kind: 'conversation', conversationId });
    }
    const legacy = String(scheduledTask?.payload?.conversationId || '').trim();
    if (legacy && !seen.has(legacy)) {
      seen.add(legacy);
      targets.push({ kind: 'conversation', conversationId: legacy });
    }
    return targets;
  }

  /**
   * Push a tagged notification to each notifyTarget. All deliveries here
   * carry kind='scheduled_task_notification' so the main-conversation LLM
   * context filter can exclude them.
   */
  async _deliverScheduledTaskNotifications({
    scheduledTask,
    runId,
    title,
    bodyText,
    isFailure = false
  } = {}) {
    const targets = this._resolveScheduledTaskNotifyTargets(scheduledTask);
    if (targets.length === 0) {
      return { delivered: 0, results: [] };
    }
    const isZh = /[㐀-鿿]/.test(String(bodyText || title || ''));
    const header = isFailure
      ? (isZh ? `⚠️ 定时任务失败：${title}` : `⚠️ Scheduled task failed: ${title}`)
      : (isZh ? `⏰ 定时任务：${title}` : `⏰ Scheduled task: ${title}`);
    const text = `${header}\n\n${String(bodyText || '').trim()}`;

    const results = [];
    const deliverySender = this.deliverySender;
    if (!deliverySender?.send) {
      return { delivered: 0, results: [] };
    }
    for (const target of targets) {
      const conversation = this.conversationStore?.get?.(target.conversationId) || null;
      if (!conversation?.id) {
        results.push({ conversationId: target.conversationId, ok: false, error: 'conversation_not_found' });
        continue;
      }
      try {
        const delivery = await deliverySender.send({
          conversation,
          channel: conversation.channel,
          sessionId: null,
          payload: {
            text,
            // Single canonical tag — context filters key on this.
            kind: 'scheduled_task_notification',
            sourceType: 'scheduled_task',
            scheduledTaskId: scheduledTask.id,
            scheduledTaskRunId: runId,
            isFailure: Boolean(isFailure)
          },
          message: { text }
        });
        results.push({ conversationId: target.conversationId, ok: true, delivery });
      } catch (err) {
        results.push({ conversationId: target.conversationId, ok: false, error: String(err?.message || err) });
      }
    }
    return { delivered: results.filter((r) => r.ok).length, results };
  }

  async runScheduledTask(task = null) {
    const scheduledTask = task && typeof task === 'object'
      ? task
      : this.stateCoordinator?.scheduledTaskStore?.get?.(String(task || '').trim()) || null;
    if (!scheduledTask?.id) {
      throw new Error('scheduled task not found');
    }

    const payload = scheduledTask.payload && typeof scheduledTask.payload === 'object'
      ? scheduledTask.payload
      : {};
    // Default to "notify_user" for plain reminders. Older callers that
    // already set action='start'/'continue'/'status' still go through the
    // runtime-spawn paths below.
    const action = String(payload.action || (scheduledTask.kind === 'reminder' ? 'notify_user' : 'start')).trim();
    const runId = `run-${scheduledTask.id}-${Date.now()}`;

    if (action === 'invoke_assistant') {
      // Run the assistant in the task's OWN scope conversation, never in
      // any user-facing conversation. The scope conversation is created
      // and bound when the task is created; we look it up here.
      const scopeConvId = String(scheduledTask.scopeConversationId || '').trim();
      if (!scopeConvId) {
        throw new Error('invoke_assistant scheduled task is missing scopeConversationId; recreate the task');
      }
      let scopeConv = this.conversationStore?.get?.(scopeConvId) || null;
      if (!scopeConv?.id) {
        // Lazy-heal: scope conversation got lost — recreate it.
        scopeConv = this.stateCoordinator?.ensureScheduledTaskScopeConversation?.(scheduledTask.id, {
          title: scheduledTask.title
        });
      }
      if (!scopeConv?.id) {
        throw new Error('failed to resolve scope conversation for scheduled task');
      }

      const userText = String(payload.message || scheduledTask.title || '').trim();
      if (!userText) {
        throw new Error('invoke_assistant scheduled task requires payload.message');
      }

      // If this task does NOT share context across runs, detach the active
      // runtime session on the scope conversation so the assistant starts
      // each fire from a fresh slate.
      if (!scheduledTask.sharedContext && scopeConv.activeRuntimeSessionId) {
        try {
          scopeConv = this.conversationStore.clearActiveRuntimeSession(scopeConv.id) || scopeConv;
        } catch {
          // best-effort — if we can't clear, the existing runtime is reused
        }
      }

      // Drive the assistant via the assistant-mode service. We import it
      // dynamically to avoid a static import cycle (mode-service depends
      // on this message-service).
      let assistantResult = null;
      let assistantError = null;
      try {
        const { default: assistantModeService } = await import('../assistant-core/mode-service.js');
        assistantResult = await assistantModeService.maybeHandleMessage({
          conversation: scopeConv,
          text: userText,
          defaultRuntimeProvider: String(payload.provider || 'codex').trim() || 'codex',
          cwd: String(payload.cwd || scheduledTask.cwd || '').trim(),
          model: String(payload.model || '').trim(),
          executionMode: 'sync'
        });
      } catch (err) {
        assistantError = err;
      }

      if (assistantError) {
        // Notify failure to all notifyTargets — the user should know.
        const failureBody = String(assistantError?.message || assistantError || 'unknown failure').slice(0, 500);
        await this._deliverScheduledTaskNotifications({
          scheduledTask,
          runId,
          title: scheduledTask.title,
          bodyText: failureBody,
          isFailure: true
        });
        throw assistantError;
      }

      const immediateMessage = String(assistantResult?.message || '').trim();
      await this._deliverScheduledTaskNotifications({
        scheduledTask,
        runId,
        title: scheduledTask.title,
        bodyText: immediateMessage || (assistantResult?.type ? `[${assistantResult.type}]` : '(no reply)')
      });

      return {
        action,
        scheduledTaskId: scheduledTask.id,
        scheduledTaskRunId: runId,
        scopeConversationId: scopeConv.id,
        assistantRunId: assistantResult?.assistantRun?.id || '',
        summary: `assistant invoked: ${userText.slice(0, 80)}`,
        result: immediateMessage || `assistant ${assistantResult?.type || 'invoked'}`
      };
    }

    if (action === 'notify_user') {
      const targets = this._resolveScheduledTaskNotifyTargets(scheduledTask);
      if (targets.length === 0) {
        throw new Error('notify_user scheduled task has no notifyTargets — nothing to deliver');
      }
      const body = String(payload.message || scheduledTask.title || '到时间了').trim();
      const { delivered, results } = await this._deliverScheduledTaskNotifications({
        scheduledTask,
        runId,
        title: scheduledTask.title,
        bodyText: body
      });
      return {
        action,
        scheduledTaskId: scheduledTask.id,
        scheduledTaskRunId: runId,
        delivered,
        deliveryResults: results,
        summary: `reminder delivered to ${delivered} target(s)`,
        result: body
      };
    }

    // Safety guard for malformed legacy records: an "Untitled Scheduled Task"
    // with no payload and no meaningful input should not spin up a codex
    // session. Refuse so the scheduler marks it failed and stops retrying.
    const title = String(scheduledTask.title || '').trim();
    const hasUsableInput = Boolean(
      (payload && (payload.message || payload.input || payload.task))
      || (title && title !== 'Untitled Scheduled Task')
    );
    if (!hasUsableInput) {
      throw new Error('scheduled task has no usable title/payload; refusing to spawn an empty runtime');
    }

    if (action === 'continue') {
      const session = await this.continueRuntimeTask({
        taskId: String(payload.taskId || scheduledTask.taskId || '').trim(),
        sessionId: String(payload.sessionId || '').trim(),
        input: String(payload.input || payload.message || scheduledTask.title || '').trim()
      });
      return {
        action,
        session,
        summary: `continued runtime session ${session.id}`
      };
    }

    if (action === 'status') {
      const session = this.getRuntimeSession(String(payload.sessionId || '').trim());
      if (!session) {
        throw new Error('runtime session not found');
      }
      return {
        action,
        session,
        summary: `runtime session ${session.id} status: ${session.status || 'unknown'}`
      };
    }

    const session = await this.startRuntimeTask({
      provider: String(payload.provider || 'codex').trim() || 'codex',
      input: String(payload.input || payload.task || scheduledTask.title || '').trim(),
      cwd: String(payload.cwd || '').trim(),
      model: String(payload.model || '').trim(),
      metadata: {
        ...(payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}),
        taskId: String(payload.taskId || scheduledTask.taskId || '').trim(),
        conversationId: String(payload.conversationId || '').trim(),
        executionRole: String(payload.executionRole || 'primary').trim() || 'primary',
        source: {
          kind: 'scheduled-task',
          scheduledTaskId: scheduledTask.id
        }
      }
    });
    return {
      action: 'start',
      session,
      summary: `started runtime session ${session.id}`
    };
  }

  getRuntimeSession(sessionId) {
    return this.runtimeSessionManager.getSession(String(sessionId || ''));
  }

  listPendingQuestions(sessionId) {
    return this.runtimeSessionManager.listPendingQuestions(String(sessionId || ''));
  }

  listPendingApprovals(sessionId) {
    return this.runtimeSessionManager.approvalService.listPending(String(sessionId || ''));
  }

  async routeUserMessage({
    message,
    conversation = null,
    defaultRuntimeProvider = 'codex',
    cwd,
    model = '',
    metadata = {}
  } = {}) {
    const text = String(message?.text || '').trim();
    if (!text) {
      throw new Error('message text is required');
    }
    if (conversation?.id && this.stateCoordinator) {
      try {
        this.stateCoordinator.ingestConversationTurn({
          conversation,
          role: 'user',
          text
        });
      } catch {
        // dual-write should not block existing routing behavior
      }
    }

    const parsed = parseLeadingCommand(text);
    const assistantMode = String(
      metadata?.assistantMode
      || getAssistantControlMode(conversation)
      || ''
    ).trim().toLowerCase() === 'assistant';
    const taskSpace = conversation?.id
      ? this.taskViewService?.getConversationTaskSpace?.(conversation.id) || null
      : null;
    const phase2Route = resolvePhase2TaskRouting(taskSpace, {
      conversation,
      runtimeSessionManager: this.runtimeSessionManager
    });
    const commandFallbackTask = parsed?.command && conversation?.id
      ? (() => {
          const tracked = getTrackedSupervisorTasks(conversation, this.supervisorTaskStore);
          if (tracked.length === 1) {
            return tracked[0];
          }
          return tracked.find((entry) => ['waiting_approval', 'waiting_user', 'running', 'ready'].includes(String(entry?.status || '').trim())) || null;
        })()
      : null;
    const taskRoute = selectTaskRoute(conversation, {
      text,
      parsed,
      activeSession: conversation?.activeRuntimeSessionId
        ? this.getRuntimeSession(conversation.activeRuntimeSessionId)
        : null
    }, this.supervisorTaskStore);
    const routedTaskId = String(
      phase2Route.preferredTaskId
      || commandFallbackTask?.taskId
      || taskRoute?.task?.taskId
      || ''
    ).trim() || null;
    const taskSessionId = String(
      phase2Route.preferredRuntimeSessionId
      || commandFallbackTask?.sessionId
      || taskRoute?.task?.sessionId
      || getCurrentTaskSessionId(conversation)
      || ''
    ).trim() || null;
    const activeSessionId = taskSessionId || conversation?.activeRuntimeSessionId || null;
    const pendingApprovalId = conversation?.lastPendingApprovalId || null;
    const pendingApprovalSessionIdHint = conversation?.lastPendingApprovalSessionId || null;
    const pendingQuestionId = conversation?.lastPendingQuestionId || null;
    const pendingQuestionSessionIdHint = conversation?.lastPendingQuestionSessionId || null;
    const activeSession = activeSessionId ? this.getRuntimeSession(activeSessionId) : null;
    const routedTaskSessionId = String(taskRoute?.task?.sessionId || '').trim() || null;
    const resolvedSessionId = String(
      phase2Route.preferredRuntimeSessionId
      || routedTaskSessionId
      || activeSessionId
      || ''
    ).trim() || null;
    const resolvedSession = resolvedSessionId ? this.getRuntimeSession(resolvedSessionId) : null;
    const pendingApprovalSessionId = resolvePendingApprovalSessionId(this, {
      pendingApprovalId,
      pendingApprovalSessionId: pendingApprovalSessionIdHint,
      resolvedSessionId,
      activeSessionId,
      taskSessionId,
      taskRoute,
      conversation
    });
    const pendingQuestionSessionId = resolvePendingQuestionSessionId(this, {
      pendingQuestionId,
      pendingQuestionSessionId: pendingQuestionSessionIdHint,
      resolvedSessionId,
      activeSessionId,
      taskSessionId,
      taskRoute,
      conversation
    });
    const supervisorBrief = getSupervisorBrief(conversation, activeSession);
    const phase2Action = decidePhase2NaturalLanguageAction({
      text,
      parsed,
      phase2Route,
      taskRoute,
      resolvedSessionId,
      supervisorBrief
    });
    const preferredProvider = selectRuntimeProvider({
      conversation,
      activeSession: resolvedSession || activeSession,
      rememberedBrief: supervisorBrief,
      defaultRuntimeProvider: getPreferredConversationProvider(conversation, resolvedSession || activeSession, defaultRuntimeProvider),
      preferenceStore: this.preferenceStore
      ,
      memoryService: this.memoryService,
      cwd,
      metadata
    });

    if (!parsed?.command && !activeSessionId && conversation?.id && isPreferenceMemoryIntent(text)) {
      const savedPreferences = this.memoryService.savePreferencesFromText({
        conversation,
        runtimeSession: activeSession,
        text,
        cwd,
        metadata
      }, {
        store: this.preferenceStore
      });
      const savedMessage = this.memoryService.buildSavedMessage(savedPreferences)
        || buildPreferenceSavedMessage(savedPreferences);
      if (savedMessage) {
        return {
          type: 'preference_saved',
          message: savedMessage
        };
      }
    }

    if (!assistantMode && pendingApprovalSessionId && pendingApprovalId && !parsed?.command) {
      const approval = this.runtimeSessionManager.approvalService.getApproval(pendingApprovalSessionId, pendingApprovalId);
      if (approval && approval.status === 'pending') {
        if (isApprovalAffirmative(text) || isApprovalNegative(text)) {
          const remember = isApprovalAffirmative(text) && wantsRememberedApproval(text)
            ? (wantsExecutionRememberedApproval(text)
                ? 'session'
                : (wantsConversationRememberedApproval(text) ? 'conversation' : 'conversation'))
            : 'none';

          const resolved = await this.resolveApproval({
            sessionId: pendingApprovalSessionId,
            approvalId: pendingApprovalId,
            decision: isApprovalAffirmative(text) ? 'approve' : 'deny',
            remember,
            conversation
          });
          this.syncConversationAssistantWorkingSet({
            conversation,
            taskId: routedTaskId || '',
            sessionId: pendingApprovalSessionId
          });

          return {
            type: 'approval_resolved',
            approval: resolved,
            policy: resolved?.policy || null,
            message: resolved?.policy
              ? (resolved.policy.scope === 'task'
                ? 'Approved. I will remember this permission for this conversation.'
                : resolved.policy.scope === 'project'
                  ? 'Approved. I will remember this permission for this project.'
                  : resolved.policy.scope === 'person'
                    ? 'Approved. I will remember this permission for you.'
                    : 'Approved. I will remember this permission for the current execution.')
              : (resolved.status === 'approved' ? 'Approved.' : 'Denied.')
          };
        }
      }
    }

    const aliased = parseProviderAlias(parsed?.command, parsed?.args);
    if (aliased) {
      if (!aliased.input) {
        return {
          type: 'command_error',
          message: aliased.provider === 'codex'
            ? 'Usage: /cx <task>'
            : 'Usage: /cc <task>'
        };
      }

      const session = await this.startRuntimeTask({
        provider: aliased.provider,
        input: aliased.input,
        cwd,
        model,
        metadata
      });
      this.syncConversationAssistantWorkingSet({
        conversation,
        taskId: String(session?.metadata?.taskId || metadata?.taskId || '').trim(),
        sessionId: session?.id || ''
      });

      return {
        type: 'runtime_started',
        provider: aliased.provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId
      };
    }

    if (parsed?.command === 'agent') {
      const spec = parseAgentCommand(parsed.args);
      if (!spec) {
        return {
          type: 'command_error',
          message: 'Usage: /agent codex <task>, /agent claude <task>, /cx <task>, or /cc <task>'
        };
      }

      const session = await this.startRuntimeTask({
        provider: spec.provider,
        input: spec.input,
        cwd,
        model,
        metadata
      });
      this.syncConversationAssistantWorkingSet({
        conversation,
        taskId: String(session?.metadata?.taskId || metadata?.taskId || '').trim(),
        sessionId: session?.id || ''
      });

      return {
        type: 'runtime_started',
        provider: spec.provider,
        session
      };
    }

    if (parsed?.command === 'new') {
      if (!parsed.args) {
        return buildResetResponse(
          activeSessionId
            ? 'Detached the active runtime session. Your next message will start a fresh task.'
            : 'No active runtime session is attached. Your next message will start a fresh task.',
          activeSessionId
        );
      }

      const spec = parseRuntimeTarget(parsed.args);
      const provider = spec?.provider || defaultRuntimeProvider;
      const input = spec?.input || parsed.args;
      const session = await this.startRuntimeTask({
        provider,
        input,
        cwd,
        model,
        metadata
      });
      this.syncConversationAssistantWorkingSet({
        conversation,
        taskId: String(session?.metadata?.taskId || metadata?.taskId || '').trim(),
        sessionId: session?.id || ''
      });

      return {
        type: 'runtime_started',
        provider,
        session,
        startedFresh: true,
        replacedSessionId: activeSessionId
      };
    }

    if (parsed?.command === 'detach') {
      return buildResetResponse(
        resolvedSessionId
          ? 'Detached the active runtime session from this conversation.'
          : 'No active runtime session is attached to this conversation.',
        resolvedSessionId
      );
    }

    if (parsed?.command === 'continue') {
      if (!resolvedSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to continue'
        };
      }
      if (isSessionBusy(resolvedSession)) {
        return buildBusyResponse(resolvedSession, conversation);
      }
      const session = await this.continueRuntimeTask({
        taskId: routedTaskId || '',
        sessionId: resolvedSessionId,
        input: parsed.args || text
      });
      this.syncConversationAssistantWorkingSet({
        conversation,
        taskId: routedTaskId || '',
        sessionId: session?.id || resolvedSessionId
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    if (parsed?.command === 'cancel') {
      if (!resolvedSessionId) {
        return {
          type: 'command_error',
          message: 'No active runtime session to cancel'
        };
      }
      return {
        type: 'runtime_cancelled',
        session: this.cancelRuntimeSession({
          sessionId: resolvedSessionId,
          conversation,
          taskId: routedTaskId || ''
        })
      };
    }

    if (parsed?.command === 'status') {
      if (!resolvedSessionId || !resolvedSession) {
        return buildSupervisorStatusResponse(conversation, null);
      }
      return {
        type: 'runtime_status',
        session: resolvedSession
      };
    }

    if (parsed?.command === 'approve' || parsed?.command === 'deny') {
      if (!pendingApprovalSessionId || !pendingApprovalId) {
        return {
          type: 'command_error',
          message: 'No pending approval request'
        };
      }
      const approval = await this.resolveApproval({
        sessionId: pendingApprovalSessionId,
        approvalId: pendingApprovalId,
        decision: parsed.command === 'approve' ? 'approve' : 'deny'
      });
      this.syncConversationAssistantWorkingSet({
        conversation,
        taskId: routedTaskId || '',
        sessionId: pendingApprovalSessionId
      });
      return {
        type: 'approval_resolved',
        approval,
        message: parsed.command === 'approve' ? 'Approved.' : 'Denied.'
      };
    }

    if (!assistantMode && pendingQuestionSessionId && pendingQuestionId) {
      const question = await this.answerQuestion({
        sessionId: pendingQuestionSessionId,
        questionId: pendingQuestionId,
        answer: text
      });
      this.syncConversationAssistantWorkingSet({
        conversation,
        taskId: routedTaskId || '',
        sessionId: pendingQuestionSessionId
      });
      return {
        type: 'question_answered',
        question
      };
    }

    if (phase2Action.action === 'status_overview') {
      return buildConversationTaskStatusResponse(
        conversation,
        phase2Route.activeTasks.length > 0 ? phase2Route.activeTasks : taskRoute.activeTasks,
        resolvedSession || activeSession || null
      );
    }

    if (phase2Action.action === 'clarify_task') {
      return buildTaskClarificationResponse(
        phase2Route.activeTasks.length > 0 ? phase2Route.activeTasks : taskRoute.activeTasks
      );
    }

    if (phase2Action.action === 'status_single') {
      return buildSupervisorStatusResponse(conversation, resolvedSession || activeSession || null);
    }

    if (phase2Action.action === 'continue_existing' && routedTaskId && resolvedSessionId) {
      if (isSessionBusy(resolvedSession)) {
        return buildBusyResponse(resolvedSession, conversation);
      }
      const session = await this.continueRuntimeTask({
        taskId: routedTaskId,
        sessionId: resolvedSessionId,
        input: text
      });
      this.syncConversationAssistantWorkingSet({
        conversation,
        taskId: routedTaskId || '',
        sessionId: session?.id || resolvedSessionId
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    if (resolvedSessionId) {
      if (isSessionBusy(resolvedSession)) {
        return buildBusyResponse(resolvedSession, conversation);
      }
      const session = await this.continueRuntimeTask({
        taskId: routedTaskId || '',
        sessionId: resolvedSessionId,
        input: text
      });
      this.syncConversationAssistantWorkingSet({
        conversation,
        taskId: routedTaskId || '',
        sessionId: session?.id || resolvedSessionId
      });
      return {
        type: 'runtime_continued',
        session
      };
    }

    const rememberedIntent = phase2Action.action === 'start_fresh'
      ? phase2Action.rememberedIntent || null
      : (!resolvedSessionId ? classifyRememberedTaskIntent(text, supervisorBrief) : null);
    const startMetadata = rememberedIntent
      ? {
          ...metadata,
          taskId: rememberedIntent.reuseTaskIdentity ? (supervisorBrief?.taskId || metadata?.taskId || '') : (metadata?.taskId || ''),
          sourceTaskId: supervisorBrief?.taskId || metadata?.sourceTaskId || '',
          originKind: rememberedIntent.originKind
        }
      : metadata;

    const session = await this.startRuntimeTask({
      provider: preferredProvider,
      input: text,
      cwd,
      model,
      metadata: startMetadata
    });
    this.syncConversationAssistantWorkingSet({
      conversation,
      taskId: String(session?.metadata?.taskId || startMetadata?.taskId || '').trim(),
      sessionId: session?.id || ''
    });

    if (shouldStartFreshFromRememberedContext(supervisorBrief) || rememberedIntent) {
      return {
        type: 'runtime_started',
        provider: preferredProvider,
        session,
        startedFresh: true,
        message: buildRememberedContextMessage(supervisorBrief, rememberedIntent),
        supervisorContext: buildRememberedSupervisorContext(supervisorBrief, rememberedIntent)
      };
    }

    return {
      type: 'runtime_started',
      provider: preferredProvider,
      session
    };
  }
}

export const agentOrchestratorMessageService = new AgentOrchestratorMessageService();

export default agentOrchestratorMessageService;
