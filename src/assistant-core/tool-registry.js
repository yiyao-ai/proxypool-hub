import assistantObservationService from './observation-service.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';

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
  messageService = agentOrchestratorMessageService
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
    name: 'send_runtime_input',
    description: 'Send follow-up input to an existing runtime session.',
    execute: async ({ input = {} } = {}) => messageService.continueRuntimeTask({
      sessionId: input.sessionId,
      input: input.message
    })
  });

  registry.register({
    name: 'cancel_runtime_session',
    description: 'Cancel a runtime session.',
    execute: async ({ input = {} } = {}) => messageService.cancelRuntimeSession({
      sessionId: input.sessionId
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

  return registry;
}

export default createDefaultAssistantToolRegistry;

