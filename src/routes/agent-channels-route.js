import agentChannelConversationStore from '../agent-channels/conversation-store.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import agentChannelManager from '../agent-channels/manager.js';
import agentChannelPairingStore from '../agent-channels/pairing-store.js';
import agentChannelRegistry from '../agent-channels/registry.js';
import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';
import { getServerSettings } from '../server-settings.js';

function parseLimit(value, fallback = 50) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function summarizeDelivery(delivery) {
  if (!delivery) {
    return {
      lastMessageAt: null,
      lastMessagePreview: '',
      lastMessageDirection: null
    };
  }

  const text = String(delivery?.payload?.fullText || delivery?.payload?.text || delivery?.payload?.summary || '').trim();
  return {
    lastMessageAt: delivery.updatedAt || delivery.createdAt || null,
    lastMessagePreview: text.slice(0, 160),
    lastMessageDirection: delivery.direction || null
  };
}

function summarizeSessionState(session, conversation) {
  if (conversation?.pairingStatus === 'pending') {
    return 'pending';
  }
  if (!session) {
    return 'idle';
  }
  if (session.status === 'waiting_approval') {
    return 'waiting_approval';
  }
  if (session.status === 'waiting_user') {
    return 'waiting_user';
  }
  if (session.status === 'running' || session.status === 'starting') {
    return 'active';
  }
  if (session.status === 'failed' || session.status === 'cancelled') {
    return 'failed';
  }
  return 'completed';
}

function summarizeLatestTurn(runtimeSessionManager, sessionId) {
  const [latestTurn] = runtimeSessionManager.listTurns(String(sessionId || ''), { limit: 1 });
  if (!latestTurn?.id) {
    return {
      latestTurnId: '',
      latestTurnStatus: '',
      latestTurnSummary: '',
      latestTurnStats: null
    };
  }
  return {
    latestTurnId: latestTurn.id,
    latestTurnStatus: latestTurn.status || '',
    latestTurnSummary: latestTurn.summary || '',
    latestTurnStats: latestTurn.stats || null
  };
}

function decorateConversation(conversation, { includeDeliveries = false } = {}) {
  if (!conversation) return null;
  const pairing = agentChannelPairingStore.get(
    conversation.channel,
    conversation.accountId,
    conversation.externalUserId,
    conversation.externalConversationId
  );
  const deliveries = agentChannelDeliveryStore.listByConversation(conversation.id, {
    limit: includeDeliveries ? 200 : 1
  });
  return {
    ...conversation,
    pairingStatus: pairing?.status || null,
    pairingCode: pairing?.code || '',
    pairingApprovedAt: pairing?.approvedAt || null,
    ...summarizeDelivery(deliveries[deliveries.length - 1] || null),
    deliveries: includeDeliveries ? deliveries : undefined,
    supervisor: conversation?.metadata?.supervisor || null
  };
}

export function buildAgentChannelSessionRecords({
  limit = 80,
  runtimeSessionManager = agentRuntimeSessionManager,
  deliveryStore = agentChannelDeliveryStore,
  conversationStore = agentChannelConversationStore,
  pairingStore = agentChannelPairingStore
} = {}) {
  const sessions = runtimeSessionManager.listSessions({ limit: Math.max(limit * 4, 200) });
  const deliveries = deliveryStore.listAll({ limit: 5000 });
  const conversationById = new Map(
    conversationStore.list({ limit: 5000 }).map((conversation) => [conversation.id, conversation])
  );
  const deliveriesBySessionId = new Map();

  for (const delivery of deliveries) {
    if (!delivery?.sessionId) continue;
    const bucket = deliveriesBySessionId.get(delivery.sessionId) || [];
    bucket.push(delivery);
    deliveriesBySessionId.set(delivery.sessionId, bucket);
  }

  const records = sessions
    .filter((session) => session?.metadata?.source?.kind === 'channel')
    .map((session) => {
      const sessionDeliveries = deliveriesBySessionId.get(session.id) || [];
      const lastDelivery = sessionDeliveries[sessionDeliveries.length - 1] || null;
      const conversation = sessionDeliveries.length > 0
        ? conversationById.get(sessionDeliveries[0].conversationId) || null
        : null;
      const pairing = conversation
        ? pairingStore.get(
          conversation.channel,
          conversation.accountId,
          conversation.externalUserId,
          conversation.externalConversationId
        )
        : null;
      const decoratedConversation = conversation
        ? {
          ...conversation,
          pairingStatus: pairing?.status || null,
          pairingCode: pairing?.code || '',
          pairingApprovedAt: pairing?.approvedAt || null
        }
        : null;

      return {
        id: session.id,
        title: session.title || decoratedConversation?.title || session.input || `Session ${session.id.slice(0, 8)}`,
        provider: session.provider,
        model: session.model || '',
        cwd: session.cwd || '',
        status: session.status,
        state: summarizeSessionState(session, decoratedConversation),
        turnCount: Number(session.turnCount || 0),
        summary: String(session.summary || ''),
        ...summarizeLatestTurn(runtimeSessionManager, session.id),
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        channel: decoratedConversation?.channel || session?.metadata?.source?.channel || '',
        conversationId: decoratedConversation?.id || '',
        externalConversationId: decoratedConversation?.externalConversationId || '',
        externalUserId: decoratedConversation?.externalUserId || '',
        externalThreadId: decoratedConversation?.externalThreadId || '',
        pairingStatus: decoratedConversation?.pairingStatus || null,
        ...summarizeDelivery(lastDelivery),
        conversationTitle: decoratedConversation?.title || '',
        deliveriesCount: sessionDeliveries.length
      };
    })
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
    .slice(0, Math.max(1, limit));

  return records;
}

