function truncate(value, limit = 400) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatJson(value) {
  return JSON.stringify(value || {}, null, 2);
}

function summarizePendingApprovals(conversationContext = null) {
  const activeRuntime = conversationContext?.activeRuntime || null;
  const pendingApprovals = Array.isArray(conversationContext?.pendingApprovals)
    ? conversationContext.pendingApprovals
    : [];
  return {
    activeRuntimeSessionId: String(activeRuntime?.id || '').trim(),
    activeRuntimeProvider: String(activeRuntime?.provider || '').trim(),
    count: pendingApprovals.length,
    items: pendingApprovals.slice(0, 5).map((entry) => ({
      approvalId: String(entry?.approvalId || '').trim(),
      title: String(entry?.title || '').trim(),
      summary: String(entry?.summary || '').trim(),
      createdAt: String(entry?.createdAt || '').trim()
    }))
  };
}

function summarizePendingQuestions(conversationContext = null) {
  const activeRuntime = conversationContext?.activeRuntime || null;
  const pendingQuestions = Array.isArray(conversationContext?.pendingQuestions)
    ? conversationContext.pendingQuestions
    : [];
  return {
    activeRuntimeSessionId: String(activeRuntime?.id || '').trim(),
    activeRuntimeProvider: String(activeRuntime?.provider || '').trim(),
    count: pendingQuestions.length,
    items: pendingQuestions.slice(0, 5).map((entry) => ({
      questionId: String(entry?.questionId || '').trim(),
      text: String(entry?.text || '').trim(),
      options: Array.isArray(entry?.options) ? entry.options : [],
      createdAt: String(entry?.createdAt || '').trim()
    }))
  };
}

function summarizePendingClarification(conversationContext = null) {
  const clarification = conversationContext?.pendingClarification || null;
  if (!clarification || typeof clarification !== 'object') {
    return null;
  }
  return {
    clarificationId: String(clarification?.id || '').trim(),
    question: String(clarification?.question || '').trim(),
    askedAt: String(clarification?.askedAt || '').trim(),
    ttlSec: Number(clarification?.ttlSec || 0),
    candidates: Array.isArray(clarification?.candidates)
      ? clarification.candidates.slice(0, 8).map((entry) => ({
          kind: String(entry?.kind || '').trim(),
          id: String(entry?.id || '').trim(),
          label: String(entry?.label || '').trim(),
          ...(Number.isFinite(Number(entry?.confidence)) ? { confidence: Number(entry.confidence) } : {})
        }))
      : []
  };
}

function computeStaleSinceHours(updatedAt) {
  const ts = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(ts)) return null;
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 0;
  return Math.round((diffMs / (60 * 60 * 1000)) * 10) / 10;
}

function summarizeTaskRecord(task = null) {
  if (!task?.taskId && !task?.id) return null;
  // 这两个字段告诉 LLM "这个 task 上一轮 codex 实际在干什么"，
  // 用于路由决策时判断"用户当前消息是不是这个 task 的自然延续"
  const lastTurnInput = task?.latestTurn?.input || '';
  const lastTurnSummary = task?.latestTurn?.summary
    || task?.summary
    || task?.runtimeSession?.summary
    || '';
  const updatedAt = task.updatedAt || task?.latestTurn?.updatedAt || '';
  return {
    taskId: task.taskId || task.id || '',
    conversationId: task.conversationId || task?.conversation?.id || '',
    title: task?.task?.title || task.title || '',
    state: task.state || task?.task?.status || '',
    waitingReason: task.waitingReason || '',
    summary: task.summary || '',
    resultPreview: truncate(task.resultPreview || '', 200),
    provider: task?.runtimeSession?.provider || task?.task?.provider || '',
    runtimeSessionId: task?.runtimeSession?.id || task?.task?.runtimeSessionId || '',
    primaryExecutionId: task?.task?.primaryExecutionId || task?.task?.runtimeSessionId || '',
    latestExecutionId: task?.task?.latestExecutionId || task?.runtimeSession?.id || task?.task?.runtimeSessionId || '',
    originKind: task?.task?.originKind || '',
    sourceTaskId: task?.task?.sourceTaskId || '',
    cwd: task?.task?.cwd || '',
    cwdBasename: task?.task?.cwdBasename || '',
    lastConversationId: task?.task?.lastConversationId || task.conversationId || task?.conversation?.id || '',
    lastTurnInput: truncate(lastTurnInput, 80),
    lastTurnSummary: truncate(lastTurnSummary, 200),
    staleSinceHours: computeStaleSinceHours(updatedAt),
    pending: task?.pending || { approvalCount: 0, questionCount: 0 },
    updatedAt
  };
}

