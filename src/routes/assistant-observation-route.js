import assistantObservationService from '../assistant-core/observation-service.js';

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

export default {
  handleGetAssistantWorkspaceContext,
  handleListAssistantRuntimeSessions,
  handleGetAssistantRuntimeSession,
  handleGetAssistantRuntimeTurn,
  handleListAssistantConversations,
  handleGetAssistantConversationContext
};
