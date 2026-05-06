import assistantObservationService from './observation-service.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import assistantConversationControlService from './conversation-control.js';
import assistantTaskViewService from './task-view-service.js';
import assistantClarificationStore from './clarification-store.js';
import assistantWorkspaceStore from './workspace-store.js';
import assistantEpisodeViewService, { AssistantEpisodeViewService } from './episode-view-service.js';
import { resolveReferenceContext } from '../assistant-agent/reference-resolver.js';

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
  taskViewService = assistantTaskViewService,
  clarificationStore = assistantClarificationStore,
  workspaceStore = assistantWorkspaceStore,
  episodeViewService = null
} = {}) {
  const resolvedEpisodeViewService = episodeViewService || new AssistantEpisodeViewService({
    conversationStore: observationService?.conversationStore,
    deliveryStore: observationService?.deliveryStore,
    supervisorTaskStore: taskViewService?.supervisorTaskStore || observationService?.supervisorTaskStore || assistantEpisodeViewService.supervisorTaskStore
  });
  const registry = new AssistantToolRegistry();

  function withAssistantConversationMetadata(input = {}, context = {}) {
    const conversation = context?.conversation || null;
    const baseMetadata = {
      ...((input?.metadata && typeof input.metadata === 'object') ? input.metadata : {}),
      ...(input?.taskId ? { taskId: input.taskId } : {}),
      ...(input?.executionRole ? { executionRole: input.executionRole } : {}),
      ...(input?.role ? { executionRole: input.role } : {})
    };
    if (!conversation?.id) {
      return baseMetadata;
    }
    return {
      ...baseMetadata,
      conversationId: conversation.id,
      source: {
        ...(baseMetadata.source && typeof baseMetadata.source === 'object' ? baseMetadata.source : {}),
        kind: 'assistant',
        conversationId: conversation.id
      }
    };
  }

  function requireConversation(context = {}) {
    const conversation = context?.conversation || null;
    if (!conversation?.id) {
      throw new Error('conversation context is required');
    }
    return conversation;
  }

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
    description: 'Get broad conversation context detail. Use when you need deliveries, memory, policy, or active runtime state beyond task-space summaries.',
    execute: async ({ input = {} } = {}) => observationService.getConversationContext(input.conversationId, input)
  });

  registry.register({
    name: 'get_conversation_task_space',
    description: 'Get task-space-first conversation context including focus, active, waiting, and recent tasks. Prefer this before deciding whether to continue a task, delegate a fresh runtime, or ask for clarification.',
    execute: async ({ input = {} } = {}) => taskViewService.getConversationTaskSpace(input.conversationId, input)
  });

  registry.register({
    name: 'start_runtime_task',
    description: 'Start a brand-new runtime task through the shared runtime control service. Use only when the user clearly wants a fresh execution and no existing task should be reused.',
    execute: async ({ input = {}, context = {} } = {}) => messageService.startRuntimeTask({
      provider: input.provider,
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: withAssistantConversationMetadata(input, context)
    })
  });

  registry.register({
    name: 'delegate_to_codex',
    description: 'Delegate a brand-new task to Codex. Use for fresh execution, not for continuing an existing task.',
    execute: async ({ input = {}, context = {} } = {}) => messageService.startRuntimeTask({
      provider: 'codex',
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: withAssistantConversationMetadata(input, context)
    })
  });

  registry.register({
    name: 'delegate_to_claude_code',
    description: 'Delegate a brand-new task to Claude Code. Use for fresh execution, not for continuing an existing task.',
    execute: async ({ input = {}, context = {} } = {}) => messageService.startRuntimeTask({
      provider: 'claude-code',
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: withAssistantConversationMetadata(input, context)
    })
  });

  registry.register({
    name: 'delegate_to_runtime',
    description: 'Delegate a brand-new task to a selected runtime provider. Use only when the user wants new execution rather than follow-up on an existing task.',
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
    name: 'delegate_task_execution',
    description: 'Start a new execution for a supervisor task. Prefer this when you already know the task identity and want to preserve task ownership while launching fresh execution.',
    execute: async ({ input = {}, context = {} } = {}) => messageService.startRuntimeTask({
      provider: input.provider,
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: withAssistantConversationMetadata({
        ...input,
        taskId: input.taskId,
        executionRole: input.role
      }, context)
    })
  });

  registry.register({
    name: 'send_runtime_input',
    description: 'Send follow-up input to a known runtime session id. Prefer continue_task when you know the task but do not want to rely on raw runtime session routing.',
    execute: async ({ input = {} } = {}) => messageService.continueRuntimeTask({
      sessionId: input.sessionId,
      input: input.message
    })
  });

  registry.register({
    name: 'continue_task',
    description: 'Continue an existing task by task id or runtime session id. This is the preferred tool for task follow-up when there is a focus task or a single clear waiting task.',
    execute: async ({ input = {} } = {}) => {
      const resolvedTask = input.taskId
        ? taskViewService.getTask(input.taskId)
        : null;
      const sessionId = String(
        resolvedTask?.runtimeSession?.id
        || resolvedTask?.task?.primaryExecutionId
        || resolvedTask?.task?.runtimeSessionId
        || input.sessionId
        || ''
      ).trim();
      if (!sessionId) {
        throw new Error('continue_task requires taskId or sessionId');
      }
      return messageService.continueRuntimeTask({
        taskId: input.taskId,
        sessionId,
        input: input.message
      });
    }
  });

  registry.register({
    name: 'reuse_or_delegate',
    description: 'Compatibility tool that reuses a runtime session when explicitly provided, otherwise starts a new runtime task. Prefer continue_task or delegate_to_runtime when the intent is clear.',
    execute: async ({ input = {}, context = {} } = {}) => {
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
        metadata: withAssistantConversationMetadata(input, context)
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
    description: 'Resolve a pending runtime approval request. Pass remember="session" if the user said something like "允许后续所有操作 / 本会话同意 / from now on" — this records a wildcard policy so future approvals of the same kind auto-pass within this runtime session. Pass remember="conversation" if the user explicitly bound the permission to the current conversation ("这次对话都同意"). Default remember="none" (one-shot approval). Only valid when decision="approve".',
    execute: async ({ input = {}, context = {} } = {}) => messageService.resolveApproval({
      sessionId: input.sessionId,
      approvalId: input.approvalId,
      decision: input.decision,
      remember: input.remember,
      conversationId: input.conversationId || context?.conversation?.id || ''
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
    name: 'cancel_pending_question',
    description: 'Cancel a pending runtime question when the user is clearly switching intent and the old question should no longer block routing.',
    execute: async ({ input = {} } = {}) => messageService.cancelPendingQuestion({
      sessionId: input.sessionId,
      questionId: input.questionId,
      reason: input.reason
    })
  });

  registry.register({
    name: 'ask_user',
    description: 'Ask a structured clarification question, persist a PendingClarification record, and mark the conversation as waiting for clarification.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = requireConversation(context);
      const clarification = clarificationStore.create({
        conversationId: conversation.id,
        question: input.question,
        candidates: Array.isArray(input.candidates) ? input.candidates : [],
        ttlSec: input.ttlSec
      });
      const patchedConversation = conversationControlService.conversationStore.patch(conversation.id, {
        lastPendingClarificationId: clarification.id
      }) || conversation;
      return {
        clarificationId: clarification.id,
        question: clarification.question,
        candidates: clarification.candidates,
        ttlSec: clarification.ttlSec,
        conversationId: conversation.id,
        conversation: patchedConversation
      };
    }
  });

  registry.register({
    name: 'resolve_clarification',
    description: 'Resolve a pending clarification by selecting a candidate or recording a free-text answer.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = requireConversation(context);
      const clarification = clarificationStore.answer(input.clarificationId, {
        selectedCandidateId: input.candidateId,
        freeTextAnswer: input.freeText
      });
      if (!clarification) {
        throw new Error('clarification not found');
      }
      if (clarification.conversationId !== conversation.id) {
        throw new Error('clarification does not belong to this conversation');
      }
      const patchedConversation = conversationControlService.conversationStore.patch(conversation.id, {
        lastPendingClarificationId: null
      }) || conversation;
      return {
        clarificationId: clarification.id,
        status: clarification.status,
        resolution: clarification.resolution,
        conversationId: clarification.conversationId,
        conversation: patchedConversation
      };
    }
  });

  registry.register({
    name: 'cancel_pending_clarification',
    description: 'Cancel an assistant-level pending clarification when it is no longer relevant.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = requireConversation(context);
      const clarification = clarificationStore.cancel(input.clarificationId);
      if (!clarification) {
        throw new Error('clarification not found');
      }
      if (clarification.conversationId !== conversation.id) {
        throw new Error('clarification does not belong to this conversation');
      }
      const patchedConversation = conversationControlService.conversationStore.patch(conversation.id, {
        lastPendingClarificationId: null
      }) || conversation;
      return {
        clarificationId: clarification.id,
        status: clarification.status,
        conversationId: clarification.conversationId,
        reason: normalizeText(input.reason),
        conversation: patchedConversation
      };
    }
  });

  registry.register({
    name: 'summarize_runtime_result',
    description: 'Summarize a runtime session result using observation data.',
    execute: async ({ input = {} } = {}) => {
      const detail = await observationService.getRuntimeSessionDetail(input.sessionId, {
        eventLimit: input.eventLimit || 20,
        rememberMemory: false
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
    description: 'List unified assistant task records across conversations. Use for broad search or cross-conversation status, not as a replacement for get_conversation_task_space.',
    execute: async ({ input = {} } = {}) => taskViewService.listTasks(input)
  });

  registry.register({
    name: 'get_task',
    description: 'Get a unified assistant task record by task id. Use when a specific task has already been identified.',
    execute: async ({ input = {} } = {}) => taskViewService.getTask(input.taskId)
  });

  registry.register({
    name: 'get_task_by_runtime_session',
    description: 'Resolve a task record from a runtime session id. Use when you know a runtime session id but need the task object that owns it.',
    execute: async ({ input = {} } = {}) => {
      const sessionId = String(input.sessionId || '').trim();
      if (!sessionId) return null;
      const tasks = taskViewService.listTasks({
        conversationId: input.conversationId,
        limit: Math.max(Number(input.limit || 50), 1)
      });
      return tasks.find((entry) => String(entry?.runtimeSession?.id || entry?.task?.runtimeSessionId || '').trim() === sessionId) || null;
    }
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
    name: 'search_task_and_conversation_memory',
    description: 'Search task and conversation summaries in the current workspace.',
    execute: async ({ input = {} } = {}) => observationService.searchProjectMemory({
      query: input.query,
      limit: input.limit || 10
    })
  });

  registry.register({
    name: 'recall',
    description: 'Recall relevant past task, conversation, and delivery episodes. Use for "earlier", "last week", or historical follow-up requests before deciding whether to continue or ask for clarification.',
    execute: async ({ input = {}, context = {} } = {}) => resolvedEpisodeViewService.recall({
      query: input.query,
      scope: input.scope || 'workspace',
      conversationId: input.conversationId || context?.conversation?.id || '',
      limit: input.limit || 10
    })
  });

  registry.register({
    name: 'find_task_by_keyword',
    description: 'Find tasks by keyword across task title, summary, cwd, cwd basename, and remembered aliases. Prefer this before asking the user when you have a concrete project or task phrase.',
    execute: async ({ input = {} } = {}) => {
      const query = normalizeText(input.query);
      if (!query) {
        throw new Error('query is required');
      }
      const tasks = observationService.getRecentTasks({
        conversationId: input.conversationId,
        limit: Math.max(Number(input.limit || 10), 1)
      });
      const normalizedQuery = query.toLowerCase();
      return tasks.filter((entry) => (
        [
          entry.title,
          entry.summary,
          entry.result,
          entry.error,
          entry.cwd,
          entry.cwdBasename
        ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery))
      )).slice(0, Math.max(Number(input.limit || 10), 1));
    }
  });

  registry.register({
    name: 'list_known_cwds',
    description: 'List recently known cwd records, including aliases and linked task ids.',
    execute: async ({ input = {} } = {}) => observationService.getKnownCwds({
      recent: input.recent !== false,
      limit: input.limit || 10
    })
  });

  registry.register({
    name: 'get_cwd_info',
    description: 'Get detailed info for a known cwd, including aliases and linked tasks. Use after list_known_cwds or when the user names a specific project path.',
    execute: async ({ input = {} } = {}) => observationService.getCwdInfo({
      cwd: input.cwd,
      workspaceId: input.workspaceId
    })
  });

  registry.register({
    name: 'add_cwd_alias',
    description: 'Add a user-facing alias to a known cwd record. Use only when the user has actually referred to that cwd with this alias.',
    execute: async ({ input = {} } = {}) => {
      const target = input.workspaceId
        ? workspaceStore.list({ limit: 500 }).find((entry) => String(entry?.id || '').trim() === normalizeText(input.workspaceId)) || null
        : workspaceStore.getByRef(input.cwd);
      if (!target) {
        throw new Error('workspace not found');
      }
      return workspaceStore.upsert({
        workspaceRef: target.workspaceRef,
        patch: {
          aliases: [input.alias]
        }
      });
    }
  });

  registry.register({
    name: 'link_task_to_conversation',
    description: 'Adopt an existing task into the current conversation. Use only when the user explicitly wants to take over or continue a task here from another conversation.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = requireConversation(context);
      const taskRecord = taskViewService.getTask(input.taskId);
      const persistedTask = taskRecord?.task?.id
        ? taskRecord.task
        : taskViewService.supervisorTaskStore.get(input.taskId);
      if (!persistedTask?.id) {
        throw new Error('task not found');
      }
      const runtimeSessionId = String(
        input.runtimeSessionId
        || taskRecord?.runtimeSession?.id
        || persistedTask?.latestExecutionId
        || persistedTask?.primaryExecutionId
        || persistedTask?.runtimeSessionId
        || persistedTask?.metadata?.latestExecutionId
        || persistedTask?.metadata?.runtimeSessionId
        || ''
      ).trim();
      const patchedConversation = conversationControlService.linkTaskToConversation({
        conversationId: conversation.id,
        taskId: persistedTask.id,
        runtimeSessionId,
        metadata: {
          supervisor: {
            ...((conversation?.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
              ? conversation.metadata.supervisor
              : {})
          }
        }
      });
      if (!patchedConversation) {
        throw new Error('failed to link task to conversation');
      }
      if (persistedTask?.id) {
        taskViewService.supervisorTaskStore.save({
          ...persistedTask,
          lastConversationId: conversation.id
        });
      }
      return {
        conversationId: conversation.id,
        taskId: persistedTask.id,
        runtimeSessionId,
        conversation: patchedConversation
      };
    }
  });

  registry.register({
    name: 'link_session_to_task',
    description: 'Adopt an existing runtime session into a supervisor task by appending it to executionIds. Use only as a data-repair operation when a session was misrouted (e.g., user reports a session belongs to a different task than the system thinks). Will not change primaryExecutionId; the new sessionId becomes latestExecutionId.',
    execute: async ({ input = {} } = {}) => {
      const taskId = String(input.taskId || '').trim();
      const sessionId = String(input.sessionId || '').trim();
      if (!taskId) {
        throw new Error('taskId is required');
      }
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      const persistedTask = taskViewService.supervisorTaskStore.get(taskId);
      if (!persistedTask?.id) {
        throw new Error('task not found');
      }
      const previousExecutionIds = Array.isArray(persistedTask.executionIds)
        ? persistedTask.executionIds
        : [];
      if (previousExecutionIds.includes(sessionId)) {
        return {
          taskId: persistedTask.id,
          sessionId,
          alreadyLinked: true,
          executionIds: previousExecutionIds
        };
      }
      const next = taskViewService.supervisorTaskStore.save({
        ...persistedTask,
        executionIds: [...previousExecutionIds, sessionId],
        lastUpdateAt: new Date().toISOString(),
        metadata: {
          ...(persistedTask.metadata || {}),
          latestExecutionId: sessionId,
          runtimeSessionId: sessionId
        }
      });
      return {
        taskId: next.id,
        sessionId,
        alreadyLinked: false,
        executionIds: next.executionIds
      };
    }
  });

  registry.register({
    name: 'resolve_reference',
    description: 'Resolve a phrase into likely task or cwd candidates. Use when the built-in reference_resolution block is ambiguous and you want an explicit re-check before acting.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversationId = input.conversationId || context?.conversation?.id || '';
      const taskSpace = conversationId
        ? taskViewService.getConversationTaskSpace(conversationId, {
            activeLimit: 5,
            waitingLimit: 5,
            recentLimit: 8
          })
        : null;
      const workspaceContext = observationService.getWorkspaceContext({
        runtimeLimit: 6,
        conversationLimit: 6
      });
      const conversationContext = conversationId
        ? observationService.getConversationContext(conversationId, {
            deliveryLimit: 8
          })
        : null;
      return resolveReferenceContext({
        text: input.phrase,
        taskSpace,
        workspaceContext,
        conversationContext
      });
    }
  });

  registry.register({
    name: 'search_project_memory',
    description: 'Deprecated alias for search_task_and_conversation_memory.',
    execute: async ({ input = {} } = {}) => registry.get('search_task_and_conversation_memory').execute({ input })
  });

  return registry;
}

export default createDefaultAssistantToolRegistry;