export function buildAgentChannelSessionRecordDetail(sessionId, {
  runtimeSessionManager = agentRuntimeSessionManager,
  deliveryStore = agentChannelDeliveryStore,
  conversationStore = agentChannelConversationStore,
  pairingStore = agentChannelPairingStore
} = {}) {
  const session = runtimeSessionManager.getSession(String(sessionId || ''));
  if (!session) {
    return null;
  }

  const deliveries = deliveryStore.listBySession(session.id, { limit: 500 });
  const conversation = deliveries.length > 0
    ? conversationStore.get(deliveries[0].conversationId)
    : null;
  const pairing = conversation
    ? pairingStore.get(
      conversation.channel,
      conversation.accountId,
      conversation.externalUserId,
      conversation.externalConversationId
    )
    : null;

  return {
    session: {
      ...session,
      ...summarizeLatestTurn(runtimeSessionManager, session.id),
      state: summarizeSessionState(session, {
        pairingStatus: pairing?.status || null
      })
    },
    conversation: conversation
      ? {
        ...conversation,
        pairingStatus: pairing?.status || null,
        pairingCode: pairing?.code || '',
        pairingApprovedAt: pairing?.approvedAt || null
      }
      : null,
    deliveries
  };
}

export function handleListAgentChannelProviders(_req, res) {
  res.json({
    success: true,
    providers: agentChannelManager.getProviderStatuses()
  });
}

export function handleGetAgentChannelCatalog(_req, res) {
  res.json({
    success: true,
    providers: agentChannelRegistry.list()
  });
}

export function handleGetAgentChannelSettings(_req, res) {
  res.json({
    success: true,
    channels: getServerSettings().channels || {}
  });
}

