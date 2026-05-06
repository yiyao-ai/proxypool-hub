import chatUiConversationStore from '../chat-ui/conversation-store.js';

function buildMetadataPatch(current = {}) {
  return {
    ...(current && typeof current === 'object' ? current : {}),
    supervisor: {
      ...((current?.supervisor && typeof current.supervisor === 'object') ? current.supervisor : {}),
      brief: {
        kind: 'empty',
        title: '',
        provider: '',
        providerLabel: '',
        status: '',
        summary: '',
        result: '',
        error: '',
        waitingReason: '',
        nextSuggestion: ''
      }
    }
  };
}

export class AssistantConversationControlService {
  constructor({
    conversationStore = chatUiConversationStore
  } = {}) {
    this.conversationStore = conversationStore;
  }

  resetConversationBinding({ conversationId } = {}) {
    const current = this.conversationStore.get(String(conversationId || ''));
    if (!current) return null;

    return this.conversationStore.patch(current.id, {
      activeRuntimeSessionId: null,
      lastPendingApprovalId: null,
      lastPendingQuestionId: null,
      metadata: buildMetadataPatch(current.metadata || {})
    });
  }

  linkTaskToConversation({
    conversationId,
    taskId,
    runtimeSessionId = '',
    metadata = {}
  } = {}) {
    const current = this.conversationStore.get(String(conversationId || ''));
    if (!current) return null;

    const normalizedTaskId = String(taskId || '').trim();
    const normalizedSessionId = String(runtimeSessionId || '').trim();
    return this.conversationStore.bindSupervisorTask(current.id, normalizedTaskId, {
      ...(normalizedSessionId ? { activeRuntimeSessionId: normalizedSessionId } : {}),
      trackedRuntimeSessionIds: normalizedSessionId
        ? [
            ...(Array.isArray(current?.trackedRuntimeSessionIds) ? current.trackedRuntimeSessionIds : []),
            normalizedSessionId
          ]
        : current?.trackedRuntimeSessionIds || [],
      metadata: {
        ...(current.metadata || {}),
        ...(metadata && typeof metadata === 'object' ? metadata : {})
      }
    });
  }
}

export const assistantConversationControlService = new AssistantConversationControlService();

export default assistantConversationControlService;
