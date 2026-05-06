import assistantObservationService from '../assistant-core/observation-service.js';
import assistantClarificationStore from '../assistant-core/clarification-store.js';
import assistantWorkspaceStore, { normalizeWorkspaceRef } from '../assistant-core/workspace-store.js';
import chatUiConversationStore from '../chat-ui/conversation-store.js';
import agentChannelConversationStore from '../agent-channels/conversation-store.js';

function parseLimit(value, fallback = 20, max = 200) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function handleGetAssistantWorkspaceContext(req, res) {
  const context = assistantObservationService.getWorkspaceContext({
    runtimeLimit: parseLimit(req.query.runtimeLimit, 10, 100),
    conversationLimit: parseLimit(req.query.conversationLimit, 10, 100)
  });

  return res.json({
    success: true,
    context
  });
}

export function handleListAssistantRuntimeSessions(req, res) {
  const sessions = assistantObservationService.listRuntimeSessions({
    limit: parseLimit(req.query.limit, 20, 100),
    status: String(req.query.status || '')
  });

  return res.json({
    success: true,
    sessions
  });
}

export function handleGetAssistantRuntimeSession(req, res) {
  const detail = assistantObservationService.getRuntimeSessionDetail(
    String(req.params.id || ''),
    {
      eventLimit: parseLimit(req.query.eventLimit, 50, 500)
    }
  );

  if (!detail) {
    return res.status(404).json({
      success: false,
      error: 'runtime session not found'
    });
  }

  return res.json({
    success: true,
    detail
  });
}

export function handleGetAssistantRuntimeTurn(req, res) {
  const detail = assistantObservationService.getRuntimeTurnDetail(
    String(req.params.id || ''),
    String(req.params.turnId || ''),
    {
      eventLimit: parseLimit(req.query.eventLimit, 50, 500)
    }
  );

  if (!detail) {
    return res.status(404).json({
      success: false,
      error: 'runtime turn not found'
    });
  }

  return res.json({
    success: true,
    detail
  });
}

export function handleListAssistantConversations(req, res) {
  const conversations = assistantObservationService.listConversations({
    limit: parseLimit(req.query.limit, 20, 100),
    mode: String(req.query.mode || '')
  });

  return res.json({
    success: true,
    conversations
  });
}

export function handleGetAssistantConversationContext(req, res) {
  const detail = assistantObservationService.getConversationContext(
    String(req.params.id || ''),
    {
      deliveryLimit: parseLimit(req.query.deliveryLimit, 20, 200)
    }
  );

  if (!detail) {
    return res.status(404).json({
      success: false,
      error: 'conversation not found'
    });
  }

  return res.json({
    success: true,
    detail
  });
}

export function handleCancelAssistantClarification(req, res) {
  const id = String(req.params.id || '').trim();
  if (!id) {
    return res.status(400).json({ success: false, error: 'clarificationId is required' });
  }
  const current = assistantClarificationStore.get(id);
  if (!current) {
    return res.status(404).json({ success: false, error: 'clarification not found' });
  }
  const cancelled = assistantClarificationStore.cancel(id);
  // 顺手清掉 conversation 上的 lastPendingClarificationId
  const conversationId = String(cancelled?.conversationId || '').trim();
  if (conversationId) {
    for (const store of [chatUiConversationStore, agentChannelConversationStore]) {
      const conversation = store.get?.(conversationId);
      if (conversation && conversation.lastPendingClarificationId === id) {
        store.patch?.(conversationId, { lastPendingClarificationId: null });
      }
    }
  }
  return res.json({ success: true, clarification: cancelled });
}

export function handleAddAssistantWorkspaceAlias(req, res) {
  const workspaceRef = String(req.body?.workspaceRef || '').trim();
  const alias = String(req.body?.alias || '').trim();
  if (!workspaceRef) {
    return res.status(400).json({ success: false, error: 'workspaceRef is required' });
  }
  if (!alias) {
    return res.status(400).json({ success: false, error: 'alias is required' });
  }
  const normalizedRef = normalizeWorkspaceRef(workspaceRef);
  if (!normalizedRef) {
    return res.status(400).json({ success: false, error: 'invalid workspaceRef' });
  }
  const existing = assistantWorkspaceStore.getByRef(normalizedRef);
  if (!existing) {
    return res.status(404).json({ success: false, error: 'workspace not found' });
  }
  const next = assistantWorkspaceStore.upsert({
    workspaceRef: normalizedRef,
    patch: { aliases: [alias] }
  });
  return res.json({ success: true, workspace: next });
}

export default {
  handleGetAssistantWorkspaceContext,
  handleListAssistantRuntimeSessions,
  handleGetAssistantRuntimeSession,
  handleGetAssistantRuntimeTurn,
  handleListAssistantConversations,
  handleGetAssistantConversationContext,
  handleCancelAssistantClarification,
  handleAddAssistantWorkspaceAlias
};
