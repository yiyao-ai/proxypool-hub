import createDefaultAssistantToolRegistry, { AssistantToolRegistry } from './tool-registry.js';
import assistantPolicyService, { AssistantPolicyService } from './policy-service.js';

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
    toolRegistry = createDefaultAssistantToolRegistry(),
    policyService = assistantPolicyService
  } = {}) {
    this.toolRegistry = toolRegistry instanceof AssistantToolRegistry
      ? toolRegistry
      : toolRegistry;
    this.policyService = policyService instanceof AssistantPolicyService
      ? policyService
      : policyService;
  }

  async executeToolCall(call = {}, context = {}) {
    const tool = this.toolRegistry.get(call.toolName);
    if (!tool) {
      throw new Error(`Unknown assistant tool: ${call.toolName}`);
    }

    const policy = this.policyService?.canExecuteToolCall?.({
      toolName: call.toolName,
      conversation: context.conversation || null,
      runtimeSession: context.runtimeSession || null,
      cwd: context.run?.metadata?.plan?.cwd || context.conversation?.metadata?.workspaceId || '',
      metadata: context.run?.metadata || {},
      input: call.input || {}
    });
    if (policy && policy.allowed === false) {
      throw new Error(`Assistant policy blocked tool ${call.toolName}: ${policy.reason}`);
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
      policy,
      summary: summarizeResult(result),
      result
    };
  }
}

export default AssistantToolExecutor;

