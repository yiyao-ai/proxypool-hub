import assistantRunStore from '../assistant-core/run-store.js';

function parseLimit(value, fallback = 20, max = 200) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function handleListAssistantRuns(req, res) {
  const assistantSessionId = String(req.query.assistantSessionId || '');
  const conversationId = String(req.query.conversationId || '');
  const limit = parseLimit(req.query.limit, 20, 100);

  const runs = conversationId
    ? assistantRunStore.listByConversationId(conversationId, { limit })
    : assistantRunStore.list({ assistantSessionId, limit });

  return res.json({
    success: true,
    runs
  });
}

export function handleGetAssistantRun(req, res) {
  const run = assistantRunStore.get(String(req.params.id || ''));
  if (!run) {
    return res.status(404).json({
      success: false,
      error: 'assistant run not found'
    });
  }

  return res.json({
    success: true,
    run
  });
}

export default {
  handleListAssistantRuns,
  handleGetAssistantRun
};
