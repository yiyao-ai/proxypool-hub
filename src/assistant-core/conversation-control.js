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
}

export const assistantConversationControlService = new AssistantConversationControlService();

export default assistantConversationControlService;
