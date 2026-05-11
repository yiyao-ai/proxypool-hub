import {
  CONVERSATION_ASSISTANT_CONTROL_MODE,
  CONVERSATION_DELIVERY_OWNERSHIP,
  resolveDeliveryOwnership
} from './models.js';

function normalizeSourceType(source = {}) {
  return String(source?.type || '').trim();
}

function getConversationAssistantState(conversation = null) {
  return conversation?.metadata?.assistantCore || {};
}

export function getConversationControlMode(conversation = null) {
  const assistantState = getConversationAssistantState(conversation);
  const explicit = String(assistantState.controlMode || assistantState.mode || '').trim();
  if (explicit) {
    return explicit;
  }
  return CONVERSATION_ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME;
}

export function getConversationDeliveryOwnership(conversation = null) {
  const assistantState = getConversationAssistantState(conversation);
  const explicit = String(assistantState.deliveryOwnership || '').trim();
  if (explicit) {
    return explicit;
  }
  return resolveDeliveryOwnership(getConversationControlMode(conversation));
}

export function buildAssistantCoreDeliveryState(current = {}, patch = {}) {
  const controlMode = String(
    patch.controlMode
    || patch.mode
    || current.controlMode
    || current.mode
    || CONVERSATION_ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME
  ).trim();
  return {
    ...current,
    ...patch,
    mode: controlMode,
    controlMode,
    deliveryOwnership: resolveDeliveryOwnership(controlMode)
  };
}

export function arbitrateConversationDelivery({
  conversation = null,
  source = {},
  payload = {}
} = {}) {
  const controlMode = getConversationControlMode(conversation);
  const deliveryOwnership = getConversationDeliveryOwnership(conversation);
  const sourceType = normalizeSourceType(source);

  if (deliveryOwnership === CONVERSATION_DELIVERY_OWNERSHIP.RUNTIME) {
    return {
      action: 'send_now',
      reason: 'runtime_owned_conversation',
      controlMode,
      deliveryOwnership,
      sourceType
    };
  }

  if (deliveryOwnership === CONVERSATION_DELIVERY_OWNERSHIP.ASSISTANT) {
    if (sourceType === 'assistant_run_result') {
      return {
        action: 'send_now',
        reason: 'assistant_result_in_assistant_mode',
        controlMode,
        deliveryOwnership,
        sourceType
      };
    }

    if (sourceType === 'runtime_event') {
      return {
        action: 'forward_to_assistant',
        reason: 'runtime_events_are_facts_in_assistant_mode',
        controlMode,
        deliveryOwnership,
        sourceType,
        eventType: String(payload?.event?.type || '').trim()
      };
    }
  }

  return {
    action: 'store_only',
    reason: 'no_delivery_rule_matched',
    controlMode,
    deliveryOwnership,
    sourceType
  };
}

export default {
  arbitrateConversationDelivery,
  buildAssistantCoreDeliveryState,
  getConversationControlMode,
  getConversationDeliveryOwnership
};
