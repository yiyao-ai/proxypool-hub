function normalizeText(value) {
  return String(value || '').trim();
}

function isChineseText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function parseProvider(text) {
  if (/(claude(?:\s|-)?code|claude code|claude)/i.test(text)) return 'claude-code';
  if (/(codex)/i.test(text)) return 'codex';
  return '';
}

function buildObservationRequest({ conversation } = {}) {
  return {
    workspace: {
      runtimeLimit: 10,
      conversationLimit: 10
    },
    conversation: conversation?.id
      ? {
          conversationId: conversation.id,
          deliveryLimit: 10
        }
      : null
  };
}

function getFocusTaskId(conversation = null) {
  return String(
    conversation?.metadata?.supervisor?.taskMemory?.activeTaskId
    || conversation?.metadata?.supervisor?.taskMemory?.currentTask?.taskId
    || conversation?.metadata?.supervisor?.taskMemory?.current?.taskId
    || ''
  ).trim();
}

function buildFallbackPlan({ zh, observation } = {}) {
  return {
    version: 'phase7-fallback-v1',
    summaryIntent: 'fallback_unhandled',
    language: zh ? 'zh' : 'en',
    observation,
    execution: {
      maxSteps: 0,
      maxToolCalls: 0,
      maxDurationMs: 5_000
    },
    steps: []
  };
}

export class AssistantPlanner {
  buildPlan({
    text,
    conversation,
    defaultRuntimeProvider = 'codex',
    cwd = '',
    model = ''
  } = {}) {
    const source = normalizeText(text);
    const activeSessionId = conversation?.activeRuntimeSessionId || '';
    const focusTaskId = getFocusTaskId(conversation);
    const observation = buildObservationRequest({ conversation });
    const zh = isChineseText(source);

    const startMatch = source.match(/^(?:start|delegate(?:\s+to)?|run|启动|发起|委派)(?:\s+(codex|claude(?:\s|-)?code|claude))?[\s:：-]*(.+)$/i);
    if (startMatch) {
      const provider = parseProvider(startMatch[1] || '') || defaultRuntimeProvider || 'codex';
      const task = normalizeText(startMatch[2]);
      return {
        version: 'phase4-v2',
        summaryIntent: focusTaskId ? 'task_execution_start' : 'runtime_start',
        language: zh ? 'zh' : 'en',
        observation,
        execution: {
          maxSteps: 2,
          maxToolCalls: 2,
          maxDurationMs: 20_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'get_workspace_context',
            input: observation.workspace,
            reason: 'Collect workspace summary before delegation.'
          },
          {
            kind: 'act',
            toolName: focusTaskId ? 'delegate_task_execution' : 'delegate_to_runtime',
            input: focusTaskId
              ? {
                  taskId: focusTaskId,
                  provider,
                  role: 'secondary',
                  task,
                  cwd,
                  model,
                  metadata: {
                    source: {
                      kind: 'assistant-runner',
                      conversationId: conversation?.id || ''
                    },
                    conversationId: conversation?.id || ''
                  }
                }
              : {
                  provider,
                  task,
                  cwd,
                  model,
                  metadata: {
                    source: {
                      kind: 'assistant-runner',
                      conversationId: conversation?.id || ''
                    },
                    conversationId: conversation?.id || ''
                  }
                },
            reason: focusTaskId
              ? 'Start a secondary execution for the current supervisor task.'
              : 'Delegate a new task to the selected runtime.'
          }
        ]
      };
    }

