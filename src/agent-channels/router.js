import agentChannelConversationStore from './conversation-store.js';
import agentChannelDeliveryStore from './delivery-store.js';
import agentChannelPairingStore from './pairing-store.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import agentTaskStore from '../agent-core/task-store.js';
import { syncTaskFromRuntimeResult } from '../agent-core/task-service.js';
import { buildSupervisorBrief } from '../agent-orchestrator/supervisor-brief.js';
import { CHANNEL_CONVERSATION_MODE } from './models.js';
import AssistantModeService from '../assistant-core/mode-service.js';
import { AssistantObservationService } from '../assistant-core/observation-service.js';
import { AssistantTaskViewService } from '../assistant-core/task-view-service.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import agentChannelRegistry from './registry.js';
import assistantRunStore from '../assistant-core/run-store.js';

function buildInboundKey(message) {
  return [
    message?.channel || '',
    message?.accountId || 'default',
    message?.externalConversationId || '',
    message?.externalMessageId || '',
    message?.externalUserId || ''
  ].join(':');
}

export class AgentChannelRouter {
  constructor({
    conversationStore = agentChannelConversationStore,
    deliveryStore = agentChannelDeliveryStore,
    pairingStore = agentChannelPairingStore,
    registry = agentChannelRegistry,
    messageService = agentOrchestratorMessageService,
    taskStore = agentTaskStore,
    assistantModeService = null
  } = {}) {
    this.conversationStore = conversationStore;
    this.deliveryStore = deliveryStore;
    this.pairingStore = pairingStore;
    this.registry = registry;
    this.messageService = messageService;
    this.taskStore = taskStore;
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
    const assistantResult = await this.assistantModeService.maybeHandleMessage({
      conversation,
      text: message.text,
      defaultRuntimeProvider: options.defaultRuntimeProvider || 'codex',
      cwd: options.cwd,
      model: options.model,
      executionMode: 'async',
      onBackgroundResult: async (backgroundResult) => {
        const provider = this.registry.get(message.channel, message.accountId);
        const outboundText = String(backgroundResult?.message || '').trim();
        const relatedRuntimeSessionId = backgroundResult?.assistantRun?.relatedRuntimeSessionIds?.[0] || null;
        if (relatedRuntimeSessionId) {
          const runtimeSession = this.messageService.getRuntimeSession(relatedRuntimeSessionId);
          const pendingApproval = this.messageService.listPendingApprovals(relatedRuntimeSessionId)[0] || null;
          const pendingQuestion = this.messageService.listPendingQuestions(relatedRuntimeSessionId)
            .find((entry) => entry.status === 'pending') || null;
          const latestConversation = this.conversationStore.get(conversation.id) || conversation;
          this.conversationStore.bindRuntimeSession(conversation.id, relatedRuntimeSessionId, {
            mode: CHANNEL_CONVERSATION_MODE.AGENT_RUNTIME,
            lastPendingApprovalId: pendingApproval?.approvalId || null,
            lastPendingQuestionId: pendingQuestion?.questionId || null,
            metadata: {
              ...(latestConversation.metadata || {}),
              assistantCore: {
                ...((latestConversation.metadata?.assistantCore && typeof latestConversation.metadata.assistantCore === 'object')
                  ? latestConversation.metadata.assistantCore
                  : {})
              },
              supervisor: {
                ...((latestConversation.metadata?.supervisor && typeof latestConversation.metadata.supervisor === 'object')
                  ? latestConversation.metadata.supervisor
                  : {}),
                brief: buildSupervisorBrief({
                  taskMemory: latestConversation.metadata?.supervisor?.taskMemory || null,
                  session: runtimeSession
                })
              }
            }
          });
        }
        if (!provider?.sendMessage || !outboundText) {
          return;
        }

        const result = await provider.sendMessage({
          conversation: backgroundResult.conversation || this.conversationStore.get(conversation.id),
          text: outboundText
        });

        this.deliveryStore.saveOutbound({
          channel: message.channel,
          conversationId: conversation.id,
          sessionId: relatedRuntimeSessionId,
          externalMessageId: result?.messageId || '',
          status: 'sent',
          payload: {
            text: outboundText,
            assistantRunId: backgroundResult?.assistantRun?.id || '',
            kind: 'assistant-run-result'
          }
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
      const pendingApproval = this.messageService.listPendingApprovals(result.session.id)[0] || null;
      const pendingQuestion = this.messageService.listPendingQuestions(result.session.id)
        .find((entry) => entry.status === 'pending') || null;
      const taskMemory = {
        ...((conversation.metadata?.supervisor?.taskMemory && typeof conversation.metadata.supervisor.taskMemory === 'object')
          ? conversation.metadata.supervisor.taskMemory
          : {}),
        current: {
          sessionId: result.session.id,
          provider: result.session.provider,
          title: supervisorContext.title || result.session.title || message.text || '',
          status: pendingQuestion
            ? 'waiting_user'
            : (pendingApproval ? 'waiting_approval' : (result.session.status || 'starting')),
          startedAt: result.session.createdAt || new Date().toISOString(),
          lastUpdateAt: result.session.updatedAt || new Date().toISOString(),
          summary: String(supervisorContext.summary || '').trim(),
          result: '',
          originKind: String(supervisorContext.kind || '').trim() || 'direct',
          sourceTitle: String(supervisorContext.sourceTitle || '').trim(),
          sourceProvider: String(supervisorContext.sourceProvider || '').trim(),
          sourceStatus: String(supervisorContext.sourceStatus || '').trim(),
          pendingApprovalTitle: String(pendingApproval?.title || '').trim(),
          pendingQuestion: String(pendingQuestion?.text || '').trim()
        }
      };
      this.conversationStore.bindRuntimeSession(conversation.id, result.session.id, {
        mode: CHANNEL_CONVERSATION_MODE.AGENT_RUNTIME,
        lastPendingApprovalId: pendingApproval?.approvalId || null,
        lastPendingQuestionId: pendingQuestion?.questionId || null,
        metadata: {
          ...(conversation.metadata || {}),
          supervisor: {
            ...((conversation.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
              ? conversation.metadata.supervisor
              : {}),
            taskMemory,
            brief: buildSupervisorBrief({
              taskMemory,
              session: result.session
            })
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