function summarizeKnownCwd(entry = null) {
  const workspaceRef = String(entry?.workspaceRef || '').trim();
  if (!workspaceRef) return null;
  return {
    workspaceId: String(entry?.id || '').trim(),
    workspaceRef,
    name: String(entry?.name || '').trim(),
    defaultRuntimeProvider: String(entry?.defaultRuntimeProvider || '').trim(),
    aliases: Array.isArray(entry?.aliases) ? entry.aliases.slice(0, 8) : [],
    summary: String(entry?.summary || '').trim(),
    taskIds: Array.isArray(entry?.taskIds) ? entry.taskIds.slice(0, 8) : [],
    openTaskIds: Array.isArray(entry?.openTaskIds) ? entry.openTaskIds.slice(0, 8) : [],
    lastTouchedAt: String(entry?.lastTouchedAt || '').trim()
  };
}

function summarizeReferenceResolution(referenceResolution = null) {
  return {
    intent: String(referenceResolution?.intent || '').trim(),
    summary: {
      referenceCount: Number(referenceResolution?.summary?.referenceCount || 0),
      primaryPhrase: String(referenceResolution?.summary?.primaryPhrase || '').trim(),
      confidence: String(referenceResolution?.summary?.confidence || '').trim(),
      recommendedAction: String(referenceResolution?.summary?.recommendedAction || '').trim(),
      preferredTaskId: String(referenceResolution?.summary?.preferredTaskId || '').trim(),
      preferredWorkspaceRef: String(referenceResolution?.summary?.preferredWorkspaceRef || '').trim(),
      shouldAskUser: referenceResolution?.summary?.shouldAskUser === true
    },
    references: Array.isArray(referenceResolution?.references)
      ? referenceResolution.references.slice(0, 4).map((entry) => ({
          phrase: String(entry?.phrase || '').trim(),
          ambiguous: entry?.ambiguous === true,
          confidence: String(entry?.confidence || '').trim(),
          recommendedAction: String(entry?.recommendedAction || '').trim(),
          preferredTaskId: String(entry?.preferredTaskId || '').trim(),
          preferredWorkspaceRef: String(entry?.preferredWorkspaceRef || '').trim(),
          shouldAskUser: entry?.shouldAskUser === true,
          topCandidates: Array.isArray(entry?.topCandidates)
            ? entry.topCandidates.slice(0, 5).map((candidate) => ({
                kind: String(candidate?.kind || '').trim(),
                id: String(candidate?.id || '').trim(),
                label: String(candidate?.label || '').trim(),
                score: Number(candidate?.score || 0),
                ...(candidate?.conversationId ? { conversationId: String(candidate.conversationId).trim() } : {}),
                ...(typeof candidate?.isCurrentConversation === 'boolean'
                  ? { isCurrentConversation: candidate.isCurrentConversation }
                  : {})
              }))
            : []
        }))
      : []
  };
}

function summarizeRecentIntentTimeline(timeline = []) {
  return Array.isArray(timeline)
    ? timeline.slice(0, 8).map((entry) => ({
        ts: String(entry?.ts || '').trim(),
        userText: truncate(entry?.userText || '', 160),
        action: String(entry?.action || '').trim(),
        resolvedTargetTaskId: String(entry?.resolvedTargetTaskId || '').trim(),
        resolvedTargetCwd: String(entry?.resolvedTargetCwd || '').trim(),
        referenceConfidence: String(entry?.referenceConfidence || '').trim(),
        resolutionAction: String(entry?.resolutionAction || '').trim(),
        shouldAskUser: entry?.shouldAskUser === true
      }))
    : [];
}

