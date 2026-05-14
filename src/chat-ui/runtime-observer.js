import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskTerminalState } from '../agent-core/task-service.js';
import supervisorTaskStore from '../agent-orchestrator/supervisor-task-store.js';
import chatUiConversationStore from './conversation-store.js';
import { buildConversationRuntimeEventPatch } from '../assistant-core/conversation-runtime-binding.js';

const OBSERVED_EVENT_TYPES = new Set([
  AGENT_EVENT_TYPE.STARTED,
  AGENT_EVENT_TYPE.APPROVAL_REQUEST,
  AGENT_EVENT_TYPE.QUESTION,
  AGENT_EVENT_TYPE.COMPLETED,
  AGENT_EVENT_TYPE.FAILED
]);

export class ChatUiRuntimeObserver {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    conversationStore = chatUiConversationStore,
    taskStore = agentTaskStore,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.conversationStore = conversationStore;
    this.taskStore = taskStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.unsubscribe = null;
  }

  start() {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.runtimeSessionManager.eventBus.subscribeAll((event) => {
      this.handleRuntimeEvent(event).catch(() => {});
    });
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  async handleRuntimeEvent(event) {
    if (!OBSERVED_EVENT_TYPES.has(event?.type)) {
      return;
    }

    const conversations = this.conversationStore.listByRuntimeSessionId(event.sessionId)
      .filter((entry) => entry.channel === 'chat-ui');
    if (conversations.length === 0) {
      return;
    }

    const session = this.runtimeSessionManager.getSession(event.sessionId);
    syncTaskTerminalState({
      session,
      event,
      store: this.taskStore
    });

    for (const conversation of conversations) {
      const patch = buildConversationRuntimeEventPatch({
        conversation,
        session,
        event,
        supervisorTaskStore: this.supervisorTaskStore
      });
      this.conversationStore.patch(conversation.id, patch);
    }
  }
}

export const chatUiRuntimeObserver = new ChatUiRuntimeObserver();

export default chatUiRuntimeObserver;
