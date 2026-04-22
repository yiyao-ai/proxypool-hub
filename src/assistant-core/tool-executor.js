import createDefaultAssistantToolRegistry, { AssistantToolRegistry } from './tool-registry.js';

function nowIso() {
  return new Date().toISOString();
}

function summarizeResult(result) {
  if (result == null) return 'No result';
  if (Array.isArray(result)) return `Returned ${result.length} items`;
  if (typeof result === 'object') {
    if (result.id) return `Returned object ${result.id}`;
    if (result.session?.id) return `Returned session ${result.session.id}`;
    if (result.conversation?.id) return `Returned conversation ${result.conversation.id}`;
    return `Returned object with keys: ${Object.keys(result).slice(0, 6).join(', ')}`;
  }
  return String(result).slice(0, 160);
}

export class AssistantToolExecutor {
  constructor({
    toolRegistry = createDefaultAssistantToolRegistry()
  } = {}) {
    this.toolRegistry = toolRegistry instanceof AssistantToolRegistry
      ? toolRegistry
      : toolRegistry;
  }

  async executeToolCall(call = {}, context = {}) {
    const tool = this.toolRegistry.get(call.toolName);
    if (!tool) {
      throw new Error(`Unknown assistant tool: ${call.toolName}`);
    }

    const startedAt = nowIso();
    const result = await tool.execute({
      input: call.input || {},
      context
    });
    const completedAt = nowIso();

    return {
      toolName: tool.name,
      input: call.input || {},
      startedAt,
      completedAt,
      success: true,
      summary: summarizeResult(result),
      result
    };
  }
}

export default AssistantToolExecutor;

