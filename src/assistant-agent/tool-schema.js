const TOOL_SCHEMAS = Object.freeze({
  get_workspace_context: {
    type: 'object',
    properties: {
      runtimeLimit: { type: 'integer', minimum: 1, maximum: 20 },
      conversationLimit: { type: 'integer', minimum: 1, maximum: 20 }
    }
  },
  list_runtime_sessions: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      status: { type: 'string' }
    }
  },
  get_runtime_session: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      eventLimit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['sessionId']
  },
  list_conversations: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      mode: { type: 'string' }
    }
  },
  get_conversation_context: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      deliveryLimit: { type: 'integer', minimum: 1, maximum: 50 }
    },
    required: ['conversationId']
  },
  get_conversation_task_space: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      activeLimit: { type: 'integer', minimum: 1, maximum: 20 },
      waitingLimit: { type: 'integer', minimum: 1, maximum: 20 },
      recentLimit: { type: 'integer', minimum: 1, maximum: 20 }
    },
    required: ['conversationId']
  },
  list_tasks: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' },
      state: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    }
  },
  get_task: {
    type: 'object',
    properties: {
      taskId: { type: 'string' }
    },
    required: ['taskId']
  },
  get_task_by_runtime_session: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      conversationId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['sessionId']
  },
  search_task_and_conversation_memory: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    },
    required: ['query']
  },
  recall: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: { type: 'string', enum: ['workspace', 'conversation'] },
      conversationId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    },
    required: ['query']
  },
  find_task_by_keyword: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      conversationId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    },
    required: ['query']
  },
  list_known_cwds: {
    type: 'object',
    properties: {
      recent: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    }
  },
  get_cwd_info: {
    type: 'object',
    properties: {
      cwd: { type: 'string' },
      workspaceId: { type: 'string' }
    }
  },
  add_cwd_alias: {
    type: 'object',
    properties: {
      cwd: { type: 'string' },
      workspaceId: { type: 'string' },
      alias: { type: 'string' }
    },
    required: ['alias']
  },
  link_task_to_conversation: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      runtimeSessionId: { type: 'string' }
    },
    required: ['taskId']
  },
  resolve_reference: {
    type: 'object',
    properties: {
      phrase: { type: 'string' },
      conversationId: { type: 'string' }
    },
    required: ['phrase']
  },
  search_project_memory: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 20 }
    },
    required: ['query']
  },
  delegate_to_codex: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    },
    required: ['task']
  },
  delegate_to_claude_code: {
    type: 'object',
    properties: {
      task: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    },
    required: ['task']
  },
  delegate_to_runtime: {
    type: 'object',
    properties: {
      provider: { type: 'string', enum: ['codex', 'claude-code'] },
      task: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    },
    required: ['provider', 'task']
  },
  delegate_task_execution: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      provider: { type: 'string', enum: ['codex', 'claude-code'] },
      role: { type: 'string', enum: ['primary', 'secondary'] },
      task: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    },
    required: ['taskId', 'provider', 'task']
  },
  reuse_or_delegate: {
    type: 'object',
    properties: {
      provider: { type: 'string', enum: ['codex', 'claude-code'] },
      sessionId: { type: 'string' },
      task: { type: 'string' },
      message: { type: 'string' },
      cwd: { type: 'string' },
      model: { type: 'string' }
    }
  },
  send_runtime_input: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      message: { type: 'string' }
    },
    required: ['sessionId', 'message']
  },
  continue_task: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      sessionId: { type: 'string' },
      message: { type: 'string' }
    },
    required: ['message']
  },
  cancel_runtime_session: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' }
    },
    required: ['sessionId']
  },
  reset_conversation_binding: {
    type: 'object',
    properties: {
      conversationId: { type: 'string' }
    },
    required: ['conversationId']
  },
  resolve_runtime_approval: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      approvalId: { type: 'string' },
      decision: { type: 'string', enum: ['approve', 'deny'] },
      remember: {
        type: 'string',
        enum: ['none', 'session', 'conversation'],
        description: 'When the user grants a sticky approval ("允许后续所有操作 / 本会话同意 / 这次对话都同意 / from now on"), set "session" or "conversation" so the same kind of request auto-passes later. Default "none" = one-shot approval.'
      },
      conversationId: {
        type: 'string',
        description: 'Required only when remember="conversation".'
      }
    },
    required: ['sessionId', 'approvalId', 'decision']
  },
  answer_runtime_question: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      questionId: { type: 'string' },
      answer: { type: 'string' }
    },
    required: ['sessionId', 'questionId', 'answer']
  },
  cancel_pending_question: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      questionId: { type: 'string' },
      reason: { type: 'string' }
    },
    required: ['sessionId', 'questionId']
  },
  ask_user: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['task', 'workspace', 'session', 'free'] },
            id: { type: 'string' },
            label: { type: 'string' },
            confidence: { type: 'number' }
          },
          required: ['kind', 'id', 'label']
        }
      },
      ttlSec: { type: 'integer', minimum: 1, maximum: 86400 }
    },
    required: ['question']
  },
  resolve_clarification: {
    type: 'object',
    properties: {
      clarificationId: { type: 'string' },
      candidateId: { type: 'string' },
      freeText: { type: 'string' }
    },
    required: ['clarificationId']
  },
  cancel_pending_clarification: {
    type: 'object',
    properties: {
      clarificationId: { type: 'string' },
      reason: { type: 'string' }
    },
    required: ['clarificationId']
  },
  summarize_runtime_result: {
    type: 'object',
    properties: {
      sessionId: { type: 'string' },
      eventLimit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['sessionId']
  },
  create_scheduled_task: {
    type: 'object',
    description: '创建一个新的定时提醒/任务。声明式参数，不做任何 UTC / 时区计算 / cron 表达式 —— LLM 只翻译用户意图为以下字段，工具内部完成时间换算。',
    properties: {
      title: { type: 'string', description: '简短标题，例如 "提醒吃晚饭"。' },
      message: { type: 'string', description: '到点要发给用户的提醒内容。可写在这里，或写在 payload.message。两者择一即可。' },
      recurrence: {
        type: 'string',
        enum: ['once', 'daily', 'weekly', 'monthly', 'yearly'],
        description: 'once=一次性, daily=每天, weekly=每周（需 dayOfWeek）, monthly=每月（需 dayOfMonth）, yearly=每年（需 month + dayOfMonth）'
      },
      timezone: { type: 'string', description: 'IANA 时区名，默认 "Asia/Shanghai"。' },
      localTime: { type: 'string', description: '24 小时制 HH:MM 钟面时间（在 timezone 下）。晚上 8 点 = "20:00"，晚上 8:10 = "20:10"。recurrence ≠ "once" 时必填；once 可以用 delayMinutes 代替。' },
      dayOfWeek: {
        description: '仅 recurrence=weekly 使用。可传 "mon"/"tue"/"wed"/"thu"/"fri"/"sat"/"sun"，也可传 0-6（Sunday=0），或字符串数组如 ["mon","wed","fri"]。',
        oneOf: [
          { type: 'string' },
          { type: 'integer', minimum: 0, maximum: 6 },
          { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'integer' }] } }
        ]
      },
      dayOfMonth: { type: 'integer', minimum: 1, maximum: 31, description: '仅 recurrence=monthly/yearly 使用。每月几号。29-31 在天数不够的月份会自动跳过。' },
      month: { type: 'integer', minimum: 1, maximum: 12, description: '仅 recurrence=yearly 使用。1=一月 ... 12=十二月。' },
      date: { type: 'string', description: '仅 recurrence=once 且需要指定具体某一天时使用，格式 "YYYY-MM-DD"（按 timezone 解读）。配合 localTime。例如 "明天早上 8 点" → date: "<明天日期>" + localTime: "08:00"。"今晚 8 点" 不要传 date，直接 localTime: "20:00" 即可，工具会自动选今天或明天。' },
      delayMinutes: { type: 'integer', minimum: 1, description: '仅 recurrence=once 使用。"N 分钟后" → delayMinutes: N。绝对禁止跟 daily/weekly/monthly/yearly 组合（旧 bug 源头）。' },
      delaySeconds: { type: 'integer', minimum: 1, description: '仅 recurrence=once 使用（一般只在调试/极短延迟时用）。同样禁止与循环 recurrence 组合。' },
      action: {
        type: 'string',
        enum: ['notify_user', 'invoke_assistant'],
        description: '到点做什么。notify_user=只推一段静态提醒文本（默认）；invoke_assistant=唤起助手，把 message 作为指令交给助手处理，结果再以摘要 ping 给 notifyTargets。'
      },
      notifyConversationIds: {
        type: 'array',
        items: { type: 'string' },
        description: '到点把通知推到哪些 conversation。空数组 = 静默后台执行（只记 run 历史）。不传时会自动绑定到当前会话（如果在会话里调用）。invoke_assistant 类型即使空也合法（任务在自己的 scope conversation 内运行，结果按此列表 ping）。'
      },
      sharedContext: {
        type: 'boolean',
        description: '仅 invoke_assistant 时有意义。默认 false：每次 run 都是 fresh 上下文（推荐，避免上下文越来越大）。true：所有 run 共享同一个 runtime 会话（适合"每日记账"类需要连续记忆的场景）。'
      },
      cwd: {
        type: 'string',
        description: '仅 invoke_assistant 时有意义。可选工作目录路径（让助手在这个项目里跑）。'
      },
      payload: {
        type: 'object',
        description: '可选。一般情况下用 top-level 的 message/action 即可，不需要单独传 payload。',
        properties: {
          action: { type: 'string', enum: ['notify_user', 'invoke_assistant', 'start', 'continue', 'status'] },
          message: { type: 'string' },
          provider: { type: 'string' },
          input: { type: 'string' },
          cwd: { type: 'string' },
          taskId: { type: 'string' },
          sessionId: { type: 'string' }
        }
      }
    },
    required: ['title', 'recurrence']
  },
  update_scheduled_task: {
    type: 'object',
    description: '修改已有的定时任务（必须先有 scheduledTaskId）。只传想改的字段，其它字段保持。修改后会自动重算下次触发时间。',
    properties: {
      scheduledTaskId: { type: 'string' },
      title: { type: 'string' },
      message: { type: 'string', description: '新的提醒文案/指令。' },
      action: { type: 'string', enum: ['notify_user', 'invoke_assistant'] },
      recurrence: { type: 'string', enum: ['once', 'daily', 'weekly', 'monthly', 'yearly'] },
      timezone: { type: 'string' },
      localTime: { type: 'string' },
      dayOfWeek: { description: '同 create_scheduled_task.dayOfWeek。' },
      dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
      month: { type: 'integer', minimum: 1, maximum: 12 },
      date: { type: 'string' },
      notifyConversationIds: { type: 'array', items: { type: 'string' }, description: '完整替换通知目标列表。空数组 = 改为后台静默。' },
      sharedContext: { type: 'boolean' },
      cwd: { type: 'string' }
    },
    required: ['scheduledTaskId']
  },
  cancel_scheduled_task: {
    type: 'object',
    description: '取消已存在的定时任务（按 scheduledTaskId）。',
    properties: {
      scheduledTaskId: { type: 'string' },
      reason: { type: 'string' }
    },
    required: ['scheduledTaskId']
  },
  list_scheduled_tasks: {
    type: 'object',
    description: '列出当前会话下还在生效的定时任务。当用户问 "我有哪些提醒/几个定时任务" 时使用。',
    properties: {
      includeCompleted: { type: 'boolean', description: '默认 false（只看还在生效的）。true 时也返回 completed/cancelled/failed 的历史记录。' },
      limit: { type: 'integer', minimum: 1, maximum: 200 }
    }
  },
  list_scheduled_task_runs: {
    type: 'object',
    description: '查看某个定时任务的运行历史（每次到点触发都是一个 run）。',
    properties: {
      scheduledTaskId: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    required: ['scheduledTaskId']
  },
  find_recent_scheduled_task_notifications: {
    type: 'object',
    description: '查询最近 N 分钟内（默认 30）向当前会话推送过的定时任务通知。用户说"刚才那个/继续上面那个"时用它定位是哪个任务。',
    properties: {
      withinMinutes: { type: 'integer', minimum: 1, maximum: 1440, description: '默认 30 分钟。' }
    }
  },
  handoff_execution: {
    type: 'object',
    properties: {
      executionId: { type: 'string' },
      fromExecutionId: { type: 'string' },
      kind: { type: 'string' },
      title: { type: 'string' },
      payload: { type: 'object' },
      conversationId: { type: 'string' }
    },
    required: ['executionId']
  },
  consume_execution_handoff: {
    type: 'object',
    properties: {
      executionId: { type: 'string' },
      handoffId: { type: 'string' },
      conversationId: { type: 'string' }
    },
    required: ['executionId', 'handoffId']
  },
  link_session_to_task: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      runtimeSessionId: { type: 'string' }
    },
    required: ['taskId', 'runtimeSessionId']
  }
});

export function buildAnthropicToolDefinitions(toolRegistry) {
  return toolRegistry.list().map((tool) => ({
    name: tool.name,
    description: tool.description || tool.name,
    input_schema: TOOL_SCHEMAS[tool.name] || {
      type: 'object',
      properties: {}
    }
  }));
}

export default {
  buildAnthropicToolDefinitions
};
