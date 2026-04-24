export class AssistantReflectionService {
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
}

export const assistantReflectionService = new AssistantReflectionService();

export default assistantReflectionService;
