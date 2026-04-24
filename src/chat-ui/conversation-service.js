import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskFromRuntimeResult } from '../agent-core/task-service.js';
import { buildSupervisorBrief } from '../agent-orchestrator/supervisor-brief.js';
import { CHANNEL_CONVERSATION_MODE } from '../agent-channels/models.js';
import { syncSupervisorTaskForRuntimeStart } from '../agent-orchestrator/supervisor-task-sync.js';
import chatUiConversationStore from './conversation-store.js';
import assistantRunStore from '../assistant-core/run-store.js';
import AssistantModeService from '../assistant-core/mode-service.js';
import { AssistantObservationService } from '../assistant-core/observation-service.js';
import { AssistantTaskViewService } from '../assistant-core/task-view-service.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';

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
      const pendingApproval = this.messageService.listPendingApprovals(result.session.id)[0] || null;
      const pendingQuestion = this.messageService.listPendingQuestions(result.session.id)
        .find((entry) => entry.status === 'pending') || null;
      const synced = syncSupervisorTaskForRuntimeStart({
        conversation,
        session: result.session,
        supervisorContext,
        taskMemory: conversation.metadata?.supervisor?.taskMemory || null,
        pendingApproval,
        pendingQuestion,
        userInput: text,
        originKind: String(supervisorContext.kind || '').trim() || 'direct',
        activate: true,
        store: this.supervisorTaskStore
      });

      this.conversationStore.bindRuntimeSession(conversation.id, result.session.id, {
        mode: CHANNEL_CONVERSATION_MODE.AGENT_RUNTIME,
        lastPendingApprovalId: pendingApproval?.approvalId || null,
        lastPendingQuestionId: pendingQuestion?.questionId || null,
        activeTaskId: synced.taskMemory?.activeTaskId || conversation.activeTaskId || null,
        trackedTaskIds: synced.taskMemory?.taskOrder || conversation.trackedTaskIds || [],
        metadata: {
          ...(conversation.metadata || {}),
          supervisor: {
            ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
              ? conversation.metadata.supervisor
              : {}),
            taskMemory: synced.taskMemory,
            brief: synced.brief
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
