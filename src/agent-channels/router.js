import agentChannelConversationStore from './conversation-store.js';
import agentChannelDeliveryStore from './delivery-store.js';
import agentChannelPairingStore from './pairing-store.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskFromRuntimeResult } from '../agent-core/task-service.js';
import AssistantModeService from '../assistant-core/mode-service.js';
import { AssistantObservationService } from '../assistant-core/observation-service.js';
import { AssistantTaskViewService } from '../assistant-core/task-view-service.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentChannelRegistry from './registry.js';
import assistantRunStore from '../assistant-core/run-store.js';
import { getAssistantControlMode } from '../assistant-core/assistant-state.js';
import assistantPendingActionStore from '../assistant-core/pending-action-store.js';
import {
  bindConversationToRuntimeStart,
  buildPendingResolutionPatch
} from '../assistant-core/conversation-runtime-binding.js';
import {
  arbitrateConversationDelivery,
  buildAssistantCoreDeliveryState
} from './conversation-delivery-arbiter.js';
import agentChannelDeliverySender, { AgentChannelDeliverySender } from './delivery-sender.js';

function buildInboundKey(message) {
  return [
    message?.channel || '',
    message?.accountId || 'default',
    message?.externalConversationId || '',
    message?.externalMessageId || '',
    message?.externalUserId || ''
  ].join(':');
}

function isAffirmativeConfirmation(text = '') {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return [
    /^(确认|同意|可以|查吧|行|好|继续|批准)\s*[.!。！]*$/i,
    /^(confirm|approve|yes|ok|okay|go ahead|continue)\s*[.!]*$/i
  ].some((pattern) => pattern.test(normalized));
}

export class AgentChannelRouter {
  constructor({
    conversationStore = agentChannelConversationStore,
    deliveryStore = agentChannelDeliveryStore,
    pairingStore = agentChannelPairingStore,
    registry = agentChannelRegistry,
    messageService = agentOrchestratorMessageService,
    taskStore = agentTaskStore,
    assistantModeService = null,
    deliverySender = agentChannelDeliverySender
  } = {}) {
    this.conversationStore = conversationStore;
    this.deliveryStore = deliveryStore;
    this.pairingStore = pairingStore;
    this.registry = registry;
    this.messageService = messageService;
    this.taskStore = taskStore;
    this.deliverySender = deliverySender instanceof AgentChannelDeliverySender
      ? deliverySender
      : new AgentChannelDeliverySender({
          registry: this.registry,
          deliveryStore: this.deliveryStore
        });
    this.deliverySender.setRegistry?.(this.registry);
    this.deliverySender.setDeliveryStore?.(this.deliveryStore);
    this.supervisorTaskStore = this.messageService?.supervisorTaskStore;
    this.assistantModeService = assistantModeService || new AssistantModeService({
      conversationStore: this.conversationStore,
      messageService: this.messageService,
      observationService: new AssistantObservationService({
        conversationStore: this.conversationStore,
        runtimeSessionManager: this.messageService?.runtimeSessionManager || agentRuntimeSessionManager,
        taskStore: this.taskStore,
        deliveryStore: this.deliveryStore
      }),
      taskViewService: new AssistantTaskViewService({
        conversationStore: this.conversationStore,
        runtimeSessionManager: this.messageService?.runtimeSessionManager || agentRuntimeSessionManager,
        taskStore: this.taskStore,
        deliveryStore: this.deliveryStore,
        assistantRunStore
      })
    });
  }