function summarizeUserProfile(memory = null) {
  const profile = memory?.userProfile || null;
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  return {
    replyLanguage: String(profile?.replyLanguage || '').trim(),
    responseStyle: String(profile?.responseStyle || '').trim(),
    preferredRuntimeProvider: String(profile?.preferredRuntimeProvider || '').trim(),
    executionStyle: String(profile?.executionStyle || '').trim()
  };
}

function isStatusLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /^(status|progress|update)\b/i,
    /\b(what('| i)?s the status|how('| i)?s it going|progress update|current status)\b/i,
    /(进展如何|现在进度|现在怎么样|情况如何|状态如何|当前状态|现在什么情况|进展怎么样|目前怎么样)/
  ].some((pattern) => pattern.test(source));
}

function isContinueLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /^(continue|resume|follow up|keep going)\b/i,
    /(继续刚才那个|继续这个|接着做|接着改|继续处理|继续推进|把刚才那个继续|继续一下)/
  ].some((pattern) => pattern.test(source));
}

function isRetryLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /^(重试|再试一次|重新试|retry|try again)/i,
    /(重试刚才那个|重试这个|retry this|retry that)/i
  ].some((pattern) => pattern.test(source));
}

function isRelatedTaskLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /(另外再做一个|基于刚才那个再做一个|相关任务|再做一个|再来一个)/,
    /\b(another one|related task|sibling task|based on that create another)\b/i
  ].some((pattern) => pattern.test(source));
}

function isReturnToSourceLikeRequest(text = '') {
  const source = String(text || '').trim();
  if (!source) return false;
  return [
    /(回到上一个任务|回到原任务|回到刚才那个任务|回到原来的任务)/,
    /\b(return to (the )?(previous|source|original) task)\b/i
  ].some((pattern) => pattern.test(source));
}

function buildRoutingHints({ text = '', taskSpace = null, referenceResolution = null } = {}) {
  const decisionHints = taskSpace?.decisionHints || {};
  const referenceSummary = referenceResolution?.summary || {};
  let requestType = 'freeform_request';

  if (isStatusLikeRequest(text)) {
    requestType = 'status_query';
  } else if (isRetryLikeRequest(text)) {
    requestType = 'retry_task';
  } else if (isReturnToSourceLikeRequest(text)) {
    requestType = 'return_to_source';
  } else if (isRelatedTaskLikeRequest(text)) {
    requestType = 'related_sibling';
  } else if (isContinueLikeRequest(text)) {
    requestType = 'continue_task';
  }

  return {
    requestType,
    shouldClarify: Boolean(decisionHints.shouldClarify),
    preferredAction: String(decisionHints.preferredAction || ''),
    preferredTaskId: String(decisionHints.preferredTaskId || ''),
    preferredExecutionTarget: String(decisionHints.focusTaskExecutionTarget || ''),
    preferredReferenceAction: String(referenceSummary.recommendedAction || ''),
    preferredReferenceTaskId: String(referenceSummary.preferredTaskId || ''),
    preferredReferenceWorkspaceRef: String(referenceSummary.preferredWorkspaceRef || ''),
    referenceConfidence: String(referenceSummary.confidence || ''),
    shouldClarifyFromReference: referenceSummary.shouldAskUser === true,
    reason: String(decisionHints.reason || ''),
    shouldPreferStatusOverview: Boolean(decisionHints.shouldPreferStatusOverview),
    shouldPreferWaitingTask: Boolean(decisionHints.shouldPreferWaitingTask),
    shouldReuseFocusTask: Boolean(decisionHints.shouldReuseFocusTask)
  };
}

