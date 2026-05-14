import createDefaultAssistantToolRegistry, { AssistantToolRegistry } from './tool-registry.js';
import assistantPolicyService, { AssistantPolicyService } from './policy-service.js';

function nowIso() {
  return new Date().toISOString();
}

function buildPolicyToolResult(tool, call, policy, summary, result = {}) {
  const completedAt = nowIso();
  return {
    toolName: tool.name,
    input: call.input || {},
    startedAt: completedAt,
    completedAt,
    success: false,
    policy,
    summary,
    result
  };
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
    if (policy?.requiresConfirmation) {
      return buildPolicyToolResult(
        tool,
        call,
        policy,
        `Tool ${call.toolName} requires confirmation (${policy.reason})`,
        {
          kind: 'policy_block',
          requiresConfirmation: true,
          reason: policy.reason,
          hint: 'This tool call requires confirmation. Ask the user for confirmation or choose a non-mutating path.'
        }
      );
    }

    const startedAt = nowIso();
    let result;
    try {
      result = await tool.execute({
        input: call.input || {},
        context
      });
    } catch (error) {
      // Convert tool throws into a structured failure so the supervisor LLM
      // can read the error and decide a recovery (e.g. delegate_to_codex
      // with a fresh session) instead of the entire dialogue collapsing to
      // the deterministic fallback runner. Without this, a transient runtime
      // error like "session is already running" makes the user see the
      // canned "fallback assistant" message.
      const completedAt = nowIso();
      const message = String(error?.message || error || 'tool execution failed').trim();
      return {
        toolName: tool.name,
        input: call.input || {},
        startedAt,
        completedAt,
        success: false,
        policy,
        summary: `Tool ${tool.name} failed: ${message.slice(0, 200)}`,
        result: {
          kind: 'tool_error',
          error: message,
          recoverable: true,
          hint: 'The tool call failed. Decide whether to retry with adjusted input (e.g. start a fresh session with delegate_to_codex), to use a different tool, or to tell the user what happened.'
        }
      };
    }
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

