import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import assistantObservationService from './observation-service.js';
import assistantRunStore, { AssistantRunStore } from './run-store.js';
import createDefaultAssistantToolRegistry from './tool-registry.js';
import AssistantToolExecutor from './tool-executor.js';
import { ASSISTANT_RUN_STATUS } from './models.js';

function isChineseText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function parseProvider(text) {
  if (/(claude(?:\s|-)?code|claude code|claude)/i.test(text)) return 'claude-code';
  if (/(codex)/i.test(text)) return 'codex';
  return '';
}

function parseToolPlan({ text, conversation, defaultRuntimeProvider = 'codex', cwd = '', model = '' } = {}) {
  const source = String(text || '').trim();
  const normalized = source.toLowerCase();
  const activeSessionId = conversation?.activeRuntimeSessionId || '';

  const startMatch = source.match(/^(?:\/?cligate\s+)?(?:start|delegate(?:\s+to)?|run|启动|发起|委派)(?:\s+(codex|claude(?:\s|-)?code|claude))?[\s:：-]*(.+)$/i);
  if (startMatch) {
    const provider = parseProvider(startMatch[1] || '') || defaultRuntimeProvider || 'codex';
    const task = String(startMatch[2] || '').trim();
    return {
      summaryIntent: 'runtime_start',
      toolCalls: [
        {
          toolName: 'start_runtime_task',
          input: {
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
          }
        }
      ]
    };
  }

  const continueMatch = source.match(/^(?:continue|follow up|继续|接着)(?:\s+session)?[\s:：-]*(.+)$/i);
  if (continueMatch && activeSessionId) {
    return {
      summaryIntent: 'runtime_continue',
      toolCalls: [
        {
          toolName: 'send_runtime_input',
          input: {
            sessionId: activeSessionId,
            message: String(continueMatch[1] || '').trim()
          }
        }
      ]
    };
  }

  if (/^(?:cancel|stop|取消|停止)(?:\s+session)?$/i.test(source) && activeSessionId) {
    return {
      summaryIntent: 'runtime_cancel',
      toolCalls: [
        {
          toolName: 'cancel_runtime_session',
          input: {
            sessionId: activeSessionId
          }
        }
      ]
    };
  }

  const runtimeIdMatch = source.match(/(?:runtime|session|会话)[\s#:：-]*([a-z0-9-]{8,})/i);
  if (runtimeIdMatch) {
    return {
      summaryIntent: 'runtime_detail',
      toolCalls: [
        {
          toolName: 'get_runtime_session',
          input: {
            sessionId: String(runtimeIdMatch[1] || '').trim()
          }
        }
      ]
    };
  }

  if (/(conversation|对话|聊天).*(list|recent|最近|列表|全部)?/i.test(source)) {
    return {
      summaryIntent: 'conversation_list',
      toolCalls: [
        {
          toolName: 'list_conversations',
          input: {
            limit: 10
          }
        }
      ]
    };
  }

  if (/(runtime|session|状态|status|progress|进展|blocked|阻塞|approval|审批|question|问题)/i.test(source)) {
    return {
      summaryIntent: 'workspace_summary',
      toolCalls: [
        {
          toolName: 'get_workspace_context',
          input: {
            runtimeLimit: 10,
            conversationLimit: 10
          }
        },
        ...(conversation?.id
          ? [{
              toolName: 'get_conversation_context',
              input: {
                conversationId: conversation.id,
                deliveryLimit: 10
              }
            }]
          : [])
      ]
    };
  }

  return {
    summaryIntent: 'conversation_summary',
    toolCalls: [
      {
        toolName: 'get_workspace_context',
        input: {
          runtimeLimit: 10,
          conversationLimit: 10
        }
      },
      ...(conversation?.id
        ? [{
            toolName: 'get_conversation_context',
            input: {
              conversationId: conversation.id,
              deliveryLimit: 10
            }
          }]
        : [])
    ]
  };
}

function providerLabel(providerId) {
  if (providerId === 'claude-code') return 'Claude Code';
  if (providerId === 'codex') return 'Codex';
  return String(providerId || 'agent');
}

function formatWorkspaceSummary(result, zh) {
  const summary = result?.summary || {};
  return zh
    ? `全局运行概览: runtime ${summary.runtimeCount || 0}，conversation ${summary.conversationCount || 0}，运行中 ${summary.running || 0}，待审批 ${summary.waitingApproval || 0}，待回答 ${summary.waitingUser || 0}，失败 ${summary.failed || 0}`
    : `Workspace overview: ${summary.runtimeCount || 0} runtimes, ${summary.conversationCount || 0} conversations, ${summary.running || 0} running, ${summary.waitingApproval || 0} waiting approval, ${summary.waitingUser || 0} waiting user, ${summary.failed || 0} failed.`;
}

function buildRunnerReply({ text, plan, toolResults, conversation } = {}) {
  const zh = isChineseText(text);
  const first = toolResults[0]?.result || null;

  if (plan.summaryIntent === 'runtime_start' && first?.id) {
    return {
      summary: zh ? 'assistant 通过工具发起了新的 runtime 任务。' : 'Started a new runtime task through assistant tools.',
      message: zh
        ? `已通过 assistant tool 发起新任务。\nProvider: ${providerLabel(first.provider)}\nSession: ${first.id}\nTitle: ${first.title || ''}\nStatus: ${first.status || ''}`
        : `Started a new task through assistant tools.\nProvider: ${providerLabel(first.provider)}\nSession: ${first.id}\nTitle: ${first.title || ''}\nStatus: ${first.status || ''}`
    };
  }

  if (plan.summaryIntent === 'runtime_continue' && first?.id) {
    return {
      summary: zh ? 'assistant 已向现有 runtime 发送后续输入。' : 'Sent follow-up input to the active runtime.',
      message: zh
        ? `已发送后续输入到 session ${first.id}。\nProvider: ${providerLabel(first.provider)}\nStatus: ${first.status || ''}`
        : `Sent follow-up input to session ${first.id}.\nProvider: ${providerLabel(first.provider)}\nStatus: ${first.status || ''}`
    };
  }

  if (plan.summaryIntent === 'runtime_cancel' && first?.id) {
    return {
      summary: zh ? 'assistant 已取消 runtime session。' : 'Cancelled the runtime session.',
      message: zh
        ? `已取消 session ${first.id}。`
        : `Cancelled session ${first.id}.`
    };
  }

  if (plan.summaryIntent === 'runtime_detail' && first?.session?.id) {
    return {
      summary: zh ? 'assistant 返回了 runtime 详情。' : 'Returned runtime session detail.',
      message: zh
        ? [
            `Session: ${first.session.id}`,
            `Provider: ${first.session.providerLabel || providerLabel(first.session.provider)}`,
            `Status: ${first.session.status || ''}`,
            first.session.title ? `Title: ${first.session.title}` : null,
            first.session.summary ? `Summary: ${first.session.summary}` : null,
            Array.isArray(first.pendingApprovals) && first.pendingApprovals.length > 0 ? `Pending approvals: ${first.pendingApprovals.length}` : null,
            Array.isArray(first.pendingQuestions) && first.pendingQuestions.length > 0 ? `Pending questions: ${first.pendingQuestions.length}` : null
          ].filter(Boolean).join('\n')
        : [
            `Session: ${first.session.id}`,
            `Provider: ${first.session.providerLabel || providerLabel(first.session.provider)}`,
            `Status: ${first.session.status || ''}`,
            first.session.title ? `Title: ${first.session.title}` : null,
            first.session.summary ? `Summary: ${first.session.summary}` : null,
            Array.isArray(first.pendingApprovals) && first.pendingApprovals.length > 0 ? `Pending approvals: ${first.pendingApprovals.length}` : null,
            Array.isArray(first.pendingQuestions) && first.pendingQuestions.length > 0 ? `Pending questions: ${first.pendingQuestions.length}` : null
          ].filter(Boolean).join('\n')
    };
  }

  if (plan.summaryIntent === 'conversation_list' && Array.isArray(first)) {
    const lines = first.slice(0, 5).map((entry, index) => `${index + 1}. ${entry.title || entry.id} / assistant=${entry.assistantMode}${entry.activeRuntimeSessionId ? ` / runtime=${entry.activeRuntimeSessionId}` : ''}`);
    return {
      summary: zh ? 'assistant 列出了 conversations。' : 'Listed conversations through assistant tools.',
      message: lines.length > 0
        ? lines.join('\n')
        : (zh ? '当前没有可见的 conversation。' : 'No visible conversations.')
    };
  }

  if (plan.summaryIntent === 'workspace_summary') {
    const workspace = toolResults.find((entry) => entry.toolName === 'get_workspace_context')?.result || null;
    const conversationContext = toolResults.find((entry) => entry.toolName === 'get_conversation_context')?.result || null;
    return {
      summary: zh ? 'assistant 汇总了当前工作区与 conversation 状态。' : 'Summarized workspace and conversation state.',
      message: [
        workspace ? formatWorkspaceSummary(workspace, zh) : null,
        conversationContext?.activeRuntime
          ? (zh
            ? `当前 conversation runtime: ${conversationContext.activeRuntime.providerLabel} / ${conversationContext.activeRuntime.status}${conversationContext.activeRuntime.title ? ` / ${conversationContext.activeRuntime.title}` : ''}`
            : `Current conversation runtime: ${conversationContext.activeRuntime.providerLabel} / ${conversationContext.activeRuntime.status}${conversationContext.activeRuntime.title ? ` / ${conversationContext.activeRuntime.title}` : ''}`)
          : (conversation?.id
            ? (zh ? '当前 conversation 没有绑定中的 runtime。' : 'No runtime is attached to the current conversation.')
            : null)
      ].filter(Boolean).join('\n')
    };
  }

  const workspace = toolResults.find((entry) => entry.toolName === 'get_workspace_context')?.result || null;
  return {
    summary: zh ? 'assistant 通过工具返回了基础观测结果。' : 'Returned basic assistant observation using tools.',
    message: workspace
      ? formatWorkspaceSummary(workspace, zh)
      : (zh ? 'assistant 已完成本次工具执行。' : 'The assistant tool run completed.')
  };
}

export class AssistantRunner {
  constructor({
    runStore = assistantRunStore,
    observationService = assistantObservationService,
    messageService = agentOrchestratorMessageService,
    toolRegistry = null,
    toolExecutor = null
  } = {}) {
    this.runStore = runStore instanceof AssistantRunStore ? runStore : runStore;
    this.observationService = observationService;
    this.messageService = messageService;
    this.toolRegistry = toolRegistry || createDefaultAssistantToolRegistry({
      observationService: this.observationService,
      messageService: this.messageService
    });
    this.toolExecutor = toolExecutor || new AssistantToolExecutor({
      toolRegistry: this.toolRegistry
    });
  }

  async run({
    run,
    conversation,
    text,
    defaultRuntimeProvider = 'codex',
    cwd = '',
    model = ''
  } = {}) {
    const plan = parseToolPlan({
      text,
      conversation,
      defaultRuntimeProvider,
      cwd,
      model
    });

    let currentRun = this.runStore.save({
      ...run,
      status: ASSISTANT_RUN_STATUS.RUNNING,
      metadata: {
        ...(run.metadata || {}),
        plan
      }
    });

    const toolResults = [];
    const steps = [];
    const relatedRuntimeSessionIds = new Set(currentRun.relatedRuntimeSessionIds || []);

    try {
      for (const call of plan.toolCalls) {
        const executed = await this.toolExecutor.executeToolCall(call, {
          conversation,
          run: currentRun
        });
        toolResults.push(executed);
        if (executed.result?.id && ['start_runtime_task', 'send_runtime_input', 'cancel_runtime_session'].includes(executed.toolName)) {
          relatedRuntimeSessionIds.add(executed.result.id);
        }
        steps.push({
          kind: 'tool_call',
          status: 'completed',
          toolName: executed.toolName,
          summary: executed.summary,
          startedAt: executed.startedAt,
          completedAt: executed.completedAt
        });
        currentRun = this.runStore.save({
          ...currentRun,
          steps,
          relatedRuntimeSessionIds: [...relatedRuntimeSessionIds],
          metadata: {
            ...(currentRun.metadata || {}),
            toolResults: toolResults.map((entry) => ({
              toolName: entry.toolName,
              input: entry.input,
              summary: entry.summary,
              startedAt: entry.startedAt,
              completedAt: entry.completedAt
            }))
          }
        });
      }

      const reply = buildRunnerReply({
        text,
        plan,
        toolResults,
        conversation
      });

      const completedRun = this.runStore.save({
        ...currentRun,
        status: ASSISTANT_RUN_STATUS.COMPLETED,
        summary: reply.summary,
        result: reply.message,
        steps,
        relatedRuntimeSessionIds: [...relatedRuntimeSessionIds],
        metadata: {
          ...(currentRun.metadata || {}),
          toolCount: toolResults.length
        }
      });

      return {
        run: completedRun,
        reply,
        toolResults
      };
    } catch (error) {
      const failedRun = this.runStore.save({
        ...currentRun,
        status: ASSISTANT_RUN_STATUS.FAILED,
        steps,
        relatedRuntimeSessionIds: [...relatedRuntimeSessionIds],
        summary: error.message || 'Assistant run failed',
        result: '',
        metadata: {
          ...(currentRun.metadata || {}),
          error: error.message || 'Assistant run failed'
        }
      });
      throw Object.assign(error, {
        assistantRun: failedRun
      });
    }
  }
}

export default AssistantRunner;
