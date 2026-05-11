export function getAssistantControlMode(conversation = null) {
  return String(
    conversation?.metadata?.assistantCore?.controlMode
    || conversation?.metadata?.assistantCore?.mode
    || 'direct-runtime'
  ).trim() || 'direct-runtime';
}

export function isAssistantOwnedConversation(conversation = null) {
  return getAssistantControlMode(conversation) === 'assistant';
}

export default {
  getAssistantControlMode,
  isAssistantOwnedConversation
};
