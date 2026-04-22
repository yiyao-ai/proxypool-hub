import assistantObservationService from './observation-service.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import assistantConversationControlService from './conversation-control.js';
import assistantTaskViewService from './task-view-service.js';

function normalizeText(value) {
  return String(value || '').trim();
}

export class AssistantToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(definition = {}) {
    const name = normalizeText(definition.name);
    if (!name) {
      throw new Error('tool name is required');
    }
    this.tools.set(name, {
      ...definition,
      name
    });
    return this.tools.get(name);
  }

  get(name) {
    return this.tools.get(normalizeText(name)) || null;
  }

  list() {
    return [...this.tools.values()];
  }
}

export function createDefaultAssistantToolRegistry({
  observationService = assistantObservationService,
  messageService = agentOrchestratorMessageService,
  conversationControlService = assistantConversationControlService,
  taskViewService = assistantTaskViewService
} = {}) {
  const registry = new AssistantToolRegistry();

  registry.register({
    name: 'get_workspace_context',
    description: 'Get workspace-wide runtime and conversation summary.',
    execute: async ({ input = {} } = {}) => observationService.getWorkspaceContext(input)
  });

  registry.register({
    name: 'list_runtime_sessions',
    description: 'List recent runtime sessions.',
    execute: async ({ input = {} } = {}) => observationService.listRuntimeSessions(input)
  });

  registry.register({
    name: 'get_runtime_session',
    description: 'Get runtime session detail.',
    execute: async ({ input = {} } = {}) => observationService.getRuntimeSessionDetail(input.sessionId, input)
  });

  registry.register({
    name: 'list_conversations',
    description: 'List recent conversations.',
    execute: async ({ input = {} } = {}) => observationService.listConversations(input)
  });

  registry.register({
    name: 'get_conversation_context',
    description: 'Get conversation context detail.',
    execute: async ({ input = {} } = {}) => observationService.getConversationContext(input.conversationId, input)
  });

  registry.register({
    name: 'start_runtime_task',
    description: 'Start a new runtime task through the shared runtime control service.',
    execute: async ({ input = {} } = {}) => messageService.startRuntimeTask({
      provider: input.provider,
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: input.metadata || {}
    })
  });

  registry.register({
    name: 'delegate_to_codex',
    description: 'Delegate a new task to Codex.',
    execute: async ({ input = {} } = {}) => messageService.startRuntimeTask({
      provider: 'codex',
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: input.metadata || {}
    })
  });

  registry.register({
    name: 'delegate_to_claude_code',
    description: 'Delegate a new task to Claude Code.',
    execute: async ({ input = {} } = {}) => messageService.startRuntimeTask({
      provider: 'claude-code',
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: input.metadata || {}
    })
  });

  registry.register({
    name: 'delegate_to_runtime',
    description: 'Delegate a new task to a selected runtime provider.',
    execute: async ({ input = {} } = {}) => {
      const provider = String(input.provider || '').trim() === 'claude-code'
        ? 'claude-code'
        : 'codex';
      const toolName = provider === 'claude-code'
        ? 'delegate_to_claude_code'
        : 'delegate_to_codex';
      return registry.get(toolName).execute({ input });
    }
  });

  registry.register({
    name: 'send_runtime_input',
    description: 'Send follow-up input to an existing runtime session.',
    execute: async ({ input = {} } = {}) => messageService.continueRuntimeTask({
      sessionId: input.sessionId,
      input: input.message
    })
  });

  registry.register({
    name: 'reuse_or_delegate',
    description: 'Reuse the active runtime when possible, otherwise start a new runtime task.',
    execute: async ({ input = {} } = {}) => {
      if (input.sessionId && input.message) {
        return messageService.continueRuntimeTask({
          sessionId: input.sessionId,
          input: input.message
        });
      }
      return messageService.startRuntimeTask({
        provider: input.provider,
        input: input.task,
        cwd: input.cwd,
        model: input.model,
        metadata: input.metadata || {}
      });
    }
  });

  registry.register({
    name: 'cancel_runtime_session',
    description: 'Cancel a runtime session.',
    execute: async ({ input = {} } = {}) => messageService.cancelRuntimeSession({
      sessionId: input.sessionId
    })
  });

  registry.register({
    name: 'reset_conversation_binding',
    description: 'Reset conversation binding to the current runtime session.',
    execute: async ({ input = {} } = {}) => conversationControlService.resetConversationBinding({
      conversationId: input.conversationId
    })
  });

  registry.register({
    name: 'resolve_runtime_approval',
    description: 'Resolve a runtime approval request.',
    execute: async ({ input = {} } = {}) => messageService.resolveApproval({
      sessionId: input.sessionId,
      approvalId: input.approvalId,
      decision: input.decision
    })
  });

  registry.register({
    name: 'answer_runtime_question',
    description: 'Answer a runtime question.',
    execute: async ({ input = {} } = {}) => messageService.answerQuestion({
      sessionId: input.sessionId,
      questionId: input.questionId,
      answer: input.answer
    })
  });

  registry.register({
    name: 'summarize_runtime_result',
    description: 'Summarize a runtime session result using observation data.',
    execute: async ({ input = {} } = {}) => {
      const detail = await observationService.getRuntimeSessionDetail(input.sessionId, {
        eventLimit: input.eventLimit || 20
      });
      if (!detail) return null;
      return {
        sessionId: detail.session?.id || '',
        provider: detail.session?.provider || '',
        status: detail.session?.status || '',
        title: detail.task?.title || detail.session?.title || '',
        summary: detail.task?.summary || detail.session?.summary || '',
        result: detail.task?.result || '',
        pendingApprovals: Array.isArray(detail.pendingApprovals) ? detail.pendingApprovals.length : 0,
        pendingQuestions: Array.isArray(detail.pendingQuestions) ? detail.pendingQuestions.length : 0
      };
    }
  });

  registry.register({
    name: 'list_tasks',
    description: 'List unified assistant task records across conversations.',
    execute: async ({ input = {} } = {}) => taskViewService.listTasks(input)
  });

  registry.register({
    name: 'get_task',
    description: 'Get a unified assistant task record.',
    execute: async ({ input = {} } = {}) => taskViewService.getTask(input.taskId)
  });

  registry.register({
    name: 'list_project_artifacts',
    description: 'Return project-level artifacts from workspace summaries.',
    execute: async ({ input = {} } = {}) => {
      const context = observationService.getWorkspaceContext({
        runtimeLimit: input.runtimeLimit || 10,
        conversationLimit: input.conversationLimit || 10
      });
      return {
        runtimeSessions: context.runtimeSessions || [],
        conversations: context.conversations || []
      };
    }
  });

  registry.register({
    name: 'search_project_memory',
    description: 'Search task and conversation summaries in the current workspace.',
    execute: async ({ input = {} } = {}) => observationService.searchProjectMemory({
      query: input.query,
      limit: input.limit || 10
    })
  });

  return registry;
}

export default createDefaultAssistantToolRegistry;

