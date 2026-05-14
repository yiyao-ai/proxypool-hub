import agentChannelRegistry from './registry.js';
import agentChannelDeliveryStore from './delivery-store.js';
import stateCoordinator from '../assistant-core/domain/state-coordinator.js';

export class AgentChannelDeliverySender {
  constructor({
    registry = agentChannelRegistry,
    deliveryStore = agentChannelDeliveryStore,
    stateCoordinator: stateCoordinatorArg = stateCoordinator
  } = {}) {
    this.registry = registry;
    this.deliveryStore = deliveryStore;
    this.stateCoordinator = stateCoordinatorArg;
  }

  setRegistry(registry) {
    this.registry = registry || this.registry;
  }

  setDeliveryStore(deliveryStore) {
    this.deliveryStore = deliveryStore || this.deliveryStore;
  }

  setStateCoordinator(stateCoordinatorArg) {
    this.stateCoordinator = stateCoordinatorArg || this.stateCoordinator;
  }

  async send({
    conversation,
    channel,
    sessionId = null,
    eventSeq = null,
    payload = {},
    message = {}
  } = {}) {
    const provider = this.registry.get(conversation?.channel || channel, conversation?.accountId);
    if (!provider?.sendMessage) {
      return null;
    }

    const outboundText = String(message?.text || payload?.fullText || payload?.text || '').trim();
    if (!outboundText) {
      return null;
    }

    const result = await provider.sendMessage({
      conversation,
      text: outboundText,
      buttons: Array.isArray(message?.buttons) ? message.buttons : [],
      session: message?.session || null,
      event: message?.event || null
    });

    const delivery = this.deliveryStore.saveOutbound({
      channel: conversation?.channel || channel,
      conversationId: conversation?.id,
      sessionId,
      eventSeq,
      externalMessageId: result?.messageId || '',
      status: 'sent',
      payload: {
        ...payload,
        fullText: outboundText
      }
    });
    this.stateCoordinator?.recordDeliveryEpisode?.({
      delivery,
      conversationId: conversation?.id,
      runtimeSessionId: sessionId,
      metadata: {
        source: 'agent_channel_delivery_sender'
      }
    });

    return result;
  }

  suppress({
    conversation,
    channel,
    sessionId = null,
    eventSeq = null,
    payload = {},
    reason = ''
  } = {}) {
    const delivery = this.deliveryStore.saveOutbound({
      channel: conversation?.channel || channel,
      conversationId: conversation?.id,
      sessionId,
      eventSeq,
      status: 'suppressed',
      payload: {
        ...payload,
        suppressionReason: String(reason || '').trim()
      }
    });
    this.stateCoordinator?.recordDeliveryEpisode?.({
      delivery,
      conversationId: conversation?.id,
      runtimeSessionId: sessionId,
      metadata: {
        source: 'agent_channel_delivery_sender'
      }
    });
    return delivery;
  }
}

export const agentChannelDeliverySender = new AgentChannelDeliverySender();

export default agentChannelDeliverySender;
