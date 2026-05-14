import { normalizeConversationWorkingSet, normalizeRecentMessages, nowIso, toText } from './models.js';

export class ConversationStateService {
  constructor({ conversationStore } = {}) {
    this.conversationStore = conversationStore;
  }

  patchConversation(conversationId, patch = {}) {
    if (!this.conversationStore?.patch) return null;
    return this.conversationStore.patch(conversationId, patch);
  }

  updateWorkingSet(conversationId, patch = {}) {
    const current = this.conversationStore?.get?.(String(conversationId || ''));
    if (!current?.id) return null;
    const workingSet = normalizeConversationWorkingSet({
      ...(current.metadata?.assistantDomain?.workingSet || {}),
      ...(patch || {})
    });
    return this.patchConversation(current.id, {
      metadata: {
        ...(current.metadata || {}),
        assistantDomain: {
          ...(current.metadata?.assistantDomain || {}),
          personId: toText(current.metadata?.assistantDomain?.personId),
          workingSet,
          recentMessages: normalizeRecentMessages(current.metadata?.assistantDomain?.recentMessages || [])
        }
      }
    });
  }

  appendRecentMessage(conversationId, message = {}) {
    const current = this.conversationStore?.get?.(String(conversationId || ''));
    if (!current?.id) return null;
    const recentMessages = normalizeRecentMessages([
      ...(current.metadata?.assistantDomain?.recentMessages || []),
      {
        role: message.role,
        text: message.text,
        createdAt: message.createdAt || nowIso()
      }
    ]);
    return this.patchConversation(current.id, {
      metadata: {
        ...(current.metadata || {}),
        assistantDomain: {
          ...(current.metadata?.assistantDomain || {}),
          personId: toText(current.metadata?.assistantDomain?.personId),
          workingSet: normalizeConversationWorkingSet(current.metadata?.assistantDomain?.workingSet || {}),
          recentMessages
        }
      }
    });
  }

  bindPerson(conversationId, personId, patch = {}) {
    const current = this.conversationStore?.get?.(String(conversationId || ''));
    if (!current?.id) return null;
    return this.patchConversation(current.id, {
      ...patch,
      metadata: {
        ...(current.metadata || {}),
        assistantDomain: {
          ...(current.metadata?.assistantDomain || {}),
          personId: toText(personId),
          workingSet: normalizeConversationWorkingSet(current.metadata?.assistantDomain?.workingSet || {}),
          recentMessages: normalizeRecentMessages(current.metadata?.assistantDomain?.recentMessages || [])
        }
      }
    });
  }
}

export default ConversationStateService;
