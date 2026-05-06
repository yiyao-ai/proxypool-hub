import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskTerminalState } from '../agent-core/task-service.js';
import { buildConversationSupervisorPatch } from '../agent-orchestrator/conversation-supervisor-state.js';
import supervisorTaskStore from '../agent-orchestrator/supervisor-task-store.js';
import { syncSupervisorTaskForRuntimeEvent } from '../agent-orchestrator/supervisor-task-sync.js';
import agentChannelConversationStore from './conversation-store.js';
import agentChannelDeliveryStore from './delivery-store.js';
import { formatAgentRuntimeEventForChannel } from './formatter.js';
import agentChannelRegistry from './registry.js';

const NOTIFIABLE_EVENT_TYPES = new Set([
  AGENT_EVENT_TYPE.STARTED,
  AGENT_EVENT_TYPE.APPROVAL_REQUEST,
  AGENT_EVENT_TYPE.QUESTION,
  AGENT_EVENT_TYPE.COMPLETED,
  AGENT_EVENT_TYPE.FAILED
]);

export class AgentChannelOutboundDispatcher {
  constructor({
    runtimeSessionManager = agentRuntimeSessionManager,
    conversationStore = agentChannelConversationStore,
    deliveryStore = agentChannelDeliveryStore,
    registry = agentChannelRegistry,
    taskStore = agentTaskStore,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.conversationStore = conversationStore;
    this.deliveryStore = deliveryStore;
    this.registry = registry;
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
    if (!NOTIFIABLE_EVENT_TYPES.has(event?.type)) {
      return;
    }

    const session = this.runtimeSessionManager.getSession(event.sessionId);
    const conversations = this.conversationStore.listByTrackedRuntimeSessionId(event.sessionId);
    const fallbackConversation = session?.metadata?.conversationId
      ? this.conversationStore.get(session.metadata.conversationId)
      : null;
    const targetConversations = fallbackConversation && !conversations.some((entry) => entry.id === fallbackConversation.id)
      ? [...conversations, fallbackConversation]
      : conversations;
    if (targetConversations.length === 0) {
      return;
    }
    syncTaskTerminalState({
      session,
      event,
      store: this.taskStore
    });

    for (const conversation of targetConversations) {
      if (!Array.isArray(conversation?.trackedRuntimeSessionIds) || !conversation.trackedRuntimeSessionIds.includes(event.sessionId)) {
        this.conversationStore.trackRuntimeSessions(conversation.id, [event.sessionId]);
      }
      const provider = this.registry.get(conversation.channel, conversation.accountId);
      if (!provider?.sendMessage) {
        continue;
      }

      const formatted = formatAgentRuntimeEventForChannel({ event, session });
      if (!formatted?.text) {
        continue;
      }

      try {
        const outboundText = formatted.fullText || formatted.text || '';
        const result = await provider.sendMessage({
          conversation,
          text: outboundText,
          buttons: formatted.buttons || [],
          session,
          event
        });

        this.deliveryStore.saveOutbound({
          channel: conversation.channel,
          conversationId: conversation.id,
          sessionId: event.sessionId,
          eventSeq: event.seq,
          externalMessageId: result?.messageId || '',
          status: 'sent',
          payload: {
            ...formatted,
            fullText: outboundText
          }
        });

        if (event.type === AGENT_EVENT_TYPE.APPROVAL_REQUEST) {
          this.conversationStore.patch(conversation.id, {
            lastPendingApprovalId: event?.payload?.approvalId || null
          });
        }

        if (event.type === AGENT_EVENT_TYPE.QUESTION) {
          this.conversationStore.patch(conversation.id, {
            lastPendingQuestionId: event?.payload?.questionId || null
          });
        }

        if (event.type === AGENT_EVENT_TYPE.COMPLETED || event.type === AGENT_EVENT_TYPE.FAILED) {
          this.conversationStore.patch(conversation.id, {
            lastPendingApprovalId: null,
            lastPendingQuestionId: null
          });
        }

        const supervisorPatch = buildConversationSupervisorPatch({ conversation, session, event });
        const taskIdFromSession = String(session?.metadata?.taskId || '').trim();
        const synced = syncSupervisorTaskForRuntimeEvent({
          conversation,
          session: taskIdFromSession
            ? {
                ...session,
                metadata: {
                  ...(session?.metadata || {}),
                  taskId: taskIdFromSession
                }
              }
            : session,
          event,
          taskMemory: supervisorPatch?.metadata?.supervisor?.taskMemory || conversation?.metadata?.supervisor?.taskMemory || null,
          store: this.supervisorTaskStore
        });
        this.conversationStore.patch(conversation.id, {
          ...supervisorPatch,
          metadata: {
            ...(supervisorPatch?.metadata || {}),
            supervisor: {
              ...((supervisorPatch?.metadata?.supervisor && typeof supervisorPatch.metadata.supervisor === 'object')
                ? supervisorPatch.metadata.supervisor
                : {}),
              taskMemory: synced.taskMemory,
              brief: synced.brief
            }
          }
        });
      } catch (error) {
        this.deliveryStore.saveOutbound({
          channel: conversation.channel,
          conversationId: conversation.id,
          sessionId: event.sessionId,
          eventSeq: event.seq,
          status: 'failed',
          error: error.message,
          payload: {
            ...formatted,
            fullText: outboundText
          }
        });
      }
    }
  }
}

export const agentChannelOutboundDispatcher = new AgentChannelOutboundDispatcher();

export default agentChannelOutboundDispatcher;
