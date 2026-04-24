import { ASSISTANT_RUN_STATUS } from '../assistant-core/models.js';
import { buildAnthropicToolDefinitions } from './tool-schema.js';
import { buildInitialAnthropicMessages } from './prompt-builder.js';
import { deriveAssistantRunStopState } from './stop-policy.js';
import { composeAssistantReply } from './response-composer.js';
import assistantReflectionService, { AssistantReflectionService } from './reflection-service.js';

function nowIso() {
  return new Date().toISOString();
}

function isChineseText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function stringifyToolResult(result) {
  return JSON.stringify(result?.result ?? result ?? null, null, 2);
}

function appendAssistantToolMessage(messages, completion) {
  const content = [];
  if (completion.text) {
    content.push({
      type: 'text',
      text: completion.text
    });
  }
  for (const call of completion.toolCalls || []) {
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input || {}
    });
  }
  if (content.length > 0) {
    messages.push({
      role: 'assistant',
      content
    });
  }
}

function appendToolResultMessage(messages, toolCall, toolResult) {
  messages.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolCall.id,
      content: stringifyToolResult(toolResult)
    }]
  });
}

function summarizeToolStep(toolName, result) {
  return {
    kind: 'tool',
    toolName,
    status: result?.success === false ? 'failed' : 'completed',
    summary: String(result?.summary || '').trim(),
    startedAt: result?.startedAt || nowIso(),
    completedAt: result?.completedAt || nowIso()
  };
}

export class AssistantReactEngine {
  constructor({
    llmClient,
    toolRegistry,
    toolExecutor,
    reflectionService = assistantReflectionService,
    maxIterations = 6
  } = {}) {
    this.llmClient = llmClient;
    this.toolRegistry = toolRegistry;
    this.toolExecutor = toolExecutor;
    this.reflectionService = reflectionService instanceof AssistantReflectionService
      ? reflectionService
      : reflectionService;
    this.maxIterations = maxIterations;
  }

  async run({
    run,
    conversation,
    text,
    taskRecord = null,
    taskSpace = null,
    conversationContext = null,
    workspaceContext = null,
    defaultRuntimeProvider = 'codex',
    cwd = '',
    model = ''
  } = {}) {
    const language = isChineseText(text) ? 'zh-CN' : 'en';
    const prompt = buildInitialAnthropicMessages({
      language,
      conversation,
      text,
      taskRecord,
      taskSpace,
      conversationContext,
      workspaceContext,
      defaultRuntimeProvider,
      cwd,
      model
    });
    const toolDefinitions = buildAnthropicToolDefinitions(this.toolRegistry);
    const transcript = [...prompt.messages];
    const toolResults = [];
    const relatedRuntimeSessionIds = new Set(run?.relatedRuntimeSessionIds || []);
    let llmSource = null;
    let finalText = '';
    let maxIterationsReached = true;

    let workingRun = this.toolExecutor.policyService ? run : run;
    workingRun = {
      ...workingRun,
      status: ASSISTANT_RUN_STATUS.RUNNING,
      steps: Array.isArray(workingRun?.steps) ? [...workingRun.steps] : [],
      metadata: {
        ...(workingRun?.metadata || {}),
        agent: {
          mode: 'react',
          phase: 'phase-a-b-c',
          defaultRuntimeProvider,
          cwd,
          requestedModel: model || '',
          iterations: 0
        }
      }
    };

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const completion = await this.llmClient.complete({
        system: prompt.system,
        messages: transcript,
        tools: toolDefinitions,
        model
      });
      llmSource = completion.source;
      workingRun.steps.push({
        kind: 'assistant_turn',
        status: 'completed',
        summary: completion.toolCalls?.length
          ? `Assistant requested ${completion.toolCalls.length} tool call(s)`
          : 'Assistant produced a direct reply',
        model: completion.source?.model || '',
        source: completion.source?.kind || '',
        completedAt: nowIso()
      });
      workingRun.metadata = {
        ...(workingRun.metadata || {}),
        agent: {
          ...(workingRun.metadata?.agent || {}),
          iterations: iteration + 1,
          llmSource
        }
      };

      if (!completion.toolCalls || completion.toolCalls.length === 0) {
        finalText = String(completion.text || '').trim();
        maxIterationsReached = false;
        break;
      }

      appendAssistantToolMessage(transcript, completion);

      for (const toolCall of completion.toolCalls) {
        const result = await this.toolExecutor.executeToolCall({
          toolName: toolCall.name,
          input: toolCall.input || {}
        }, {
          run: workingRun,
          conversation
        });
        toolResults.push(result);
        workingRun.steps.push(summarizeToolStep(toolCall.name, result));

        const sessionId = result?.result?.session?.id || result?.result?.id || '';
        if (sessionId && (result?.result?.provider || result?.result?.session?.provider)) {
          relatedRuntimeSessionIds.add(sessionId);
        }

        appendToolResultMessage(transcript, toolCall, result);

        const reflected = await this.reflectionService.expandToolResults({
          toolCall: { toolName: toolCall.name, input: toolCall.input || {} },
          toolResult: result,
          toolExecutor: this.toolExecutor,
          context: {
            run: workingRun,
            conversation
          }
        });
        for (const extra of reflected) {
          toolResults.push(extra);
          workingRun.steps.push(summarizeToolStep(extra.toolName, extra));
          appendToolResultMessage(transcript, {
            id: `${toolCall.id}:${extra.toolName}`,
            name: extra.toolName
          }, extra);
        }
      }
    }

    const stopState = deriveAssistantRunStopState({
      toolResults,
      assistantText: finalText,
      maxIterationsReached
    });
    const finalStatus = stopState.status;
    const reply = composeAssistantReply({
      language,
      assistantText: finalText,
      toolResults,
      finalStatus,
      stopReason: stopState.reason
    });

    workingRun = {
      ...workingRun,
      relatedRuntimeSessionIds: [...relatedRuntimeSessionIds],
      status: finalStatus,
      summary: reply.summary,
      result: reply.message,
      metadata: {
        ...(workingRun.metadata || {}),
        stopPolicy: stopState
      }
    };

    return {
      run: workingRun,
      toolResults,
      reply,
      llmSource
    };
  }
}

export default AssistantReactEngine;
