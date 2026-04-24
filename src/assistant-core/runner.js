import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import assistantObservationService from './observation-service.js';
import assistantRunStore, { AssistantRunStore } from './run-store.js';
import createDefaultAssistantToolRegistry from './tool-registry.js';
import AssistantToolExecutor from './tool-executor.js';
import { ASSISTANT_RUN_CLOSURE_STATE, ASSISTANT_RUN_STATUS, createAssistantRunCheckpoint } from './models.js';
import assistantPlanner, { AssistantPlanner } from './planner.js';
import assistantTaskViewService from './task-view-service.js';

function isChineseText(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
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

function formatTaskRecord(task, zh) {
  if (!task?.id) {
    return zh ? '当前没有可见任务。' : 'No visible task record.';
  }
  return [
    `Task: ${task.id}`,
    task.conversation?.title ? `Conversation: ${task.conversation.title}` : null,
    task.runtimeSession?.providerLabel ? `Provider: ${task.runtimeSession.providerLabel}` : null,
    task.state ? `State: ${task.state}` : null,
    task.waitingReason ? `Waiting: ${task.waitingReason}` : null,
    task.summary ? `Summary: ${task.summary}` : null,
    task.resultPreview ? `Result: ${task.resultPreview}` : null
  ].filter(Boolean).join('\n');
}

function buildRunnerReply({ text, plan, toolResults, conversation } = {}) {
  const zh = isChineseText(text);
  const first = toolResults[0]?.result || null;
  const delegatedResult = toolResults.find((entry) => (
    ['start_runtime_task', 'delegate_to_codex', 'delegate_to_claude_code', 'delegate_to_runtime', 'delegate_task_execution', 'reuse_or_delegate'].includes(entry.toolName)
  ))?.result || null;
  const continuedResult = toolResults.find((entry) => entry.toolName === 'send_runtime_input')?.result || null;
  const cancelledResult = toolResults.find((entry) => entry.toolName === 'cancel_runtime_session')?.result || null;

  if (['runtime_start', 'task_execution_start'].includes(plan.summaryIntent) && delegatedResult?.id) {
    return {
      summary: zh
        ? (plan.summaryIntent === 'task_execution_start' ? 'assistant 为当前 task 发起了新的 execution。' : 'assistant 通过工具发起了新的 runtime 任务。')
        : (plan.summaryIntent === 'task_execution_start' ? 'Started a new execution for the current task.' : 'Started a new runtime task through assistant tools.'),
      message: zh
        ? `${plan.summaryIntent === 'task_execution_start' ? '已为当前 task 发起新的 execution。' : '已通过 assistant tool 发起新任务。'}\nProvider: ${providerLabel(delegatedResult.provider)}\nSession: ${delegatedResult.id}\nTitle: ${delegatedResult.title || ''}\nStatus: ${delegatedResult.status || ''}`
        : `${plan.summaryIntent === 'task_execution_start' ? 'Started a new execution for the current task.' : 'Started a new task through assistant tools.'}\nProvider: ${providerLabel(delegatedResult.provider)}\nSession: ${delegatedResult.id}\nTitle: ${delegatedResult.title || ''}\nStatus: ${delegatedResult.status || ''}`
    };
  }

  if (plan.summaryIntent === 'runtime_continue' && continuedResult?.id) {
    return {
      summary: zh ? 'assistant 已向现有 runtime 发送后续输入。' : 'Sent follow-up input to the active runtime.',
      message: zh
        ? `已发送后续输入到 session ${continuedResult.id}。\nProvider: ${providerLabel(continuedResult.provider)}\nStatus: ${continuedResult.status || ''}`
        : `Sent follow-up input to session ${continuedResult.id}.\nProvider: ${providerLabel(continuedResult.provider)}\nStatus: ${continuedResult.status || ''}`
    };
  }

  if (plan.summaryIntent === 'runtime_cancel' && cancelledResult?.id) {
    return {
      summary: zh ? 'assistant 已取消 runtime session。' : 'Cancelled the runtime session.',
      message: zh
        ? `已取消 session ${cancelledResult.id}。`
        : `Cancelled session ${cancelledResult.id}.`
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

  if (plan.summaryIntent === 'task_list' && Array.isArray(first)) {
    const lines = first.slice(0, 5).map((entry, index) => (
      `${index + 1}. ${entry.summary || entry.conversation?.title || entry.id} / state=${entry.state}${entry.waitingReason ? ` / waiting=${entry.waitingReason}` : ''}`
    ));
    return {
      summary: zh ? 'assistant 列出了统一任务视图。' : 'Listed unified assistant task records.',
      message: lines.length > 0
        ? lines.join('\n')
        : (zh ? '当前没有可见任务。' : 'No visible tasks.')
    };
  }

  if (plan.summaryIntent === 'task_detail') {
    const task = Array.isArray(first) ? first[0] : first;
    return {
      summary: zh ? 'assistant 返回了当前任务详情。' : 'Returned the current task detail.',
      message: formatTaskRecord(task, zh)
    };
  }

  if (plan.summaryIntent === 'task_summary') {
    const task = Array.isArray(first) ? first[0] : first;
    const conversationContext = toolResults.find((entry) => entry.toolName === 'get_conversation_context')?.result || null;
    return {
      summary: zh ? 'assistant 汇总了当前任务与 conversation 状态。' : 'Summarized current task and conversation state.',
      message: [
        task ? formatTaskRecord(task, zh) : null,
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

  if (plan.summaryIntent === 'fallback_unhandled') {
    return {
      summary: zh ? 'fallback assistant 无法安全处理该自由输入。' : 'The fallback assistant could not safely handle the free-form request.',
      message: zh
        ? '当前没有可用的 LLM assistant 主路径，因此这条自由输入不会由规则 planner 猜测执行。你仍然可以使用明确的控制类指令，例如：start、continue、cancel、status、task list。'
        : 'The LLM-driven assistant path is not currently available, so this free-form request will not be guessed by the deterministic fallback planner. You can still use explicit control commands such as: start, continue, cancel, status, or task list.'
    };
  }

  const task = toolResults.find((entry) => ['list_tasks', 'get_task'].includes(entry.toolName))?.result || null;
  const workspace = toolResults.find((entry) => entry.toolName === 'get_workspace_context')?.result || null;
  return {
    summary: zh ? 'assistant 通过工具返回了基础观测结果。' : 'Returned basic assistant observation using tools.',
    message: task
      ? formatTaskRecord(Array.isArray(task) ? task[0] : task, zh)
      : (workspace
      ? formatWorkspaceSummary(workspace, zh)
      : (zh ? 'assistant 已完成本次工具执行。' : 'The assistant tool run completed.'))
  };
}

function buildWaitingSupervisorReply({ text, runtimeDetail = null, runtimeStatus = '', pendingQuestions = 0, pendingApprovals = 0 } = {}) {
  const zh = isChineseText(text);
  const firstQuestion = Array.isArray(runtimeDetail?.pendingQuestions) ? runtimeDetail.pendingQuestions[0] : null;
  const firstApproval = Array.isArray(runtimeDetail?.pendingApprovals) ? runtimeDetail.pendingApprovals[0] : null;

  if (pendingQuestions > 0 || runtimeStatus === 'waiting_user') {
    return {
      summary: zh ? '等待用户回复' : 'Waiting for user reply',
      message: firstQuestion?.text
        ? (zh
          ? `当前有一个任务在等你回答：${firstQuestion.text}`
          : `One task is waiting for your answer: ${firstQuestion.text}`)
        : (zh
          ? '当前有一个任务在等你补充回答，我收到后会继续推进。'
          : 'One task is waiting for your answer before I can continue.')
    };
  }

  if (pendingApprovals > 0 || runtimeStatus === 'waiting_approval') {
    return {
      summary: zh ? '等待批准' : 'Waiting for approval',
      message: firstApproval?.title || firstApproval?.summary
        ? (zh
          ? `当前有一个任务在等待你的批准：${firstApproval.title || firstApproval.summary}`
          : `One task is waiting for your approval: ${firstApproval.title || firstApproval.summary}`)
        : (zh
          ? '当前有一个任务在等待你的批准，我收到你的决定后会继续推进。'
          : 'One task is waiting for your approval before I can continue.')
    };
  }

  if (['starting', 'running'].includes(runtimeStatus)) {
    return {
      summary: zh ? '后台执行中' : 'Running in background',
      message: zh
        ? '我已经开始推进这个任务，后台完成后会继续汇总结果。'
        : 'I have started the work and will continue once the runtime progresses.'
    };
  }

  return null;
}

export class AssistantRunner {
  constructor({
    runStore = assistantRunStore,
    observationService = assistantObservationService,
    messageService = agentOrchestratorMessageService,
    planner = assistantPlanner,
    toolRegistry = null,
    toolExecutor = null,
    taskViewService = assistantTaskViewService
  } = {}) {
    this.runStore = runStore instanceof AssistantRunStore ? runStore : runStore;
    this.observationService = observationService;
    this.messageService = messageService;
    this.planner = planner instanceof AssistantPlanner ? planner : planner;
    this.taskViewService = taskViewService;
    this.toolRegistry = toolRegistry || createDefaultAssistantToolRegistry({
      observationService: this.observationService,
      messageService: this.messageService,
      taskViewService: this.taskViewService
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
    model = '',
    resume = false
  } = {}) {
    const existingPlan = run?.metadata?.plan || null;
    const plan = resume && existingPlan
      ? existingPlan
      : this.planner.buildPlan({
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
        plan,
        executionBudget: plan.execution || null,
        checkpoint: createAssistantRunCheckpoint({
          plan,
          completedStepCount: Array.isArray(run?.steps) ? run.steps.length : 0,
          toolResults: Array.isArray(run?.metadata?.toolResults) ? run.metadata.toolResults : [],
          lastCompletedStep: Array.isArray(run?.steps) && run.steps.length > 0 ? run.steps[run.steps.length - 1] : null,
          resumable: true
        })
      }
    });

    const toolResults = Array.isArray(currentRun?.metadata?.toolResults)
      ? [...currentRun.metadata.toolResults]
      : [];
    const steps = Array.isArray(currentRun?.steps) ? [...currentRun.steps] : [];
    const relatedRuntimeSessionIds = new Set(currentRun.relatedRuntimeSessionIds || []);
    const startedAt = Date.now();
    const maxToolCalls = Number(plan?.execution?.maxToolCalls || 1);
    const maxDurationMs = Number(plan?.execution?.maxDurationMs || 10_000);
    const completedStepCount = Number(currentRun?.metadata?.checkpoint?.completedStepCount || steps.length || 0);
    const remainingSteps = (plan.steps || []).slice(completedStepCount);

    try {
      for (const step of remainingSteps) {
        if (toolResults.length >= maxToolCalls) {
          throw new Error('Assistant run exceeded tool call budget');
        }
        if ((Date.now() - startedAt) > maxDurationMs) {
          throw new Error('Assistant run exceeded time budget');
        }

        const executed = await this.toolExecutor.executeToolCall({
          toolName: step.toolName,
          input: step.input
        }, {
          conversation,
          run: currentRun,
          planStep: step
        });
        toolResults.push(executed);
        if (executed.result?.id && [
          'start_runtime_task',
          'send_runtime_input',
          'cancel_runtime_session',
          'delegate_to_codex',
          'delegate_to_claude_code',
          'delegate_to_runtime',
          'delegate_task_execution',
          'reuse_or_delegate'
        ].includes(executed.toolName)) {
          relatedRuntimeSessionIds.add(executed.result.id);
        }
        steps.push({
          kind: step.kind || 'tool_call',
          status: 'completed',
          toolName: executed.toolName,
          reason: step.reason || '',
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
            })),
            checkpoint: createAssistantRunCheckpoint({
              plan,
              completedStepCount: steps.length,
              toolResults,
              lastCompletedStep: steps[steps.length - 1] || null,
              resumable: true
            })
          }
        });
      }

      const reply = buildRunnerReply({
        text,
        plan,
        toolResults,
        conversation
      });

      let finalStatus = ASSISTANT_RUN_STATUS.COMPLETED;
      let runtimeDetail = toolResults.find((entry) => (
        ['get_runtime_session', 'summarize_runtime_result'].includes(entry.toolName)
        && entry.result
      ))?.result || null;
      const delegatedResult = toolResults.find((entry) => (
        ['start_runtime_task', 'delegate_to_codex', 'delegate_to_claude_code', 'delegate_to_runtime', 'delegate_task_execution', 'reuse_or_delegate', 'send_runtime_input'].includes(entry.toolName)
        && entry.result
      ))?.result || null;
      if (!runtimeDetail && delegatedResult?.id) {
        runtimeDetail = this.observationService.getRuntimeSessionDetail(delegatedResult.id, {
          eventLimit: 20
        });
      }
      const runtimeStatus = runtimeDetail?.session?.status || runtimeDetail?.status || delegatedResult?.status || '';
      const pendingQuestions = Array.isArray(runtimeDetail?.pendingQuestions)
        ? runtimeDetail.pendingQuestions.length
        : Number(runtimeDetail?.pendingQuestions || 0);
      const pendingApprovals = Array.isArray(runtimeDetail?.pendingApprovals)
        ? runtimeDetail.pendingApprovals.length
        : Number(runtimeDetail?.pendingApprovals || 0);
      let closure = ASSISTANT_RUN_CLOSURE_STATE.EXECUTOR_DONE;
      let stopReason = 'tool_phase_finished';
      const waitingReply = buildWaitingSupervisorReply({
        text,
        runtimeDetail,
        runtimeStatus,
        pendingQuestions,
        pendingApprovals
      });
      if (pendingQuestions > 0 || runtimeStatus === 'waiting_user') {
        finalStatus = ASSISTANT_RUN_STATUS.WAITING_USER;
        closure = ASSISTANT_RUN_CLOSURE_STATE.WAITING_USER;
        stopReason = 'runtime_waiting_user_input';
      } else if (pendingApprovals > 0 || ['waiting_approval', 'starting', 'running'].includes(runtimeStatus)) {
        finalStatus = runtimeStatus === 'waiting_approval'
          ? ASSISTANT_RUN_STATUS.WAITING_USER
          : ASSISTANT_RUN_STATUS.WAITING_RUNTIME;
        closure = runtimeStatus === 'waiting_approval'
          ? ASSISTANT_RUN_CLOSURE_STATE.WAITING_USER
          : ASSISTANT_RUN_CLOSURE_STATE.WAITING_RUNTIME;
        stopReason = runtimeStatus === 'waiting_approval'
          ? 'runtime_waiting_approval'
          : 'runtime_running';
      } else if (reply.message) {
        closure = ASSISTANT_RUN_CLOSURE_STATE.ASSISTANT_DONE;
        stopReason = 'assistant_reply_completed';
      }

      const finalReply = waitingReply || reply;

      const completedRun = this.runStore.save({
        ...currentRun,
        status: finalStatus,
        summary: finalReply.summary,
        result: finalReply.message,
        steps,
        relatedRuntimeSessionIds: [...relatedRuntimeSessionIds],
        metadata: {
          ...(currentRun.metadata || {}),
          toolCount: toolResults.length,
          checkpoint: createAssistantRunCheckpoint({
            plan,
            completedStepCount: steps.length,
            toolResults,
            lastCompletedStep: steps[steps.length - 1] || null,
            resumable: false
          }),
          stopPolicy: {
            status: finalStatus,
            closure,
            reason: stopReason
          }
        }
      });

      return {
        run: completedRun,
        reply: finalReply,
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
          error: error.message || 'Assistant run failed',
          checkpoint: createAssistantRunCheckpoint({
            plan,
            completedStepCount: steps.length,
            toolResults,
            lastCompletedStep: steps[steps.length - 1] || null,
            resumable: true
          })
        }
      });
      throw Object.assign(error, {
        assistantRun: failedRun
      });
    }
  }
}

export default AssistantRunner;
