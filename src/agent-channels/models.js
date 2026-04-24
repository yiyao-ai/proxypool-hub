import crypto from 'crypto';

export const CHANNEL_CONVERSATION_MODE = Object.freeze({
  ASSISTANT: 'assistant',
  AGENT_RUNTIME: 'agent-runtime'
});

export const CONVERSATION_ASSISTANT_CONTROL_MODE = Object.freeze({
  DIRECT_RUNTIME: 'direct-runtime',
  ASSISTANT: 'assistant'
});

export const CHANNEL_DELIVERY_STATUS = Object.freeze({
  SENT: 'sent',
  FAILED: 'failed'
});

export const CHANNEL_PAIRING_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied'
});

function nowIso() {
  return new Date().toISOString();
}

export function createChannelConversation({
  channel,
  accountId = 'default',
  externalConversationId,
  externalUserId,
  externalThreadId = '',
  title = '',
  mode = CHANNEL_CONVERSATION_MODE.ASSISTANT,
  metadata = {}
} = {}) {
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    channel: String(channel || ''),
    accountId: String(accountId || 'default'),
    externalConversationId: String(externalConversationId || ''),
    externalUserId: String(externalUserId || ''),
    externalThreadId: String(externalThreadId || ''),
    mode,
    activeRuntimeSessionId: null,
    trackedRuntimeSessionIds: [],
    activeTaskId: null,
    trackedTaskIds: [],
    lastPendingApprovalId: null,
    lastPendingQuestionId: null,
    title: String(title || `${externalUserId || 'unknown'} / ${channel || 'channel'}`),
    metadata: {
      assistantCore: {
        mode: CONVERSATION_ASSISTANT_CONTROL_MODE.DIRECT_RUNTIME,
        assistantSessionId: null,
        lastRunId: null,
        updatedAt: now
      },
      ...(metadata && typeof metadata === 'object' ? metadata : {})
    },
    createdAt: now,
    updatedAt: now
  };
}

export function createChannelDeliveryRecord({
  channel,
  conversationId,
  sessionId = null,
  direction = 'outbound',
  eventSeq = null,
  externalMessageId = '',
  status = CHANNEL_DELIVERY_STATUS.SENT,
  retryCount = 0,
  error = null,
  payload = {}
} = {}) {
  const now = nowIso();
  return {
    id: crypto.randomUUID(),
    channel: String(channel || ''),
    direction,
    conversationId: String(conversationId || ''),
    sessionId: sessionId ? String(sessionId) : null,
    eventSeq: Number.isFinite(Number(eventSeq)) ? Number(eventSeq) : null,
    externalMessageId: String(externalMessageId || ''),
    status,
    retryCount: Number(retryCount || 0),
    error: error ? String(error) : null,
    payload,
    createdAt: now,
    updatedAt: now
  };
}

export function createPairingRecord({
  channel,
  accountId = 'default',
  externalUserId,
  externalConversationId,
  code = '',
  status = CHANNEL_PAIRING_STATUS.PENDING,
  approvedBy = ''
} = {}) {
  const now = nowIso();
  return {
    channel: String(channel || ''),
    accountId: String(accountId || 'default'),
    externalUserId: String(externalUserId || ''),
    externalConversationId: String(externalConversationId || ''),
    status,
    code: String(code || ''),
    requestedAt: now,
    approvedAt: status === CHANNEL_PAIRING_STATUS.APPROVED ? now : null,
    approvedBy: approvedBy ? String(approvedBy) : ''
  };
}

export function createNormalizedChannelMessage({
  channel,
  accountId = 'default',
  deliveryMode = 'polling',
  externalMessageId = '',
  externalConversationId,
  externalThreadId = '',
  externalUserId,
  externalUserName = '',
  text = '',
  messageType = 'text',
  action = null,
  metadata = {},
  raw = null,
  ts = null
} = {}) {
  return {
    channel: String(channel || ''),
    accountId: String(accountId || 'default'),
    direction: 'inbound',
    deliveryMode: String(deliveryMode || 'polling'),
    externalMessageId: String(externalMessageId || ''),
    externalConversationId: String(externalConversationId || ''),
    externalThreadId: String(externalThreadId || ''),
    externalUserId: String(externalUserId || ''),
    externalUserName: String(externalUserName || ''),
    text: String(text || ''),
    messageType: String(messageType || 'text'),
    action,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    ts: ts || nowIso(),
    raw
  };
}