  async routeInboundMessage(message, options = {}) {
    const inboundKey = buildInboundKey(message);
    if (this.deliveryStore.isInboundProcessed(inboundKey)) {
      return {
        type: 'duplicate',
        message: 'Inbound message already processed'
      };
    }
    this.deliveryStore.markInboundProcessed(inboundKey);

    const conversation = this.conversationStore.findOrCreateByExternal({
      channel: message.channel,
      accountId: message.accountId,
      externalConversationId: message.externalConversationId,
      externalUserId: message.externalUserId,
      externalThreadId: message.externalThreadId,
      title: message.externalUserName
        ? `${message.externalUserName} / ${message.channel}`
        : `${message.externalUserId} / ${message.channel}`,
      metadata: {
        assistantCore: buildAssistantCoreDeliveryState(
          this.conversationStore.findByExternal?.(
            message.channel,
            message.accountId,
            message.externalConversationId,
            message.externalUserId,
            message.externalThreadId
          )?.metadata?.assistantCore || {},
          {}
        ),
        lastMessageType: message.messageType || 'text',
        channelContext: {
          ...((message.metadata && typeof message.metadata === 'object') ? message.metadata : {})
        }
      }
    });

    const requirePairing = options.requirePairing === true;

    if (requirePairing && !this.pairingStore.isApproved(
      message.channel,
      message.accountId,
      message.externalUserId,
      message.externalConversationId
    )) {
      const pairing = this.pairingStore.createRequest({
        channel: message.channel,
        accountId: message.accountId,
        externalUserId: message.externalUserId,
        externalConversationId: message.externalConversationId
      });

      return {
        type: 'pairing_required',
        conversation,
        pairing
      };
    }

    const previousSessionId = conversation.activeRuntimeSessionId || null;
    const latestAssistantPendingAction = conversation?.id
      ? assistantPendingActionStore.findLatestByConversationId(conversation.id)
      : null;
    if (latestAssistantPendingAction && isAffirmativeConfirmation(message.text)) {
      const consumedAction = assistantPendingActionStore.consume(latestAssistantPendingAction.confirmToken);
      if (consumedAction) {
        const routeResult = await this.routeInboundMessage({
          ...message,
          text: String(consumedAction.input?.task || consumedAction.input?.message || '').trim(),
          externalMessageId: `${message.externalMessageId || 'confirm'}:assistant-pending-action`
        }, {
          ...options,
          defaultRuntimeProvider: String(consumedAction.input?.provider || options.defaultRuntimeProvider || 'codex').trim() || 'codex',
          cwd: String(consumedAction.input?.cwd || options.cwd || '').trim(),
          model: String(consumedAction.input?.model || options.model || '').trim()
        });
        return {
          ...routeResult,
          pendingAction: null
        };
      }
    }
    const assistantResult = await this.assistantModeService.maybeHandleMessage({
      conversation,
      text: message.text,
      defaultRuntimeProvider: options.defaultRuntimeProvider || 'codex',
      cwd: options.cwd,
      model: options.model,
      executionMode: 'async',
      onBackgroundResult: async (backgroundResult) => {
        const outboundText = String(backgroundResult?.message || '').trim();
        const relatedRuntimeSessionIds = Array.isArray(backgroundResult?.assistantRun?.relatedRuntimeSessionIds)
          ? backgroundResult.assistantRun.relatedRuntimeSessionIds.filter(Boolean)
          : [];
        const primaryRuntimeSessionId = relatedRuntimeSessionIds[0] || null;
        if (relatedRuntimeSessionIds.length > 0) {
          this.conversationStore.trackRuntimeSessions(conversation.id, relatedRuntimeSessionIds);
        }
        if (primaryRuntimeSessionId) {
          const runtimeSession = this.messageService.getRuntimeSession(primaryRuntimeSessionId);
          const latestConversation = this.conversationStore.get(conversation.id) || conversation;
          bindConversationToRuntimeStart({
            conversationStore: this.conversationStore,
            messageService: this.messageService,
            supervisorTaskStore: this.supervisorTaskStore,
            conversation: latestConversation,
            session: runtimeSession,
            supervisorContext: {},
            userInput: message.text,
            originKind: 'assistant',
            activate: true,
            assistantMetadata: latestConversation.metadata?.assistantCore || {}
          });
        }
        if (!outboundText) {
          return;
        }
        const latestConversation = backgroundResult.conversation || this.conversationStore.get(conversation.id);
        const decision = arbitrateConversationDelivery({
          conversation: latestConversation,
          source: {
            type: 'assistant_run_result'
          },
          payload: {
            assistantRun: backgroundResult?.assistantRun || null
          }
        });
        if (decision.action === 'send_now') {
          await this.deliverySender.send({
            conversation: latestConversation,
            channel: message.channel,
            sessionId: primaryRuntimeSessionId,
            payload: {
              text: outboundText,
              assistantRunId: backgroundResult?.assistantRun?.id || '',
              kind: 'assistant-run-result',
              sourceType: 'assistant_run_result'
            },
            message: {
              text: outboundText
            }
          });
          return;
        }
        this.deliverySender.suppress({
          conversation: latestConversation,
          channel: message.channel,
          sessionId: primaryRuntimeSessionId,
          payload: {
            text: outboundText,
            assistantRunId: backgroundResult?.assistantRun?.id || '',
            kind: 'assistant-run-result',
            sourceType: 'assistant_run_result'
          },
          reason: decision.reason
        });
      }
    });
    if (assistantResult) {
      this.deliveryStore.saveInbound({
        channel: message.channel,
        conversationId: conversation.id,
        sessionId: previousSessionId,
        externalMessageId: message.externalMessageId || '',
        status: 'sent',
        payload: {
          text: message.text || '',
          messageType: message.messageType || 'text',
          externalUserId: message.externalUserId || '',
          externalUserName: message.externalUserName || '',
          action: message.action || null,
          ts: message.ts || null
        }
      });

      return {
        ...assistantResult,
        conversation: assistantResult.conversation || this.conversationStore.get(conversation.id)
      };
    }

    const result = await this.messageService.routeUserMessage({
      message,
      conversation,
      defaultRuntimeProvider: options.defaultRuntimeProvider || 'codex',
      cwd: options.cwd,
      model: options.model,
      metadata: {
        assistantMode: getAssistantControlMode(conversation),
        source: {
          kind: 'channel',
          channel: message.channel,
          accountId: message.accountId,
          conversationId: conversation.id
        },
        conversationId: conversation.id
      }
    });

    const inboundSessionId = result?.session?.id || previousSessionId || null;
    this.deliveryStore.saveInbound({
      channel: message.channel,
      conversationId: conversation.id,
      sessionId: inboundSessionId,
      externalMessageId: message.externalMessageId || '',
      status: 'sent',
      payload: {
        text: message.text || '',
        messageType: message.messageType || 'text',
        externalUserId: message.externalUserId || '',
        externalUserName: message.externalUserName || '',
        action: message.action || null,
        ts: message.ts || null
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
        userInput: message.text,
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
      conversation: this.conversationStore.get(conversation.id)
    };

    if (result?.session?.id && (result.type === 'runtime_started' || result.type === 'runtime_continued')) {
      syncTaskFromRuntimeResult({
        conversation: response.conversation,
        result: response,
        userInput: message.text,
        store: this.taskStore
      });
    }

    return response;
  }
}

export const agentChannelRouter = new AgentChannelRouter();

export default agentChannelRouter;
