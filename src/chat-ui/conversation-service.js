import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskFromRuntimeResult } from '../agent-core/task-service.js';
import { buildSupervisorBrief } from '../agent-orchestrator/supervisor-brief.js';
import chatUiConversationStore from './conversation-store.js';
import assistantRunStore from '../assistant-core/run-store.js';
import AssistantModeService from '../assistant-core/mode-service.js';
import { AssistantObservationService } from '../assistant-core/observation-service.js';
import { AssistantTaskViewService } from '../assistant-core/task-view-service.js';
import { getAssistantControlMode } from '../assistant-core/assistant-state.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import {
  bindConversationToRuntimeStart,
  buildPendingResolutionPatch
} from '../assistant-core/conversation-runtime-binding.js';

export class ChatUiConversationService {
  constructor({
    conversationStore = chatUiConversationStore,
    messageService = agentOrchestratorMessageService,
    taskStore = agentTaskStore,
    assistantModeService = null
  } = {}) {
    this.conversationStore = conversationStore;
    this.messageService = messageService;
    this.taskStore = taskStore;
    this.supervisorTaskStore = this.messageService?.supervisorTaskStore;
    this.assistantModeService = assistantModeService || new AssistantModeService({
      conversationStore: this.conversationStore,
      messageService: this.messageService,
      observationService: new AssistantObservationService({
        conversationStore: this.conversationStore,
        runtimeSessionManager: this.messageService?.runtimeSessionManager || agentRuntimeSessionManager,
        taskStore: this.taskStore,
        deliveryStore: agentChannelDeliveryStore
      }),
      taskViewService: new AssistantTaskViewService({
        conversationStore: this.conversationStore,
        runtimeSessionManager: this.messageService?.runtimeSessionManager || agentRuntimeSessionManager,
        taskStore: this.taskStore,
        deliveryStore: agentChannelDeliveryStore,
        assistantRunStore
      })
    });
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
    metadata = {},
    assistantExecutionMode = 'sync',
    onBackgroundResult = null
  } = {}) {
    const conversation = this.getConversation(sessionId, metadata);
    const assistantResult = await this.assistantModeService.maybeHandleMessage({
      conversation,
      text,
      defaultRuntimeProvider,
      cwd,
      model,
      executionMode: assistantExecutionMode,
      onBackgroundResult
    });
    if (assistantResult) {
      return {
        ...assistantResult,
        previousSessionId: conversation.activeRuntimeSessionId || null,
        conversation: assistantResult.conversation || this.conversationStore.get(conversation.id)
      };
    }

    const previousSessionId = conversation.activeRuntimeSessionId || null;
    const result = await this.messageService.routeUserMessage({
      message: { text },
      conversation,
      defaultRuntimeProvider,
      cwd,
      model,
      metadata: {
        ...(metadata || {}),
        assistantMode: getAssistantControlMode(conversation),
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
      bindConversationToRuntimeStart({
        conversationStore: this.conversationStore,
        messageService: this.messageService,
        supervisorTaskStore: this.supervisorTaskStore,
        conversation,
        session: result.session,
        supervisorContext,
        userInput: text,
        originKind: String(supervisorContext.kind || '').trim() || 'direct',
        activate: true
      });
    }

    if (result?.type === 'approval_resolved') {
      this.conversationStore.patch(conversation.id, buildPendingResolutionPatch('approval'));
    }

    if (result?.type === 'question_answered') {
      this.conversationStore.patch(conversation.id, buildPendingResolutionPatch('question'));
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
