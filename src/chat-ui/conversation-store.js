import { AgentChannelConversationStore } from '../agent-channels/conversation-store.js';

export class ChatUiConversationStore extends AgentChannelConversationStore {
  getBySessionId(sessionId) {
    return this.findByExternal(
      'chat-ui',
      'default',
      String(sessionId || ''),
      'local-user'
    );
  }

  findOrCreateBySessionId(sessionId, metadata = {}) {
    return this.findOrCreateByExternal({
      channel: 'chat-ui',
      accountId: 'default',
      externalConversationId: String(sessionId || ''),
      externalUserId: 'local-user',
      title: `Chat UI / ${String(sessionId || 'session')}`,
      metadata
    });
  }
}

export const chatUiConversationStore = new ChatUiConversationStore();

export default chatUiConversationStore;
