import assistantTaskViewService from '../assistant-core/task-view-service.js';

function parseLimit(value, fallback = 20, max = 200) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function handleListAssistantTasks(req, res) {
  const tasks = assistantTaskViewService.listTasks({
    limit: parseLimit(req.query.limit, 20, 100),
    state: String(req.query.state || ''),
    conversationId: String(req.query.conversationId || '')
  });

  return res.json({
    success: true,
    tasks
  });
}

export function handleGetAssistantTask(req, res) {
  const task = assistantTaskViewService.getTask(String(req.params.id || ''));
  if (!task) {
    return res.status(404).json({
      success: false,
      error: 'assistant task not found'
    });
  }

  return res.json({
    success: true,
    task
  });
}

export default {
  handleListAssistantTasks,
  handleGetAssistantTask
};