export async function handleCreateAgentChannelInstance(req, res) {
  try {
    const channelId = String(req.params.channel || '');
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'channel is required' });
    }

    const instance = agentChannelManager.createChannelInstance(channelId, req.body || {});
    await agentChannelManager.refresh();

    return res.json({
      success: true,
      instance
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
}

export async function handleUpdateAgentChannelSettings(req, res) {
  try {
    const channelId = String(req.params.channel || '');
    const instanceId = String(req.params.instanceId || 'default');
    if (!channelId) {
      return res.status(400).json({ success: false, error: 'channel is required' });
    }

    const patch = req.body || {};
    const instance = agentChannelManager.updateChannelInstanceSettings(channelId, instanceId, patch);
    await agentChannelManager.refresh();

    return res.json({
      success: true,
      instance
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
}

export async function handleDeleteAgentChannelInstance(req, res) {
  try {
    const channelId = String(req.params.channel || '');
    const instanceId = String(req.params.instanceId || '');
    if (!channelId || !instanceId) {
      return res.status(400).json({ success: false, error: 'channel and instanceId are required' });
    }

    const channel = agentChannelManager.removeChannelInstance(channelId, instanceId);
    await agentChannelManager.refresh();

    return res.json({
      success: true,
      channel
    });
  } catch (error) {
    return res.status(400).json({ success: false, error: error.message });
  }
}

export async function handleRefreshAgentChannels(_req, res) {
  const providers = await agentChannelManager.refresh();
  res.json({
    success: true,
    providers
  });
}

export async function handleFeishuChannelWebhook(req, res) {
  try {
    const settings = getServerSettings().channels?.feishu || {};
    const requestedInstanceId = String(req.query.instanceId || req.headers['x-cligate-channel-instance'] || 'default');
    const provider = agentChannelManager.getInstance('feishu', requestedInstanceId);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'feishu provider instance unavailable' });
    }

    const instance = Array.isArray(settings.instances)
      ? settings.instances.find((entry) => String(entry?.id || 'default') === requestedInstanceId)
      : null;
    provider.settings = instance || provider.settings || {};
    provider.router = agentChannelManager.router;

    const result = await provider.handleWebhook(req.body || {}, {
      cwd: provider.settings?.cwd || ''
    });

    return res.status(result?.status || 200).json(result?.body || { success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export async function handleDingTalkChannelWebhook(req, res) {
  try {
    const settings = getServerSettings().channels?.dingtalk || {};
    const requestedInstanceId = String(req.query.instanceId || req.headers['x-cligate-channel-instance'] || 'default');
    const provider = agentChannelManager.getInstance('dingtalk', requestedInstanceId);
    if (!provider) {
      return res.status(404).json({ success: false, error: 'dingtalk provider instance unavailable' });
    }

    const instance = Array.isArray(settings.instances)
      ? settings.instances.find((entry) => String(entry?.id || 'default') === requestedInstanceId)
      : null;
    provider.settings = instance || provider.settings || {};
    provider.router = agentChannelManager.router;

    const result = await provider.handleWebhook(req.body || {}, {
      cwd: provider.settings?.cwd || ''
    });

    return res.status(result?.status || 200).json(result?.body || { success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

export function handleListAgentChannelConversations(req, res) {
  res.json({
    success: true,
    conversations: agentChannelConversationStore.list({
      limit: parseLimit(req.query.limit, 50)
    }).map((conversation) => decorateConversation(conversation))
  });
}

export function handleListAgentChannelSessionRecords(req, res) {
  res.json({
    success: true,
    records: buildAgentChannelSessionRecords({
      limit: parseLimit(req.query.limit, 80)
    })
  });
}

export function handleGetAgentChannelSessionRecord(req, res) {
  const record = buildAgentChannelSessionRecordDetail(String(req.params.id || ''));
  if (!record) {
    return res.status(404).json({ success: false, error: 'session record not found' });
  }

  return res.json({
    success: true,
    ...record
  });
}

export function handleGetAgentChannelConversation(req, res) {
  const conversation = agentChannelConversationStore.get(String(req.params.id || ''));
  if (!conversation) {
    return res.status(404).json({ success: false, error: 'conversation not found' });
  }

  return res.json({
    success: true,
    conversation: decorateConversation(conversation, { includeDeliveries: true })
  });
}

export function handleResetAgentChannelConversation(req, res) {
  const conversation = agentChannelConversationStore.clearActiveRuntimeSession(String(req.params.id || ''));
  if (!conversation) {
    return res.status(404).json({ success: false, error: 'conversation not found' });
  }

  return res.json({
    success: true,
    conversation: decorateConversation(conversation)
  });
}

function resolveConversation(req) {
  const conversation = agentChannelConversationStore.get(String(req.params.conversationId || ''));
  if (!conversation) {
    throw new Error('conversation not found');
  }
  return conversation;
}

export function handleApproveAgentChannelPairing(req, res) {
  try {
    const conversation = resolveConversation(req);
    const pairing = agentChannelPairingStore.approve({
      channel: conversation.channel,
      accountId: conversation.accountId,
      externalUserId: conversation.externalUserId,
      externalConversationId: conversation.externalConversationId,
      approvedBy: req.body?.approvedBy || 'dashboard'
    });
    if (!pairing) {
      return res.status(404).json({ success: false, error: 'pairing not found' });
    }
    return res.json({ success: true, pairing });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    return res.status(status).json({ success: false, error: error.message });
  }
}

export function handleDenyAgentChannelPairing(req, res) {
  try {
    const conversation = resolveConversation(req);
    const pairing = agentChannelPairingStore.deny({
      channel: conversation.channel,
      accountId: conversation.accountId,
      externalUserId: conversation.externalUserId,
      externalConversationId: conversation.externalConversationId,
      approvedBy: req.body?.approvedBy || 'dashboard'
    });
    if (!pairing) {
      return res.status(404).json({ success: false, error: 'pairing not found' });
    }
    return res.json({ success: true, pairing });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    return res.status(status).json({ success: false, error: error.message });
  }
}

export default {
  handleListAgentChannelProviders,
  handleGetAgentChannelCatalog,
  handleGetAgentChannelSettings,
  handleCreateAgentChannelInstance,
  handleUpdateAgentChannelSettings,
  handleDeleteAgentChannelInstance,
  handleRefreshAgentChannels,
  handleFeishuChannelWebhook,
  handleDingTalkChannelWebhook,
  handleListAgentChannelConversations,
  handleGetAgentChannelConversation,
  handleListAgentChannelSessionRecords,
  handleGetAgentChannelSessionRecord,
  handleResetAgentChannelConversation,
  handleApproveAgentChannelPairing,
  handleDenyAgentChannelPairing
};
