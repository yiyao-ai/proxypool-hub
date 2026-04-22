import assistantMemoryService from '../assistant-core/memory-service.js';
import assistantPolicyService from '../assistant-core/policy-service.js';

function normalizeText(value) {
  return String(value || '').trim();
}

export function handleGetAssistantMemory(req, res) {
  const scope = normalizeText(req.query.scope);
  const scopeRef = normalizeText(req.query.scopeRef);
  const conversation = normalizeText(req.query.conversationId)
    ? { id: normalizeText(req.query.conversationId) }
    : null;
  const runtimeSession = normalizeText(req.query.runtimeSessionId)
    ? { id: normalizeText(req.query.runtimeSessionId) }
    : null;
  const cwd = normalizeText(req.query.cwd);

  if (scope && scopeRef) {
    return res.json({
      success: true,
      records: assistantMemoryService.listMemory({ scope, scopeRef })
    });
  }

  return res.json({
    success: true,
    memory: assistantMemoryService.resolvePreferences({
      conversation,
      runtimeSession,
      cwd
    })
  });
}

export function handleGetAssistantPolicies(req, res) {
  const scope = normalizeText(req.query.scope);
  const scopeRef = normalizeText(req.query.scopeRef);

  if (scope && scopeRef) {
    return res.json({
      success: true,
      policies: assistantPolicyService.listPolicies({ scope, scopeRef })
    });
  }

  return res.status(400).json({
    success: false,
    error: 'scope and scopeRef are required'
  });
}

export default {
  handleGetAssistantMemory,
  handleGetAssistantPolicies
};
