import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import { AGENT_EVENT_TYPE } from '../agent-runtime/models.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskTerminalState } from '../agent-core/task-service.js';
import supervisorTaskStore from '../agent-orchestrator/supervisor-task-store.js';
import { buildConversationRuntimeEventPatch } from '../assistant-core/conversation-runtime-binding.js';
import agentChannelConversationStore from './conversation-store.js';
import agentChannelDeliveryStore from './delivery-store.js';
import { formatAgentRuntimeEventForChannel } from './formatter.js';
import agentChannelRegistry from './registry.js';
import { AssistantEventIngestService } from '../assistant-core/event-ingest-service.js';
import { AssistantObservationService } from '../assistant-core/observation-service.js';
import {
  arbitrateConversationDelivery
} from './conversation-delivery-arbiter.js';
import agentChannelDeliverySender, { AgentChannelDeliverySender } from './delivery-sender.js';

const NOTIFIABLE_EVENT_TYPES = new Set([
  AGENT_EVENT_TYPE.STARTED,
  AGENT_EVENT_TYPE.APPROVAL_REQUEST,
  AGENT_EVENT_TYPE.QUESTION,
  AGENT_EVENT_TYPE.APPROVAL_RESOLVED,
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
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore,
    deliverySender = agentChannelDeliverySender,
    eventIngestService = null
  } = {}) {
    this.runtimeSessionManager = runtimeSessionManager;
    this.conversationStore = conversationStore;
    this.deliveryStore = deliveryStore;
    this.registry = registry;
    this.taskStore = taskStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
    this.eventIngestService = eventIngestService instanceof AssistantEventIngestService
      ? eventIngestService
      : new AssistantEventIngestService({
          observationService: new AssistantObservationService({
            conversationStore: this.conversationStore,
            runtimeSessionManager: this.runtimeSessionManager,
            taskStore: this.taskStore,
            deliveryStore: this.deliveryStore
          })
        });
    this.deliverySender = deliverySender instanceof AgentChannelDeliverySender
      ? deliverySender
      : new AgentChannelDeliverySender({
          registry: this.registry,
          deliveryStore: this.deliveryStore
        });
    this.deliverySender.setRegistry?.(this.registry);
    this.deliverySender.setDeliveryStore?.(this.deliveryStore);
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
      const formatted = formatAgentRuntimeEventForChannel({ event, session });
      try {
        const latestConversation = this.conversationStore.get(conversation.id) || conversation;
        const decision = arbitrateConversationDelivery({
          conversation: latestConversation,
          source: {
            type: 'runtime_event'
          },
          payload: {
            event,
            session,
            formatted
          }
        });
        const basePayload = {
          ...(formatted || {}),
          sourceType: 'runtime_event',
          eventType: event?.type || '',
          result: event?.payload?.result || '',
          summary: event?.payload?.summary || session?.summary || ''
        };
        if (formatted?.text && decision.action === 'send_now') {
          await this.deliverySender.send({
            conversation: latestConversation,
            channel: latestConversation.channel,
            sessionId: event.sessionId,
            eventSeq: event.seq,
            payload: {
              ...basePayload
            },
            message: {
              text: formatted.fullText || formatted.text || '',
              buttons: formatted.buttons || [],
              session,
              event
            }
          });
        } else {
          this.deliverySender.suppress({
            conversation: latestConversation,
            channel: latestConversation.channel,
            sessionId: event.sessionId,
            eventSeq: event.seq,
            payload: {
              ...basePayload
            },
            reason: decision.reason
          });
        }

        this.conversationStore.patch(conversation.id, buildConversationRuntimeEventPatch({
          conversation,
          session,
          event,
          supervisorTaskStore: this.supervisorTaskStore
        }));
        const postPatchConversation = this.conversationStore.get(conversation.id) || latestConversation;
        const assistantNotification = await this.eventIngestService?.ingestRuntimeEvent?.({
          conversation: postPatchConversation,
          session,
          event
        }) || null;
        if (!formatted?.text && decision.action === 'send_now') {
          this.deliverySender.suppress({
            conversation: postPatchConversation,
            channel: postPatchConversation.channel,
            sessionId: event.sessionId,
            eventSeq: event.seq,
            payload: {
              ...basePayload
            },
            reason: 'runtime_event_missing_formatted_text'
          });
        }
        if (decision.action === 'forward_to_assistant') {
          if (assistantNotification?.notified && assistantNotification.message) {
            await this.deliverySender.send({
              conversation: postPatchConversation,
              channel: postPatchConversation.channel,
              sessionId: event.sessionId,
              eventSeq: event.seq,
              payload: {
                text: assistantNotification.message,
                assistantRunId: assistantNotification?.assistantRun?.id || '',
                kind: 'assistant-run-result',
                sourceType: 'assistant_run_result',
                eventType: event?.type || ''
              },
              message: {
                text: assistantNotification.message,
                buttons: formatted?.buttons || [],
                session,
                event
              }
            });
          }
        }
      } catch (error) {
        this.deliveryStore.saveOutbound({
          channel: conversation.channel,
          conversationId: conversation.id,
          sessionId: event.sessionId,
          eventSeq: event.seq,
          status: 'failed',
          error: error.message,
          payload: {
            ...(formatted || {}),
            fullText: formatted?.fullText || formatted?.text || ''
          }
        });
      }
    }
  }
}

export const agentChannelOutboundDispatcher = new AgentChannelOutboundDispatcher();

export default agentChannelOutboundDispatcher;
