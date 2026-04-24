function truncate(value, limit = 400) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function formatJson(value) {
  return JSON.stringify(value || {}, null, 2);
}

function summarizeTaskRecord(task = null) {
  if (!task?.taskId && !task?.id) return null;
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
    pending: task?.pending || { approvalCount: 0, questionCount: 0 },
    updatedAt: task.updatedAt || ''
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
      '先看 focus task、waiting tasks、active tasks，再决定是直接回答、观察、继续某个 task、发起新委派，还是先澄清。',
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
    'Check focusTask, waitingTasks, and activeTasks before deciding whether to answer, observe, continue an existing task, start a new delegation, or ask for clarification.',
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
    'Do not reveal chain-of-thought.'
  ].join(' ');
}

function buildContextBlock({
  conversation,
  taskRecord,
  taskSpace,
  conversationContext,
  workspaceContext,
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
    '<conversation_summary>',
    formatJson({
      conversation: conversationContext?.conversation || null,
      activeRuntime: conversationContext?.activeRuntime || null,
      latestTask: conversationContext?.latestTask || null,
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
    '<workspace_summary>',
    formatJson(workspaceContext?.summary || {}),
    '</workspace_summary>',
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
              taskRecord,
              taskSpace,
              conversationContext,
              workspaceContext,
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
