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