function buildSystemPrompt(language = 'en') {
  if (language === 'zh-CN') {
    return [
      '你是 CliGate Assistant。',
      '你是一个 LLM 驱动的 supervisor agent，负责理解用户目标、查看上下文、按需调用工具、按需委派 Codex 或 Claude Code 执行任务，并最终以自然语言回复用户。',
      '优先像一个人一样与用户协作，不要把内部工具调用过程直接当作最终回复。',
      '如果不需要工具和 runtime，就直接回答。',
      '如果需要查看状态或上下文，再调用只读工具。',
      '当前对话上下文以 task space 为中心，不要默认把 active runtime 当作唯一主线。',
      '特别注意 task 的 originKind、sourceTaskId、primaryExecutionId、latestExecutionId，这些字段用于理解当前 task 是重试、回到源任务、相关 sibling task，还是普通延续。',
      '先看 focus task、waiting tasks、active tasks，再决定是直接回答、观察、继续某个 task、发起新委派，还是先澄清。',
      '如果 task_space 里有 decisionHints，优先遵循 preferredAction、preferredTaskId、reason，再结合 focusTaskReason 和 taskRelationshipSummary 判断。',
      '如果上下文里有 routingHints，优先把它当作当前用户请求的意图线索；尤其注意 requestType、shouldClarify、preferredTaskId、preferredExecutionTarget。',
      '如果 reference_resolution.summary 给出了 high/medium confidence 的 preferred task 或 workspace，优先把它作为引用理解的主要线索；如果 shouldAskUser 为 true，就不要猜。',
      'assistant mode 下没有任何 pre-LLM 的 pending 硬路由。即使存在 runtime approval 或 runtime question，也必须由你结合用户这条消息显式判断。',
      '如果上下文出现 pending_runtime_approval，并且用户是在批准或拒绝该请求，调用 resolve_runtime_approval；不要假设系统会自动批准。如果用户消息含"允许后续 / 本会话同意 / 以后都 / from now on / 一律允许"等"sticky approval"语义，approve 的同时把 remember 参数设为 "session"（默认 scope）；如果用户明说"这次对话/这个聊天/this conversation 都同意"，则 remember="conversation" 并附带 conversationId。这样系统会创建 wildcard 策略，后续同类请求自动通过，不再打扰用户。',
      '如果上下文出现 pending_runtime_question，并且用户是在回答该问题，调用 answer_runtime_question；不要假设系统会自动转发。',
      '如果上下文出现 pending_clarification，并且用户是在回答这个澄清问题，调用 resolve_clarification；如果澄清已无意义，则调用 cancel_pending_clarification。',
      '如果存在 pending runtime interaction，但用户显然是在切换任务、查询状态、或发起新需求，就按 task space 和 routing hints 决策，不要被 pending 状态绑死。',
      '如果已有明确的 focus task 或单个 waiting task，优先继续该 task；继续任务时优先使用 continue_task，而不是直接假定 latest runtime。',
      '如果存在多个活跃 task 且用户指向不清，不要猜测，应先澄清用户要继续哪个 task。',
      '只有在确实不存在可复用 task，或者用户明确要求新开执行时，才委派新的 runtime。',
      '如果 task-space 信息不足，优先用 get_conversation_task_space 或其他只读工具补上下文。',
      '决策示例：用户问“现在进展怎样/有哪些任务”时，先看 task space，必要时用只读工具，不要新开 runtime。',
      '决策示例：用户说“继续这个任务/回答刚才那个问题/批准刚才那个操作”时，优先继续已有 task，不要新开 runtime。',
      '决策示例：用户说“新开一个任务/重新做/另外跑一个”时，才发起新的 delegate。',
      '决策示例：如果当前有多个 active tasks，而用户只说“继续一下/看看进展”，先澄清目标 task。',
      '如需搜索现有任务或对话摘要，优先使用 search_task_and_conversation_memory；search_project_memory 只是兼容别名。',
      '如果需要真正执行任务，再委派 runtime。',
      '如果 runtime 已给出结果，要先理解并总结，再回复用户。',
      '尽量简洁、准确、直接，不编造不存在的状态或结果。',
      '反幻觉硬性约束：你只能描述自己在本轮已经实际产生过 tool_use 的工具。如果在本轮 transcript 里没有针对 delegate_to_codex / continue_task / send_runtime_input 等 runtime 工具的 tool_use，就严禁声称"已经用 Codex 查过/已经让 Claude Code 跑了/Codex 返回了…"等。需要时直接调工具，或如实说"我还没调用工具"。',
      '路由相关性纪律：在 continue_task 之前，对照 <recent_tasks> 中该 task 的 lastTurnInput 与 lastTurnSummary 判断用户当前消息是否是它的自然延续。如果话题明显不同（比如用户问天气而该 task 上一轮在分析代码），优先 delegate_to_codex 起一个新 session，而不是 continue 一个已被其他话题污染的旧 session。',
      '默认 provider 偏好：发起新 delegate 时，**默认使用 <default_runtime_provider> 指定的 provider**（通常是 codex）。仅在以下情况才用别的 provider：(a) 用户消息明确按名指定，例如"用 claude code / cc / claude-code"；(b) <user_profile>.preferredRuntimeProvider 显式设置了别的偏好；(c) 默认 provider 已被证明不可用（连续失败 / 缺少凭证）。**不要凭"另一个 provider 也许更好"擅自切换**——这会让用户对实际在用什么工具产生困惑。',
      '不要输出内部 chain-of-thought，只输出结论、必要说明和下一步。'
    ].join(' ');
  }

  return [
    'You are CliGate Assistant.',
    'You are an LLM-driven supervisor agent that understands user goals, inspects context, calls tools when useful, delegates execution to Codex or Claude Code when necessary, and replies in natural language.',
    'Speak like a collaborative assistant, not like an internal task router.',
    'Answer directly when no tools or runtime work are needed.',
    'Use read-only tools when you need context.',
    'Treat the current conversation as a task space, not as a single active runtime thread.',
    'Pay close attention to task fields such as originKind, sourceTaskId, primaryExecutionId, and latestExecutionId. They tell you whether a task is a retry, a return-to-source task, a related sibling task, or a normal continuation.',
    'Check focusTask, waitingTasks, and activeTasks before deciding whether to answer, observe, continue an existing task, start a new delegation, or ask for clarification.',
    'When task_space includes decisionHints, prefer following preferredAction, preferredTaskId, and reason, then confirm against focusTaskReason and taskRelationshipSummary.',
    'When the context includes routingHints, treat them as strong clues about the user request intent, especially requestType, shouldClarify, preferredTaskId, and preferredExecutionTarget.',
    'When reference_resolution.summary offers a high- or medium-confidence preferred task or workspace, treat it as the main clue for resolving user references. If shouldAskUser is true, do not guess.',
    'In assistant mode there is no pre-LLM hard routing for pending runtime interactions. Even if a runtime approval or question is pending, you must inspect the user message and decide explicitly.',
    'If the context includes pending_runtime_approval and the user is approving or denying that request, call resolve_runtime_approval. Do not assume the system will auto-route it. When the user grants a sticky approval ("allow subsequent / from now on / 后续 / 本会话 / 一律 / always"), set remember="session" alongside decision="approve" so the system records a wildcard policy and stops asking for the same kind of permission. When the user explicitly scopes it to the current conversation ("this conversation / 这次对话都同意"), use remember="conversation" plus the conversationId. Default remember="none" for one-shot approvals.',
    'If the context includes pending_runtime_question and the user is answering that question, call answer_runtime_question. Do not assume the system will auto-forward it.',
    'If the context includes pending_clarification and the user is answering that clarification, call resolve_clarification. If that clarification is no longer relevant, call cancel_pending_clarification.',
    'If a runtime approval or question is pending but the user is clearly switching tasks, asking for status, or starting new work, follow task-space and routing hints instead of being trapped by the pending state.',
    'When there is a clear focus task or a single waiting task, prefer continuing that task. Use continue_task for task follow-up instead of assuming the latest runtime session.',
    'If multiple active tasks exist and the user intent is ambiguous, do not guess. Ask for clarification first.',
    'Only delegate a brand-new runtime task when no existing task should be reused, or when the user clearly asks to start fresh.',
    'If task-space context is insufficient, prefer get_conversation_task_space or other read-only tools before acting.',
    'Decision example: for "what is the status" or "what tasks are active", inspect task space or other read-only context first. Do not start a new runtime.',
    'Decision example: for "continue this", "answer the earlier question", or "approve the last action", prefer continuing the existing task instead of starting fresh.',
    'Decision example: for "start a new task", "redo this separately", or "run another one", delegate a new runtime task.',
    'Decision example: if multiple active tasks exist and the user only says "continue" or "check progress", ask for clarification first.',
    'When searching existing task or conversation summaries, prefer search_task_and_conversation_memory; search_project_memory is only a deprecated compatibility alias.',
    'Delegate to runtime only when actual execution is needed.',
    'When runtime returns a result, summarize it for the user before replying.',
    'Be concise, accurate, and do not invent facts or state.',
    'Anti-hallucination hard rule: you may only describe tools you have actually produced a `tool_use` block for in this turn. If your transcript does not contain a `tool_use` for delegate_to_codex / continue_task / send_runtime_input, you have NOT used Codex or Claude Code in this turn — do not say you have, do not invent results. If a runtime tool is needed, call it now, or honestly state that you have not yet called it.',
    'Routing relevance discipline: before calling continue_task, compare the user message against the target task\'s lastTurnInput and lastTurnSummary in <recent_tasks>. If the user is clearly on a different topic from that task\'s recent activity (e.g. asking about weather while the task was analyzing code), prefer delegate_to_codex with a fresh session over continuing a session whose working memory has drifted to a different topic.',
    'Default provider preference: when starting a fresh delegation, use the provider named by <default_runtime_provider> (usually codex). Only choose a different provider when (a) the user explicitly named one ("use claude code", "cc", "claude-code"), (b) <user_profile>.preferredRuntimeProvider is set, or (c) the default provider has demonstrably failed (repeated errors / missing credentials). Do not switch providers on a hunch — silently changing tools confuses the user about what is actually running.',
    'Do not reveal chain-of-thought.'
  ].join(' ');
}

