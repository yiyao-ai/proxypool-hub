import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskFromRuntimeResult } from '../agent-core/task-service.js';
import { buildSupervisorBrief } from '../agent-orchestrator/supervisor-brief.js';
import { CHANNEL_CONVERSATION_MODE } from '../agent-channels/models.js';
import chatUiConversationStore from './conversation-store.js';

export class ChatUiConversationService {
  constructor({
    conversationStore = chatUiConversationStore,
    messageService = agentOrchestratorMessageService,
    taskStore = agentTaskStore
  } = {}) {
    this.conversationStore = conversationStore;
    this.messageService = messageService;
    this.taskStore = taskStore;
  }

  getConversation(sessionId, metadata = {}) {
    return this.conversationStore.findOrCreateBySessionId(sessionId, metadata);
  }

  async routeMessage({
    sessionId,
    text,
    defaultRuntimeProvider = 'codex',
    cwd,
    model = '',
    metadata = {}
  } = {}) {
    const conversation = this.getConversation(sessionId, metadata);
    const previousSessionId = conversation.activeRuntimeSessionId || null;
    const result = await this.messageService.routeUserMessage({
      message: { text },
      conversation,
      defaultRuntimeProvider,
      cwd,
      model,
      metadata: {
        ...(metadata || {}),
        source: {
          kind: 'chat-ui',
          sessionId: String(sessionId || ''),
          conversationId: conversation.id
        },
        conversationId: conversation.id
      }
    });

    if (result?.type === 'conversation_reset') {
      return {
        ...result,
        conversation: this.conversationStore.clearActiveRuntimeSession(conversation.id)
      };
    }

    if (result?.session?.id) {
      const supervisorContext = (result?.supervisorContext && typeof result.supervisorContext === 'object')
        ? result.supervisorContext
        : {};
      const taskMemory = {
        ...((conversation.metadata?.supervisor?.taskMemory && typeof conversation.metadata.supervisor.taskMemory === 'object')
          ? conversation.metadata.supervisor.taskMemory
          : {}),
        current: {
          sessionId: result.session.id,
          provider: result.session.provider,
          title: supervisorContext.title || result.session.title || text || '',
          status: 'starting',
          startedAt: result.session.createdAt || new Date().toISOString(),
          lastUpdateAt: result.session.updatedAt || new Date().toISOString(),
          summary: String(supervisorContext.summary || '').trim(),
          result: '',
          originKind: String(supervisorContext.kind || '').trim() || 'direct',
          sourceTitle: String(supervisorContext.sourceTitle || '').trim(),
          sourceProvider: String(supervisorContext.sourceProvider || '').trim(),
          sourceStatus: String(supervisorContext.sourceStatus || '').trim()
        }
      };

      this.conversationStore.bindRuntimeSession(conversation.id, result.session.id, {
        mode: CHANNEL_CONVERSATION_MODE.AGENT_RUNTIME,
        metadata: {
          ...(conversation.metadata || {}),
          supervisor: {
            ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
              ? conversation.metadata.supervisor
              : {}),
            taskMemory,
            brief: buildSupervisorBrief({
              taskMemory,
              session: result.session
            })
          }
        }
      });
    }

    if (result?.type === 'approval_resolved') {
      this.conversationStore.patch(conversation.id, {
        lastPendingApprovalId: null
      });
    }

    if (result?.type === 'question_answered') {
      this.conversationStore.patch(conversation.id, {
        lastPendingQuestionId: null
      });
    }

    const response = {
      ...result,
      previousSessionId,
      conversation: this.conversationStore.get(conversation.id)
    };

    if (result?.session?.id && (result.type === 'runtime_started' || result.type === 'runtime_continued')) {
      syncTaskFromRuntimeResult({
        conversation: response.conversation,
        result: response,
        userInput: text,
        store: this.taskStore
      });
    }

    return response;
  }
}

export const chatUiConversationService = new ChatUiConversationService();

export default chatUiConversationService;