    const continueMatch = source.match(/^(?:continue|follow up|继续|接着)(?:\s+session)?[\s:：-]*(.+)$/i);
    if (continueMatch && activeSessionId) {
      return {
        version: 'phase4-v2',
        summaryIntent: 'runtime_continue',
        language: zh ? 'zh' : 'en',
        observation,
        execution: {
          maxSteps: 2,
          maxToolCalls: 2,
          maxDurationMs: 20_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'get_conversation_context',
            input: observation.conversation || {
              conversationId: conversation?.id || '',
              deliveryLimit: 10
            },
            reason: 'Refresh bound runtime context before continuing.'
          },
          {
            kind: 'act',
            toolName: 'send_runtime_input',
            input: {
              sessionId: activeSessionId,
              message: normalizeText(continueMatch[1])
            },
            reason: 'Continue the active runtime session.'
          }
        ]
      };
    }

    if (/^(?:cancel|stop|取消|停止)(?:\s+session)?$/i.test(source) && activeSessionId) {
      return {
        version: 'phase4-v2',
        summaryIntent: 'runtime_cancel',
        language: zh ? 'zh' : 'en',
        observation,
        execution: {
          maxSteps: 2,
          maxToolCalls: 2,
          maxDurationMs: 15_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'get_conversation_context',
            input: observation.conversation || {
              conversationId: conversation?.id || '',
              deliveryLimit: 10
            },
            reason: 'Confirm active runtime binding before cancelling.'
          },
          {
            kind: 'act',
            toolName: 'cancel_runtime_session',
            input: {
              sessionId: activeSessionId
            },
            reason: 'Cancel the active runtime session.'
          }
        ]
      };
    }

    const runtimeIdMatch = source.match(/(?:runtime|session|会话)[\s#:：-]*([a-z0-9-]{8,})/i);
    if (runtimeIdMatch) {
      return {
        version: 'phase4-v2',
        summaryIntent: 'runtime_detail',
        language: zh ? 'zh' : 'en',
        observation,
        execution: {
          maxSteps: 1,
          maxToolCalls: 1,
          maxDurationMs: 10_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'get_runtime_session',
            input: {
              sessionId: normalizeText(runtimeIdMatch[1])
            },
            reason: 'Inspect the requested runtime session.'
          }
        ]
      };
    }

    if (/(conversation|对话|聊天).*(list|recent|最近|列表|全部)?/i.test(source)) {
      return {
        version: 'phase4-v2',
        summaryIntent: 'conversation_list',
        language: zh ? 'zh' : 'en',
        observation,
        execution: {
          maxSteps: 1,
          maxToolCalls: 1,
          maxDurationMs: 10_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'list_conversations',
            input: {
              limit: 10
            },
            reason: 'List recent conversations.'
          }
        ]
      };
    }

    if (/(task|任务).*(list|recent|最近|列表|全部)?/i.test(source)) {
      return {
        version: 'phase7-v1',
        summaryIntent: 'task_list',
        language: zh ? 'zh' : 'en',
        observation,
        execution: {
          maxSteps: 1,
          maxToolCalls: 1,
          maxDurationMs: 10_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'list_tasks',
            input: {
              limit: 10
            },
            reason: 'List unified assistant task records.'
          }
        ]
      };
    }

    if (/(task|任务).*(status|detail|详情|状态)/i.test(source) && conversation?.id) {
      return {
        version: 'phase7-v1',
        summaryIntent: 'task_detail',
        language: zh ? 'zh' : 'en',
        observation,
        execution: {
          maxSteps: 1,
          maxToolCalls: 1,
          maxDurationMs: 10_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'list_tasks',
            input: {
              conversationId: conversation.id,
              limit: 1
            },
            reason: 'Fetch the current conversation task record.'
          }
        ]
      };
    }

    if (/(status|进展|blocked|阻塞|approval|审批|question|问题)/i.test(source)) {
      return {
        version: 'phase7-v1',
        summaryIntent: 'task_summary',
        language: zh ? 'zh' : 'en',
        observation,
        execution: {
          maxSteps: observation.conversation ? 2 : 1,
          maxToolCalls: observation.conversation ? 2 : 1,
          maxDurationMs: 15_000
        },
        steps: [
          {
            kind: 'observe',
            toolName: 'list_tasks',
            input: {
              ...(conversation?.id ? { conversationId: conversation.id } : {}),
              limit: conversation?.id ? 1 : 10
            },
            reason: 'Build a task-centric operational view.'
          },
          ...(observation.conversation
            ? [{
                kind: 'observe',
                toolName: 'get_conversation_context',
                input: observation.conversation,
                reason: 'Drill into the current conversation when needed.'
              }]
            : [])
        ]
      };
    }

    return buildFallbackPlan({ zh, observation });
  }
}

export const assistantPlanner = new AssistantPlanner();

export default assistantPlanner;