function summarizeThisTurnActions(actions = []) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return {
      toolCallsSoFar: [],
      note: 'No tool_use produced in this turn yet. Do not claim any runtime tool has been invoked.'
    };
  }
  return {
    toolCallsSoFar: actions.map((entry) => ({
      toolName: String(entry?.toolName || ''),
      input: entry?.input ?? null,
      success: entry?.success !== false,
      summary: truncate(entry?.summary || '', 160)
    }))
  };
}

function buildContextBlock({
  conversation,
  text,
  taskRecord,
  taskSpace,
  conversationContext,
  workspaceContext,
  referenceResolution,
  recentIntentTimeline,
  thisTurnActions,
  defaultRuntimeProvider,
  cwd,
  model
} = {}) {
  return [
    '<assistant_context>',
    `<conversation_id>${conversation?.id || ''}</conversation_id>`,
    `<assistant_mode>${conversation?.metadata?.assistantCore?.mode || 'direct-runtime'}</assistant_mode>`,
    `<default_runtime_provider>${defaultRuntimeProvider || 'codex'}</default_runtime_provider>`,
    `<workspace>${truncate(cwd || conversation?.metadata?.workspaceId || '', 200)}</workspace>`,
    `<runtime_model>${truncate(model || '', 120)}</runtime_model>`,
    '<current_task_record>',
    formatJson(taskRecord || null),
    '</current_task_record>',
    '<task_space>',
    formatJson({
      summary: taskSpace?.summary || {
        taskCount: 0,
        activeCount: 0,
        waitingCount: 0,
        completedCount: 0,
        failedCount: 0
      },
      focusTaskReason: taskSpace?.focusTaskReason || '',
      taskRelationshipSummary: taskSpace?.taskRelationshipSummary || '',
      decisionHints: taskSpace?.decisionHints || {},
      focusTask: summarizeTaskRecord(taskSpace?.focusTask),
      activeTasks: Array.isArray(taskSpace?.activeTasks)
        ? taskSpace.activeTasks.slice(0, 5).map(summarizeTaskRecord).filter(Boolean)
        : [],
      waitingTasks: Array.isArray(taskSpace?.waitingTasks)
        ? taskSpace.waitingTasks.slice(0, 5).map(summarizeTaskRecord).filter(Boolean)
        : [],
      recentCompletedTasks: Array.isArray(taskSpace?.recentCompletedTasks)
        ? taskSpace.recentCompletedTasks.slice(0, 5).map(summarizeTaskRecord).filter(Boolean)
        : [],
      recentFailedTasks: Array.isArray(taskSpace?.recentFailedTasks)
        ? taskSpace.recentFailedTasks.slice(0, 5).map(summarizeTaskRecord).filter(Boolean)
        : []
    }),
    '</task_space>',
    '<recent_tasks>',
    formatJson(
      Array.isArray(taskSpace?.recentTasks)
        ? taskSpace.recentTasks.slice(0, 8).map(summarizeTaskRecord).filter(Boolean)
        : []
    ),
    '</recent_tasks>',
    '<known_cwds>',
    formatJson(
      Array.isArray(workspaceContext?.knownCwds)
        ? workspaceContext.knownCwds.slice(0, 8).map(summarizeKnownCwd).filter(Boolean)
        : []
    ),
    '</known_cwds>',
    '<reference_resolution>',
    formatJson(summarizeReferenceResolution(referenceResolution)),
    '</reference_resolution>',
    '<recent_intent_timeline>',
    formatJson(summarizeRecentIntentTimeline(recentIntentTimeline)),
    '</recent_intent_timeline>',
    '<routing_hints>',
    formatJson(buildRoutingHints({
      text,
      taskSpace,
      referenceResolution
    })),
    '</routing_hints>',
    '<pending_runtime_approval>',
    formatJson(summarizePendingApprovals(conversationContext)),
    '</pending_runtime_approval>',
    '<pending_runtime_question>',
    formatJson(summarizePendingQuestions(conversationContext)),
    '</pending_runtime_question>',
    '<pending_clarification>',
    formatJson(summarizePendingClarification(conversationContext)),
    '</pending_clarification>',
    '<conversation_summary>',
    formatJson({
      conversation: conversationContext?.conversation || null,
      activeRuntime: conversationContext?.activeRuntime || null,
      latestTask: conversationContext?.latestTask || null,
      pendingApprovals: Array.isArray(conversationContext?.pendingApprovals)
        ? conversationContext.pendingApprovals.slice(0, 5)
        : [],
      pendingQuestions: Array.isArray(conversationContext?.pendingQuestions)
        ? conversationContext.pendingQuestions.slice(0, 5)
        : [],
      pendingClarification: conversationContext?.pendingClarification || null,
      assistantState: conversationContext?.assistantState || null,
      memory: conversationContext?.memory || {},
      policy: conversationContext?.policy || {},
      recentDeliveries: Array.isArray(conversationContext?.deliveries)
        ? conversationContext.deliveries.slice(0, 6).map((entry) => ({
            direction: entry.direction,
            text: truncate(entry?.payload?.text || entry?.payload?.content || '', 200),
            createdAt: entry.createdAt
          }))
        : []
    }),
    '</conversation_summary>',
    '<user_profile>',
    formatJson(summarizeUserProfile(conversationContext?.memory || workspaceContext?.memory || null)),
    '</user_profile>',
    '<workspace_summary>',
    formatJson(workspaceContext?.summary || {}),
    '</workspace_summary>',
    '<this_turn_actions>',
    formatJson(summarizeThisTurnActions(thisTurnActions)),
    '</this_turn_actions>',
    '</assistant_context>'
  ].join('\n');
}

export function buildInitialAnthropicMessages({
  language = 'en',
  conversation,
  text,
  taskRecord,
  taskSpace,
  conversationContext,
  workspaceContext,
  referenceResolution,
  recentIntentTimeline,
  thisTurnActions,
  defaultRuntimeProvider = 'codex',
  cwd = '',
  model = ''
} = {}) {
  return {
    system: buildSystemPrompt(language),
    messages: [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            buildContextBlock({
      conversation,
      text,
      taskRecord,
      taskSpace,
      conversationContext,
      workspaceContext,
      referenceResolution,
      recentIntentTimeline,
      thisTurnActions,
              defaultRuntimeProvider,
              cwd,
              model
            }),
            '',
            '<user_request>',
            String(text || '').trim(),
            '</user_request>'
          ].join('\n')
        }
      ]
    }]
  };
}

export default {
  buildInitialAnthropicMessages
};
