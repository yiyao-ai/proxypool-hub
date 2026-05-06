import assistantReflectionStore from '../assistant-core/reflection-store.js';

function normalizeText(value) {
  return String(value || '').trim();
}

function splitKeywords(values = []) {
  const seen = new Set();
  const keywords = [];
  for (const value of values) {
    for (const token of normalizeText(value).toLowerCase().split(/[^a-z0-9\u3400-\u9fff]+/).filter((entry) => entry.length >= 2)) {
      if (seen.has(token)) continue;
      seen.add(token);
      keywords.push(token);
    }
  }
  return keywords.slice(0, 8);
}

export class AssistantReflectionService {
  constructor({
    reflectionStore = assistantReflectionStore
  } = {}) {
    this.reflectionStore = reflectionStore;
  }

  async expandToolResults({ toolCall, toolResult, toolExecutor, context } = {}) {
    const toolName = String(toolCall?.toolName || '');
    if (!['delegate_to_codex', 'delegate_to_claude_code', 'delegate_to_runtime', 'reuse_or_delegate', 'send_runtime_input', 'continue_task'].includes(toolName)) {
      return [];
    }

    const sessionId = toolResult?.result?.session?.id
      || toolResult?.result?.id
      || toolResult?.result?.sessionId
      || '';
    const status = String(toolResult?.result?.session?.status || toolResult?.result?.status || '');
    if (!sessionId || !status || ['starting', 'running'].includes(status)) {
      return [];
    }

    return [await toolExecutor.executeToolCall({
      toolName: 'summarize_runtime_result',
      input: {
        sessionId,
        eventLimit: 20
      }
    }, context)];
  }

  buildPostmortem({ task = null } = {}) {
    if (!task?.id) return null;
    const title = normalizeText(task.title);
    const summary = normalizeText(task.summary);
    const result = normalizeText(task.result);
    const error = normalizeText(task.error);
    const status = normalizeText(task.status);
    return {
      purpose: title || summary,
      outcome: result || summary || error || status,
      deliverables: [result || summary].filter(Boolean).slice(0, 3),
      next: ['failed', 'cancelled'].includes(status)
        ? 'Revisit or retry the task if the user still needs this outcome.'
        : '',
      keywords: splitKeywords([
        title,
        summary,
        result,
        error,
        task.cwd,
        task.cwdBasename
      ])
    };
  }

  saveTaskPostmortem({ task = null } = {}) {
    if (!task?.id) return null;
    const payload = this.buildPostmortem({ task });
    if (!payload) return null;
    return this.reflectionStore.saveReflection({
      kind: 'postmortem',
      taskId: task.id,
      conversationId: task.conversationId || '',
      workspaceId: task.workspaceId || task?.metadata?.workspaceId || '',
      cwd: task.cwd || '',
      payload
    });
  }
}

export const assistantReflectionService = new AssistantReflectionService();

export default assistantReflectionService;
