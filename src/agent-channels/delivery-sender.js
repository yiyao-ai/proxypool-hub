import agentChannelRegistry from './registry.js';
import agentChannelDeliveryStore from './delivery-store.js';

export class AgentChannelDeliverySender {
  constructor({
    registry = agentChannelRegistry,
    deliveryStore = agentChannelDeliveryStore
  } = {}) {
    this.registry = registry;
    this.deliveryStore = deliveryStore;
  }

  setRegistry(registry) {
    this.registry = registry || this.registry;
  }

  setDeliveryStore(deliveryStore) {
    this.deliveryStore = deliveryStore || this.deliveryStore;
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

    this.deliveryStore.saveOutbound({
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
    return this.deliveryStore.saveOutbound({
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
  }
}

export const agentChannelDeliverySender = new AgentChannelDeliverySender();

export default agentChannelDeliverySender;
