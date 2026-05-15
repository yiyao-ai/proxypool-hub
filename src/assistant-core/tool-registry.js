import assistantObservationService from './observation-service.js';
import agentOrchestratorMessageService from '../agent-orchestrator/message-service.js';
import assistantConversationControlService from './conversation-control.js';
import assistantTaskViewService from './task-view-service.js';
import assistantClarificationStore from './clarification-store.js';
import assistantWorkspaceStore from './workspace-store.js';
import assistantEpisodeViewService, { AssistantEpisodeViewService } from './episode-view-service.js';
import { resolveReferenceContext } from '../assistant-agent/reference-resolver.js';
import {
  resolveOnceTriggerMs,
  computeNextOccurrenceIso,
  describeFireMoment,
  normalizeDayOfWeekList
} from './schedule-helpers.js';

function normalizeText(value) {
  return String(value || '').trim();
}

export class AssistantToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(definition = {}) {
    const name = normalizeText(definition.name);
    if (!name) {
      throw new Error('tool name is required');
    }
    this.tools.set(name, {
      ...definition,
      name
    });
    return this.tools.get(name);
  }

  get(name) {
    return this.tools.get(normalizeText(name)) || null;
  }

  list() {
    return [...this.tools.values()];
  }
}

export function createDefaultAssistantToolRegistry({
  observationService = assistantObservationService,
  messageService = agentOrchestratorMessageService,
  conversationControlService = assistantConversationControlService,
  taskViewService = assistantTaskViewService,
  clarificationStore = assistantClarificationStore,
  workspaceStore = assistantWorkspaceStore,
  episodeViewService = null
} = {}) {
  const resolvedEpisodeViewService = episodeViewService || new AssistantEpisodeViewService({
    conversationStore: observationService?.conversationStore,
    deliveryStore: observationService?.deliveryStore,
    supervisorTaskStore: taskViewService?.supervisorTaskStore || observationService?.supervisorTaskStore || assistantEpisodeViewService.supervisorTaskStore
  });
  const registry = new AssistantToolRegistry();

  function withAssistantConversationMetadata(input = {}, context = {}) {
    const conversation = context?.conversation || null;
    const baseMetadata = {
      ...((input?.metadata && typeof input.metadata === 'object') ? input.metadata : {}),
      ...(input?.taskId ? { taskId: input.taskId } : {}),
      ...(input?.executionRole ? { executionRole: input.executionRole } : {}),
      ...(input?.role ? { executionRole: input.role } : {})
    };
    if (!conversation?.id) {
      return baseMetadata;
    }
    return {
      ...baseMetadata,
      conversationId: conversation.id,
      source: {
        ...(baseMetadata.source && typeof baseMetadata.source === 'object' ? baseMetadata.source : {}),
        kind: 'assistant',
        conversationId: conversation.id
      }
    };
  }

  function requireConversation(context = {}) {
    const conversation = context?.conversation || null;
    if (!conversation?.id) {
      throw new Error('conversation context is required');
    }
    return conversation;
  }

  registry.register({
    name: 'get_workspace_context',
    description: 'Get workspace-wide runtime and conversation summary.',
    execute: async ({ input = {} } = {}) => observationService.getWorkspaceContext(input)
  });

  registry.register({
    name: 'list_runtime_sessions',
    description: 'List recent runtime sessions.',
    execute: async ({ input = {} } = {}) => observationService.listRuntimeSessions(input)
  });

  registry.register({
    name: 'get_runtime_session',
    description: 'Get runtime session detail.',
    execute: async ({ input = {} } = {}) => observationService.getRuntimeSessionDetail(input.sessionId, input)
  });

  registry.register({
    name: 'list_conversations',
    description: 'List recent conversations.',
    execute: async ({ input = {} } = {}) => observationService.listConversations(input)
  });

  registry.register({
    name: 'get_conversation_context',
    description: 'Get broad conversation context detail. Use when you need deliveries, memory, policy, or active runtime state beyond task-space summaries.',
    execute: async ({ input = {} } = {}) => observationService.getConversationContext(input.conversationId, input)
  });

  registry.register({
    name: 'get_conversation_task_space',
    description: 'Get task-space-first conversation context including focus, active, waiting, and recent tasks. Prefer this before deciding whether to continue a task, delegate a fresh runtime, or ask for clarification.',
    execute: async ({ input = {} } = {}) => taskViewService.getConversationTaskSpace(input.conversationId, input)
  });

  registry.register({
    name: 'start_runtime_task',
    description: 'Start a brand-new runtime task through the shared runtime control service. Use only when the user clearly wants a fresh execution and no existing task should be reused.',
    execute: async ({ input = {}, context = {} } = {}) => messageService.startRuntimeTask({
      provider: input.provider,
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: withAssistantConversationMetadata(input, context)
    })
  });

  registry.register({
    name: 'delegate_to_codex',
    description: 'Delegate a brand-new task to Codex. Use for fresh execution, not for continuing an existing task.',
    execute: async ({ input = {}, context = {} } = {}) => messageService.startRuntimeTask({
      provider: 'codex',
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: withAssistantConversationMetadata(input, context)
    })
  });

  registry.register({
    name: 'delegate_to_claude_code',
    description: 'Delegate a brand-new task to Claude Code. Use for fresh execution, not for continuing an existing task.',
    execute: async ({ input = {}, context = {} } = {}) => messageService.startRuntimeTask({
      provider: 'claude-code',
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: withAssistantConversationMetadata(input, context)
    })
  });

  registry.register({
    name: 'delegate_to_runtime',
    description: 'Delegate a brand-new task to a selected runtime provider. Use only when the user wants new execution rather than follow-up on an existing task.',
    execute: async ({ input = {} } = {}) => {
      const provider = String(input.provider || '').trim() === 'claude-code'
        ? 'claude-code'
        : 'codex';
      const toolName = provider === 'claude-code'
        ? 'delegate_to_claude_code'
        : 'delegate_to_codex';
      return registry.get(toolName).execute({ input });
    }
  });

  registry.register({
    name: 'delegate_task_execution',
    description: 'Start a new execution for a supervisor task. Prefer this when you already know the task identity and want to preserve task ownership while launching fresh execution.',
    execute: async ({ input = {}, context = {} } = {}) => messageService.startRuntimeTask({
      provider: input.provider,
      input: input.task,
      cwd: input.cwd,
      model: input.model,
      metadata: withAssistantConversationMetadata({
        ...input,
        taskId: input.taskId,
        executionRole: input.role
      }, context)
    })
  });

  registry.register({
    name: 'send_runtime_input',
    description: 'Send follow-up input to a known runtime session id. Prefer continue_task when you know the task but do not want to rely on raw runtime session routing.',
    execute: async ({ input = {} } = {}) => messageService.continueRuntimeTask({
      sessionId: input.sessionId,
      input: input.message
    })
  });

  registry.register({
    name: 'continue_task',
    description: 'Continue an existing task by task id or runtime session id. This is the preferred tool for task follow-up when there is a focus task or a single clear waiting task.',
    execute: async ({ input = {} } = {}) => {
      const resolvedTask = input.taskId
        ? taskViewService.getTask(input.taskId)
        : null;
      const sessionId = String(
        resolvedTask?.assistantDomain?.execution?.currentRuntimeSessionId
        || resolvedTask?.task?.latestExecutionId
        || resolvedTask?.runtimeSession?.id
        || resolvedTask?.task?.primaryExecutionId
        || resolvedTask?.task?.runtimeSessionId
        || input.sessionId
        || ''
      ).trim();
      if (!sessionId) {
        throw new Error('continue_task requires taskId or sessionId');
      }
      return messageService.continueRuntimeTask({
        taskId: input.taskId,
        sessionId,
        input: input.message
      });
    }
  });

  registry.register({
    name: 'handoff_execution',
    description: 'Create a structured handoff packet for another execution. Use when one execution should explicitly hand work to another instead of sharing raw transcript state.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = context?.conversation || null;
      return messageService.createExecutionHandoff({
        executionId: input.executionId,
        fromExecutionId: input.fromExecutionId,
        kind: input.kind,
        title: input.title,
        payload: input.payload,
        conversationId: input.conversationId || conversation?.id || ''
      });
    }
  });

  registry.register({
    name: 'consume_execution_handoff',
    description: 'Mark a handoff packet as consumed after the target execution has incorporated it.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = context?.conversation || null;
      return messageService.consumeExecutionHandoff({
        executionId: input.executionId,
        handoffId: input.handoffId,
        conversationId: input.conversationId || conversation?.id || ''
      });
    }
  });

  function buildScheduledTaskReply(scheduledTask, { override = '' } = {}) {
    if (!scheduledTask?.id) return null;
    const tz = String(scheduledTask?.schedule?.timezone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
    const nextFireDescription = describeFireMoment(scheduledTask.nextRunAt, tz);
    const targets = Array.isArray(scheduledTask.notifyTargets) ? scheduledTask.notifyTargets : [];
    return {
      scheduledTaskId: scheduledTask.id,
      title: scheduledTask.title,
      recurrence: scheduledTask.schedule?.recurrence || 'once',
      timezone: tz,
      localTime: scheduledTask.schedule?.localTime || '',
      dayOfWeek: scheduledTask.schedule?.dayOfWeek || [],
      dayOfMonth: scheduledTask.schedule?.dayOfMonth || null,
      month: scheduledTask.schedule?.month || null,
      date: scheduledTask.schedule?.date || '',
      message: scheduledTask.payload?.message || '',
      action: scheduledTask.payload?.action || 'notify_user',
      sharedContext: Boolean(scheduledTask.sharedContext),
      cwd: scheduledTask.cwd || '',
      notifyTargets: targets,
      notifyTargetCount: targets.length,
      scopeConversationId: scheduledTask.scopeConversationId || '',
      state: scheduledTask.state,
      nextRunAtUtc: scheduledTask.nextRunAt,
      nextFireDescription,
      humanReadable: override
        || (nextFireDescription
          ? (targets.length === 0
              ? `下次触发：${nextFireDescription}（后台静默执行，不推送通知）`
              : `下次触发：${nextFireDescription}（${targets.length} 个通知目标）`)
          : '已记录定时任务')
    };
  }

  function validateScheduleInputs(rawSchedule = {}) {
    const recurrence = String(rawSchedule.recurrence || 'once').trim().toLowerCase();
    if (!['once', 'daily', 'weekly', 'monthly', 'yearly'].includes(recurrence)) {
      return {
        ok: false,
        error: `recurrence must be one of once/daily/weekly/monthly/yearly, got "${rawSchedule.recurrence}"`,
        hint: 'Pick the recurrence that matches the user request (e.g. "每天" → daily, "每周一" → weekly, "每月 15 号" → monthly, "每年元旦" → yearly, "5 分钟后" or "今晚 8 点" → once).'
      };
    }
    const timezone = String(rawSchedule.timezone || 'Asia/Shanghai').trim();
    if (!timezone) {
      return { ok: false, error: 'timezone is required', hint: 'Default to "Asia/Shanghai".' };
    }

    const localTime = String(rawSchedule.localTime || '').trim();
    if (recurrence !== 'once' && !localTime) {
      return {
        ok: false,
        error: `recurrence "${recurrence}" requires localTime ("HH:MM")`,
        hint: 'For 每天/每周/每月/每年 reminders the user always names a wall-clock time. Pass localTime: "20:00" (24-hour) and timezone: "Asia/Shanghai".'
      };
    }
    if (localTime && !/^\d{1,2}:\d{2}$/.test(localTime)) {
      return {
        ok: false,
        error: `localTime must be "HH:MM" 24-hour, got "${localTime}"`,
        hint: 'Use 24-hour clock: 8 PM → "20:00", 8:10 PM → "20:10".'
      };
    }

    if (recurrence === 'weekly') {
      try {
        normalizeDayOfWeekList(rawSchedule.dayOfWeek);
      } catch (err) {
        return {
          ok: false,
          error: `recurrence "weekly" requires dayOfWeek: ${err?.message || err}`,
          hint: 'dayOfWeek is "mon"/"tue"/.../"sun" (or 0-6, Sunday=0). For multi-day pass an array like ["mon","wed","fri"].'
        };
      }
    }

    if (recurrence === 'monthly') {
      const dom = Number(rawSchedule.dayOfMonth);
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) {
        return {
          ok: false,
          error: `recurrence "monthly" requires dayOfMonth (1..31), got "${rawSchedule.dayOfMonth}"`,
          hint: 'For "每月 15 号" pass dayOfMonth: 15. Months with fewer days will be skipped automatically.'
        };
      }
    }

    if (recurrence === 'yearly') {
      const month = Number(rawSchedule.month);
      const dom = Number(rawSchedule.dayOfMonth);
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return {
          ok: false,
          error: `recurrence "yearly" requires month (1..12), got "${rawSchedule.month}"`,
          hint: 'For "每年元旦" pass month: 1, dayOfMonth: 1.'
        };
      }
      if (!Number.isInteger(dom) || dom < 1 || dom > 31) {
        return {
          ok: false,
          error: `recurrence "yearly" requires dayOfMonth (1..31), got "${rawSchedule.dayOfMonth}"`,
          hint: 'For "每年元旦" pass month: 1, dayOfMonth: 1.'
        };
      }
    }

    if (recurrence === 'once') {
      const hasDelay = Number(rawSchedule.delayMinutes) > 0 || Number(rawSchedule.delaySeconds) > 0;
      const hasDate = Boolean(String(rawSchedule.date || '').trim());
      const hasLocal = Boolean(localTime);
      if (!hasDelay && !hasLocal) {
        return {
          ok: false,
          error: 'recurrence "once" requires delayMinutes (or delaySeconds), or localTime (optionally with date)',
          hint: 'For "5 分钟后" pass delayMinutes: 5. For "今晚 8 点" pass localTime: "20:00". For "明天早上 8 点" pass date: "YYYY-MM-DD" + localTime: "08:00" (date uses YOUR timezone, read it from <wall_clock> in the prompt).'
        };
      }
      if (hasDate && !hasLocal) {
        return {
          ok: false,
          error: 'recurrence "once" with `date` also needs localTime',
          hint: 'Pair date with localTime, e.g. date: "2026-06-01" + localTime: "09:00".'
        };
      }
    } else {
      // Recurring schedules MUST NOT mix in one-shot timing hints — that
      // combination is the historical bug that pinned daily reminders to
      // "creation time + 1 second" forever.
      if (Number(rawSchedule.delayMinutes) > 0 || Number(rawSchedule.delaySeconds) > 0) {
        return {
          ok: false,
          error: `delayMinutes/delaySeconds cannot be combined with recurrence "${recurrence}"`,
          hint: `For "${recurrence}" reminders pass only localTime (and dayOfWeek/dayOfMonth/month as needed). Drop delayMinutes/delaySeconds entirely.`
        };
      }
      if (String(rawSchedule.date || '').trim()) {
        return {
          ok: false,
          error: `\`date\` is only valid for recurrence "once"`,
          hint: 'For recurring schedules the date is implied by recurrence + dayOfWeek/dayOfMonth/month. Drop `date`.'
        };
      }
    }

    return { ok: true };
  }

  function buildScheduleFromInput(input = {}) {
    // Accept fields either flat on the input or nested under input.schedule
    // — the LLM tends to mix the two when it's been corrected mid-thought.
    const nested = input.schedule && typeof input.schedule === 'object' ? input.schedule : {};
    return {
      recurrence: String(input.recurrence || nested.recurrence || 'once').trim().toLowerCase(),
      timezone: String(input.timezone || nested.timezone || 'Asia/Shanghai').trim(),
      localTime: String(input.localTime || nested.localTime || '').trim(),
      dayOfWeek: input.dayOfWeek != null ? input.dayOfWeek : nested.dayOfWeek,
      dayOfMonth: input.dayOfMonth != null ? input.dayOfMonth : nested.dayOfMonth,
      month: input.month != null ? input.month : nested.month,
      date: String(input.date || nested.date || '').trim(),
      delayMinutes: input.delayMinutes != null ? input.delayMinutes : nested.delayMinutes,
      delaySeconds: input.delaySeconds != null ? input.delaySeconds : nested.delaySeconds
    };
  }

  registry.register({
    name: 'create_scheduled_task',
    description: '创建一个定时提醒/任务。声明式参数，不要做时区或 UTC 计算。必填：title 描述、message（payload.message）提醒文本、recurrence（once/daily/weekly/monthly/yearly）。timezone 默认 Asia/Shanghai。\n— recurrence="once"：传 delayMinutes（"5 分钟后"）或 localTime（"今晚 8 点" → "20:00"，工具会自动算今天还是明天）。需要特定日期再加 date: "YYYY-MM-DD"（用户时区）。\n— recurrence="daily"：必传 localTime。\n— recurrence="weekly"：必传 localTime + dayOfWeek（"mon".."sun" 或 0-6 或数组 ["mon","wed"]）。\n— recurrence="monthly"：必传 localTime + dayOfMonth（1-31，月份天数不够会自动跳过）。\n— recurrence="yearly"：必传 localTime + month (1-12) + dayOfMonth (1-31)。\n严禁组合：循环类型 + delayMinutes/delaySeconds/date 同时出现（旧 bug 源头）。\nconversationId 由系统自动注入。创建成功后，把工具返回的 humanReadable 字段原样转述给用户即可，不要再自己做时区换算。',
    execute: async ({ input = {}, context = {} } = {}) => {
      const trimmedTitle = String(input?.title || '').trim();
      const payload = input?.payload && typeof input.payload === 'object' ? { ...input.payload } : null;
      const payloadMessage = String(payload?.message || input?.message || '').trim();
      if (!trimmedTitle && !payloadMessage) {
        return {
          kind: 'tool_error',
          error: 'create_scheduled_task requires a non-empty title or message.',
          recoverable: true,
          hint: 'Pass title="<short description>" (e.g. "提醒吃晚饭") and payload.message="<完整提醒文本>".'
        };
      }

      const scheduleSpec = buildScheduleFromInput(input);
      const validation = validateScheduleInputs(scheduleSpec);
      if (!validation.ok) {
        return {
          kind: 'tool_error',
          error: validation.error,
          recoverable: true,
          hint: validation.hint
        };
      }

      // Compute initial nextRunAt here so we can return a structured
      // "next fire" descriptor even before the store-coordinator builds it
      // again (the coordinator will reuse what we pass).
      let nextRunAtIso = '';
      try {
        if (scheduleSpec.recurrence === 'once') {
          const ms = resolveOnceTriggerMs(scheduleSpec);
          nextRunAtIso = new Date(ms).toISOString();
        } else {
          nextRunAtIso = computeNextOccurrenceIso(scheduleSpec);
        }
      } catch (err) {
        return {
          kind: 'tool_error',
          error: `Could not compute next fire time: ${err?.message || err}`,
          recoverable: true,
          hint: 'Double-check localTime/dayOfWeek/dayOfMonth/month/timezone are present and consistent for the chosen recurrence.'
        };
      }

      // Build notifyTargets[]:
      //   - LLM may pass `notifyTargets: [{kind:'conversation', conversationId}]`
      //   - LLM may pass `notifyConversationIds: [...]`
      //   - LLM may pass legacy `conversationId` (single)
      //   - We auto-append the current conversation when the LLM didn't say
      //     otherwise (most reminders should land where the user is right now)
      const currentConvId = String(context?.conversation?.id || '').trim();
      const notifyTargets = [];
      const seenTargets = new Set();
      const pushTarget = (cid) => {
        const id = String(cid || '').trim();
        if (!id || seenTargets.has(id)) return;
        seenTargets.add(id);
        notifyTargets.push({ kind: 'conversation', conversationId: id });
      };
      if (Array.isArray(input?.notifyTargets)) {
        for (const t of input.notifyTargets) pushTarget(t?.conversationId);
      }
      if (Array.isArray(input?.notifyConversationIds)) {
        for (const cid of input.notifyConversationIds) pushTarget(cid);
      }
      if (input?.conversationId) pushTarget(input.conversationId);
      const llmPassedAnyTarget = notifyTargets.length > 0;
      if (!llmPassedAnyTarget && currentConvId) {
        // Auto-bind to the current conversation only if the LLM didn't
        // explicitly say otherwise. Setting `notifyTargets: []` explicitly
        // means "background-only" — respect that.
        const explicitEmpty = Array.isArray(input?.notifyTargets) && input.notifyTargets.length === 0;
        if (!explicitEmpty) pushTarget(currentConvId);
      }

      const action = String(input?.action || payload?.action || 'notify_user').trim();
      if (!['notify_user', 'invoke_assistant'].includes(action)) {
        return {
          kind: 'tool_error',
          error: `action must be "notify_user" or "invoke_assistant", got "${action}"`,
          recoverable: true,
          hint: 'For static reminders use action="notify_user". For "wake the assistant" use action="invoke_assistant" (the message becomes the instruction).'
        };
      }
      if (action === 'notify_user' && notifyTargets.length === 0) {
        return {
          kind: 'tool_error',
          error: 'notify_user requires at least one notify target',
          recoverable: true,
          hint: 'Add notifyConversationIds: ["<conversation-id>"] or call from inside a conversation context.'
        };
      }

      const resolvedPayload = {
        action,
        ...(payload || {}),
        ...(payloadMessage ? { message: payloadMessage } : {})
      };

      const cleanedSchedule = {
        recurrence: scheduleSpec.recurrence,
        timezone: scheduleSpec.timezone,
        localTime: scheduleSpec.localTime,
        dayOfWeek: scheduleSpec.dayOfWeek,
        dayOfMonth: scheduleSpec.dayOfMonth,
        month: scheduleSpec.month,
        date: scheduleSpec.date
      };

      const created = messageService.createScheduledTask({
        title: trimmedTitle || payloadMessage.slice(0, 80),
        kind: 'reminder',
        schedule: cleanedSchedule,
        payload: resolvedPayload,
        notifyTargets,
        sharedContext: Boolean(input?.sharedContext),
        cwd: String(input?.cwd || '').trim(),
        personId: input?.personId,
        projectId: input?.projectId,
        taskId: input?.taskId,
        executionId: input?.executionId,
        source: input?.source || 'assistant',
        metadata: input?.metadata,
        nextRunAt: nextRunAtIso
      });

      return buildScheduledTaskReply(created);
    }
  });

  registry.register({
    name: 'update_scheduled_task',
    description: '修改一个已存在的定时任务。按 scheduledTaskId 找到任务，对要修改的字段重新赋值（其它字段保持不变）。可改字段：title、message（提醒内容）、recurrence、timezone、localTime、dayOfWeek、dayOfMonth、month、date。修改后工具会自动重算下次触发时间并把任务恢复为 scheduled 状态。',
    execute: async ({ input = {} } = {}) => {
      const id = String(input?.scheduledTaskId || input?.id || '').trim();
      if (!id) {
        return {
          kind: 'tool_error',
          error: 'update_scheduled_task requires scheduledTaskId',
          recoverable: true,
          hint: 'Pass scheduledTaskId returned by an earlier create_scheduled_task call. Use list_scheduled_tasks if you do not remember the id.'
        };
      }

      const wantsScheduleChange = (
        input.recurrence !== undefined
        || input.timezone !== undefined
        || input.localTime !== undefined
        || input.dayOfWeek !== undefined
        || input.dayOfMonth !== undefined
        || input.month !== undefined
        || input.date !== undefined
        || (input.schedule && typeof input.schedule === 'object')
      );

      let schedulePatch = null;
      if (wantsScheduleChange) {
        const current = messageService.stateCoordinator?.scheduledTaskStore?.get?.(id) || null;
        if (!current?.id) {
          return {
            kind: 'tool_error',
            error: 'scheduled task not found',
            recoverable: true,
            hint: 'Verify the scheduledTaskId with list_scheduled_tasks.'
          };
        }
        const merged = {
          recurrence: input.recurrence != null
            ? String(input.recurrence).trim().toLowerCase()
            : current.schedule?.recurrence || 'once',
          timezone: input.timezone != null
            ? String(input.timezone).trim()
            : current.schedule?.timezone || 'Asia/Shanghai',
          localTime: input.localTime != null
            ? String(input.localTime).trim()
            : current.schedule?.localTime || '',
          dayOfWeek: input.dayOfWeek !== undefined ? input.dayOfWeek : current.schedule?.dayOfWeek,
          dayOfMonth: input.dayOfMonth !== undefined ? input.dayOfMonth : current.schedule?.dayOfMonth,
          month: input.month !== undefined ? input.month : current.schedule?.month,
          date: input.date != null ? String(input.date).trim() : current.schedule?.date || '',
          delayMinutes: input.delayMinutes,
          delaySeconds: input.delaySeconds
        };
        const validation = validateScheduleInputs(merged);
        if (!validation.ok) {
          return {
            kind: 'tool_error',
            error: validation.error,
            recoverable: true,
            hint: validation.hint
          };
        }
        schedulePatch = {
          recurrence: merged.recurrence,
          timezone: merged.timezone,
          localTime: merged.localTime,
          dayOfWeek: merged.dayOfWeek,
          dayOfMonth: merged.dayOfMonth,
          month: merged.month,
          date: merged.date,
          delayMinutes: merged.delayMinutes,
          delaySeconds: merged.delaySeconds
        };
      }

      const payloadPatch = {};
      const messageText = input.message != null
        ? String(input.message).trim()
        : (input.payload && typeof input.payload === 'object' ? String(input.payload.message || '').trim() : '');
      if (messageText) payloadPatch.message = messageText;
      if (input.action != null) payloadPatch.action = String(input.action).trim();
      if (input.payload && typeof input.payload === 'object') {
        for (const key of Object.keys(input.payload)) {
          if (key === 'message') continue;
          payloadPatch[key] = input.payload[key];
        }
      }

      // Allow notifyTargets / sharedContext / cwd patching.
      const wantsNotifyTargets = Array.isArray(input?.notifyTargets) || Array.isArray(input?.notifyConversationIds);
      let notifyTargets;
      if (wantsNotifyTargets) {
        notifyTargets = [];
        const seen = new Set();
        const push = (cid) => {
          const id = String(cid || '').trim();
          if (!id || seen.has(id)) return;
          seen.add(id);
          notifyTargets.push({ kind: 'conversation', conversationId: id });
        };
        if (Array.isArray(input?.notifyTargets)) {
          for (const t of input.notifyTargets) push(t?.conversationId);
        }
        if (Array.isArray(input?.notifyConversationIds)) {
          for (const cid of input.notifyConversationIds) push(cid);
        }
      }

      try {
        const updated = messageService.updateScheduledTask({
          id,
          title: input.title,
          schedule: schedulePatch,
          payload: Object.keys(payloadPatch).length > 0 ? payloadPatch : undefined,
          notifyTargets,
          sharedContext: typeof input?.sharedContext === 'boolean' ? input.sharedContext : undefined,
          cwd: input?.cwd != null ? String(input.cwd).trim() : undefined
        });
        return buildScheduledTaskReply(updated, { override: '已更新定时任务' });
      } catch (err) {
        return {
          kind: 'tool_error',
          error: String(err?.message || err),
          recoverable: true,
          hint: 'If the task is in a terminal state (completed/cancelled), create a new one instead.'
        };
      }
    }
  });

  registry.register({
    name: 'cancel_scheduled_task',
    description: '取消一个已存在的定时任务（按 scheduledTaskId）。任务状态会变成 cancelled，不再触发。',
    execute: async ({ input = {} } = {}) => {
      const id = String(input?.scheduledTaskId || input?.id || '').trim();
      if (!id) {
        return {
          kind: 'tool_error',
          error: 'cancel_scheduled_task requires scheduledTaskId',
          recoverable: true,
          hint: 'Use list_scheduled_tasks to find the id if you do not remember it.'
        };
      }
      try {
        const cancelled = messageService.cancelScheduledTask({
          id,
          reason: String(input?.reason || '').trim()
        });
        return {
          scheduledTaskId: cancelled.id,
          state: cancelled.state,
          humanReadable: '已取消该定时任务，不会再触发。'
        };
      } catch (err) {
        return {
          kind: 'tool_error',
          error: String(err?.message || err),
          recoverable: true,
          hint: 'Verify the scheduledTaskId with list_scheduled_tasks.'
        };
      }
    }
  });

  registry.register({
    name: 'list_scheduled_tasks',
    description: '列出当前会话下还在生效的定时任务（state=scheduled/running/paused）。可选 includeCompleted=true 时附带 completed/cancelled/failed 的历史记录。conversationId 由系统自动注入。当用户问"我都有什么提醒/我有几个定时任务"时使用。',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversationId = String(
        input?.conversationId
        || context?.conversation?.id
        || ''
      ).trim();
      const list = messageService.listScheduledTasks({
        conversationId,
        includeCompleted: input?.includeCompleted === true,
        limit: Math.min(Math.max(Number(input?.limit || 50), 1), 200)
      });
      return {
        count: list.length,
        items: list.map((entry) => buildScheduledTaskReply(entry))
      };
    }
  });

  registry.register({
    name: 'list_scheduled_task_runs',
    description: '查看某个定时任务的运行历史。每次到点触发都是一个 run。返回最近 N 次的触发时间、最终状态（completed/failed）、摘要、错误信息。用户问"上次那个任务跑得怎么样/有没有失败"时使用。',
    execute: async ({ input = {} } = {}) => {
      const scheduledTaskId = String(input?.scheduledTaskId || input?.taskId || '').trim();
      if (!scheduledTaskId) {
        return {
          kind: 'tool_error',
          error: 'list_scheduled_task_runs requires scheduledTaskId',
          recoverable: true,
          hint: 'Use list_scheduled_tasks first to find the id.'
        };
      }
      const limit = Math.min(Math.max(Number(input?.limit || 10), 1), 100);
      const ledger = messageService.stateCoordinator?.episodeLedger;
      if (!ledger?.list) {
        return { scheduledTaskId, runs: [], count: 0 };
      }
      const episodes = ledger.list({
        limit: limit * 4,
        sortBy: 'createdAt',
        predicate: (entry) => {
          if (String(entry?.payload?.scheduledTaskId || '').trim() !== scheduledTaskId) return false;
          return [
            'scheduled_task.triggered',
            'scheduled_task.completed',
            'scheduled_task.failed',
            'scheduled_task.compute_next_failed'
          ].includes(String(entry?.kind || ''));
        }
      });
      // Group triggered → success/fail by createdAt proximity (latest fire wins).
      const runs = [];
      const seenTriggers = new Set();
      for (const ep of episodes) {
        if (ep.kind === 'scheduled_task.triggered') {
          if (seenTriggers.has(ep.createdAt)) continue;
          seenTriggers.add(ep.createdAt);
          const outcome = episodes.find((other) => (
            other !== ep
            && Date.parse(other.createdAt) >= Date.parse(ep.createdAt)
            && Date.parse(other.createdAt) - Date.parse(ep.createdAt) < 10 * 60 * 1000
            && ['scheduled_task.completed', 'scheduled_task.failed', 'scheduled_task.compute_next_failed'].includes(other.kind)
          ));
          runs.push({
            firedAt: ep.createdAt,
            state: outcome?.kind === 'scheduled_task.completed' ? 'completed'
              : outcome?.kind === 'scheduled_task.failed' ? 'failed'
              : outcome?.kind === 'scheduled_task.compute_next_failed' ? 'failed_compute_next'
              : 'unknown',
            summary: String(outcome?.payload?.lastResultPreview || '').slice(0, 300),
            error: String(outcome?.payload?.lastError || '').slice(0, 300)
          });
          if (runs.length >= limit) break;
        }
      }
      return { scheduledTaskId, count: runs.length, runs };
    }
  });

  registry.register({
    name: 'find_recent_scheduled_task_notifications',
    description: '查询最近一段时间内（默认 30 分钟）向当前会话推送过的定时任务通知。当用户说"刚才那个/继续上面的/重新跑一下刚才那个任务"等指代型语句时，用这个工具定位他在说的是哪个定时任务。conversationId 由系统自动注入。',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversationId = String(
        input?.conversationId
        || context?.conversation?.id
        || ''
      ).trim();
      if (!conversationId) {
        return {
          kind: 'tool_error',
          error: 'find_recent_scheduled_task_notifications requires conversationId',
          recoverable: true,
          hint: 'This tool only works inside a conversation context.'
        };
      }
      const withinMinutes = Math.min(Math.max(Number(input?.withinMinutes || 30), 1), 24 * 60);
      const sinceMs = Date.now() - withinMinutes * 60 * 1000;
      const deliveryStore = observationService?.deliveryStore;
      if (!deliveryStore?.listByConversation) {
        return { conversationId, notifications: [], count: 0 };
      }
      const all = deliveryStore.listByConversation(conversationId, { limit: 200 });
      const notifications = all.filter((entry) => {
        const ts = Date.parse(entry?.createdAt || '');
        if (!Number.isFinite(ts) || ts < sinceMs) return false;
        const kind = String(entry?.payload?.kind || '');
        return kind === 'scheduled_task_notification' || kind === 'scheduled_reminder' || kind === 'scheduled_invoke_result';
      }).slice(0, 10);
      const taskStore = messageService.stateCoordinator?.scheduledTaskStore;
      const enriched = notifications.map((entry) => {
        const stid = String(entry?.payload?.scheduledTaskId || '').trim();
        const task = stid && taskStore?.get ? taskStore.get(stid) : null;
        return {
          notifiedAt: entry.createdAt,
          scheduledTaskId: stid,
          scheduledTaskRunId: String(entry?.payload?.scheduledTaskRunId || ''),
          title: task?.title || '',
          recurrence: task?.schedule?.recurrence || '',
          textPreview: String(entry?.payload?.text || '').slice(0, 200),
          isFailure: Boolean(entry?.payload?.isFailure)
        };
      });
      return {
        conversationId,
        withinMinutes,
        count: enriched.length,
        notifications: enriched
      };
    }
  });

  registry.register({
    name: 'reuse_or_delegate',
    description: 'Compatibility tool that reuses a runtime session when explicitly provided, otherwise starts a new runtime task. Prefer continue_task or delegate_to_runtime when the intent is clear.',
    execute: async ({ input = {}, context = {} } = {}) => {
      if (input.sessionId && input.message) {
        return messageService.continueRuntimeTask({
          sessionId: input.sessionId,
          input: input.message
        });
      }
      return messageService.startRuntimeTask({
        provider: input.provider,
        input: input.task,
        cwd: input.cwd,
        model: input.model,
        metadata: withAssistantConversationMetadata(input, context)
      });
    }
  });

  registry.register({
    name: 'cancel_runtime_session',
    description: 'Cancel a runtime session.',
    execute: async ({ input = {} } = {}) => messageService.cancelRuntimeSession({
      sessionId: input.sessionId
    })
  });

  registry.register({
    name: 'reset_conversation_binding',
    description: 'Reset conversation binding to the current runtime session.',
    execute: async ({ input = {} } = {}) => conversationControlService.resetConversationBinding({
      conversationId: input.conversationId
    })
  });

  registry.register({
    name: 'resolve_runtime_approval',
    description: 'Resolve a pending runtime approval request. Pass remember="session" if the user said something like "允许后续所有操作 / 本会话同意 / from now on" — this records a wildcard policy so future approvals of the same kind auto-pass within this runtime session. Pass remember="conversation" if the user explicitly bound the permission to the current conversation ("这次对话都同意"). Default remember="none" (one-shot approval). Only valid when decision="approve".',
    execute: async ({ input = {}, context = {} } = {}) => messageService.resolveApproval({
      sessionId: input.sessionId,
      approvalId: input.approvalId,
      decision: input.decision,
      remember: input.remember,
      conversationId: input.conversationId || context?.conversation?.id || '',
      conversation: context?.conversation || null,
      metadata: context?.metadata || {}
    })
  });

  registry.register({
    name: 'answer_runtime_question',
    description: 'Answer a runtime question.',
    execute: async ({ input = {} } = {}) => messageService.answerQuestion({
      sessionId: input.sessionId,
      questionId: input.questionId,
      answer: input.answer
    })
  });

  registry.register({
    name: 'cancel_pending_question',
    description: 'Cancel a pending runtime question when the user is clearly switching intent and the old question should no longer block routing.',
    execute: async ({ input = {} } = {}) => messageService.cancelPendingQuestion({
      sessionId: input.sessionId,
      questionId: input.questionId,
      reason: input.reason
    })
  });

  registry.register({
    name: 'ask_user',
    description: 'Ask a structured clarification question, persist a PendingClarification record, and mark the conversation as waiting for clarification.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = requireConversation(context);
      const clarification = clarificationStore.create({
        conversationId: conversation.id,
        question: input.question,
        candidates: Array.isArray(input.candidates) ? input.candidates : [],
        ttlSec: input.ttlSec
      });
      const patchedConversation = conversationControlService.conversationStore.patch(conversation.id, {
        lastPendingClarificationId: clarification.id
      }) || conversation;
      return {
        clarificationId: clarification.id,
        question: clarification.question,
        candidates: clarification.candidates,
        ttlSec: clarification.ttlSec,
        conversationId: conversation.id,
        conversation: patchedConversation
      };
    }
  });

  registry.register({
    name: 'resolve_clarification',
    description: 'Resolve a pending clarification by selecting a candidate or recording a free-text answer.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = requireConversation(context);
      const clarification = clarificationStore.answer(input.clarificationId, {
        selectedCandidateId: input.candidateId,
        freeTextAnswer: input.freeText
      });
      if (!clarification) {
        throw new Error('clarification not found');
      }
      if (clarification.conversationId !== conversation.id) {
        throw new Error('clarification does not belong to this conversation');
      }
      const patchedConversation = conversationControlService.conversationStore.patch(conversation.id, {
        lastPendingClarificationId: null
      }) || conversation;
      return {
        clarificationId: clarification.id,
        status: clarification.status,
        resolution: clarification.resolution,
        conversationId: clarification.conversationId,
        conversation: patchedConversation
      };
    }
  });

  registry.register({
    name: 'cancel_pending_clarification',
    description: 'Cancel an assistant-level pending clarification when it is no longer relevant.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = requireConversation(context);
      const clarification = clarificationStore.cancel(input.clarificationId);
      if (!clarification) {
        throw new Error('clarification not found');
      }
      if (clarification.conversationId !== conversation.id) {
        throw new Error('clarification does not belong to this conversation');
      }
      const patchedConversation = conversationControlService.conversationStore.patch(conversation.id, {
        lastPendingClarificationId: null
      }) || conversation;
      return {
        clarificationId: clarification.id,
        status: clarification.status,
        conversationId: clarification.conversationId,
        reason: normalizeText(input.reason),
        conversation: patchedConversation
      };
    }
  });

  registry.register({
    name: 'summarize_runtime_result',
    description: 'Summarize a runtime session result using observation data.',
    execute: async ({ input = {} } = {}) => {
      const detail = await observationService.getRuntimeSessionDetail(input.sessionId, {
        eventLimit: input.eventLimit || 20,
        rememberMemory: false
      });
      if (!detail) return null;
      return {
        sessionId: detail.session?.id || '',
        provider: detail.session?.provider || '',
        status: detail.session?.status || '',
        title: detail.task?.title || detail.session?.title || '',
        summary: detail.task?.summary || detail.session?.summary || '',
        result: detail.task?.result || '',
        pendingApprovals: Array.isArray(detail.pendingApprovals) ? detail.pendingApprovals.length : 0,
        pendingQuestions: Array.isArray(detail.pendingQuestions) ? detail.pendingQuestions.length : 0
      };
    }
  });

  registry.register({
    name: 'list_tasks',
    description: 'List unified assistant task records across conversations. Use for broad search or cross-conversation status, not as a replacement for get_conversation_task_space.',
    execute: async ({ input = {} } = {}) => taskViewService.listTasks(input)
  });

  registry.register({
    name: 'get_task',
    description: 'Get a unified assistant task record by task id. Use when a specific task has already been identified.',
    execute: async ({ input = {} } = {}) => taskViewService.getTask(input.taskId)
  });

  registry.register({
    name: 'get_task_by_runtime_session',
    description: 'Resolve a task record from a runtime session id. Use when you know a runtime session id but need the task object that owns it.',
    execute: async ({ input = {} } = {}) => {
      const sessionId = String(input.sessionId || '').trim();
      if (!sessionId) return null;
      const tasks = taskViewService.listTasks({
        conversationId: input.conversationId,
        limit: Math.max(Number(input.limit || 50), 1)
      });
      return tasks.find((entry) => String(entry?.runtimeSession?.id || entry?.task?.runtimeSessionId || '').trim() === sessionId) || null;
    }
  });

  registry.register({
    name: 'list_project_artifacts',
    description: 'Return project-level artifacts from workspace summaries.',
    execute: async ({ input = {} } = {}) => {
      const context = observationService.getWorkspaceContext({
        runtimeLimit: input.runtimeLimit || 10,
        conversationLimit: input.conversationLimit || 10
      });
      return {
        runtimeSessions: context.runtimeSessions || [],
        conversations: context.conversations || []
      };
    }
  });

  registry.register({
    name: 'search_task_and_conversation_memory',
    description: 'Search task and conversation summaries in the current workspace.',
    execute: async ({ input = {} } = {}) => observationService.searchProjectMemory({
      query: input.query,
      limit: input.limit || 10
    })
  });

  registry.register({
    name: 'recall',
    description: 'Recall relevant past task, conversation, and delivery episodes. Use for "earlier", "last week", or historical follow-up requests before deciding whether to continue or ask for clarification.',
    execute: async ({ input = {}, context = {} } = {}) => resolvedEpisodeViewService.recall({
      query: input.query,
      scope: input.scope || 'workspace',
      conversationId: input.conversationId || context?.conversation?.id || '',
      limit: input.limit || 10
    })
  });

  registry.register({
    name: 'find_task_by_keyword',
    description: 'Find tasks by keyword across task title, summary, cwd, cwd basename, and remembered aliases. Prefer this before asking the user when you have a concrete project or task phrase.',
    execute: async ({ input = {} } = {}) => {
      const query = normalizeText(input.query);
      if (!query) {
        throw new Error('query is required');
      }
      const tasks = observationService.getRecentTasks({
        conversationId: input.conversationId,
        limit: Math.max(Number(input.limit || 10), 1)
      });
      const normalizedQuery = query.toLowerCase();
      return tasks.filter((entry) => (
        [
          entry.title,
          entry.summary,
          entry.result,
          entry.error,
          entry.cwd,
          entry.cwdBasename
        ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery))
      )).slice(0, Math.max(Number(input.limit || 10), 1));
    }
  });

  registry.register({
    name: 'list_known_cwds',
    description: 'List recently known cwd records, including aliases and linked task ids.',
    execute: async ({ input = {} } = {}) => observationService.getKnownCwds({
      recent: input.recent !== false,
      limit: input.limit || 10
    })
  });

  registry.register({
    name: 'get_cwd_info',
    description: 'Get detailed info for a known cwd, including aliases and linked tasks. Use after list_known_cwds or when the user names a specific project path.',
    execute: async ({ input = {} } = {}) => observationService.getCwdInfo({
      cwd: input.cwd,
      workspaceId: input.workspaceId
    })
  });

  registry.register({
    name: 'add_cwd_alias',
    description: 'Add a user-facing alias to a known cwd record. Use only when the user has actually referred to that cwd with this alias.',
    execute: async ({ input = {} } = {}) => {
      const target = input.workspaceId
        ? workspaceStore.list({ limit: 500 }).find((entry) => String(entry?.id || '').trim() === normalizeText(input.workspaceId)) || null
        : workspaceStore.getByRef(input.cwd);
      if (!target) {
        throw new Error('workspace not found');
      }
      return workspaceStore.upsert({
        workspaceRef: target.workspaceRef,
        patch: {
          aliases: [input.alias]
        }
      });
    }
  });

  registry.register({
    name: 'link_task_to_conversation',
    description: 'Adopt an existing task into the current conversation. Use only when the user explicitly wants to take over or continue a task here from another conversation.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversation = requireConversation(context);
      const taskRecord = taskViewService.getTask(input.taskId);
      const persistedTask = taskRecord?.task?.id
        ? taskRecord.task
        : taskViewService.supervisorTaskStore.get(input.taskId);
      if (!persistedTask?.id) {
        throw new Error('task not found');
      }
      const runtimeSessionId = String(
        input.runtimeSessionId
        || taskRecord?.runtimeSession?.id
        || persistedTask?.latestExecutionId
        || persistedTask?.primaryExecutionId
        || persistedTask?.runtimeSessionId
        || persistedTask?.metadata?.latestExecutionId
        || persistedTask?.metadata?.runtimeSessionId
        || ''
      ).trim();
      const patchedConversation = conversationControlService.linkTaskToConversation({
        conversationId: conversation.id,
        taskId: persistedTask.id,
        runtimeSessionId,
        metadata: {
          supervisor: {
            ...((conversation?.metadata?.supervisor && typeof conversation.metadata.supervisor === 'object')
              ? conversation.metadata.supervisor
              : {})
          }
        }
      });
      if (!patchedConversation) {
        throw new Error('failed to link task to conversation');
      }
      if (persistedTask?.id) {
        taskViewService.supervisorTaskStore.save({
          ...persistedTask,
          lastConversationId: conversation.id
        });
      }
      return {
        conversationId: conversation.id,
        taskId: persistedTask.id,
        runtimeSessionId,
        conversation: patchedConversation
      };
    }
  });

  registry.register({
    name: 'link_session_to_task',
    description: 'Adopt an existing runtime session into a supervisor task by appending it to executionIds. Use only as a data-repair operation when a session was misrouted (e.g., user reports a session belongs to a different task than the system thinks). Will not change primaryExecutionId; the new sessionId becomes latestExecutionId.',
    execute: async ({ input = {} } = {}) => {
      const taskId = String(input.taskId || '').trim();
      const sessionId = String(input.sessionId || '').trim();
      if (!taskId) {
        throw new Error('taskId is required');
      }
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      const persistedTask = taskViewService.supervisorTaskStore.get(taskId);
      if (!persistedTask?.id) {
        throw new Error('task not found');
      }
      const previousExecutionIds = Array.isArray(persistedTask.executionIds)
        ? persistedTask.executionIds
        : [];
      if (previousExecutionIds.includes(sessionId)) {
        return {
          taskId: persistedTask.id,
          sessionId,
          alreadyLinked: true,
          executionIds: previousExecutionIds
        };
      }
      const next = taskViewService.supervisorTaskStore.save({
        ...persistedTask,
        executionIds: [...previousExecutionIds, sessionId],
        lastUpdateAt: new Date().toISOString(),
        metadata: {
          ...(persistedTask.metadata || {}),
          latestExecutionId: sessionId,
          runtimeSessionId: sessionId
        }
      });
      return {
        taskId: next.id,
        sessionId,
        alreadyLinked: false,
        executionIds: next.executionIds
      };
    }
  });

  registry.register({
    name: 'resolve_reference',
    description: 'Resolve a phrase into likely task or cwd candidates. Use when the built-in reference_resolution block is ambiguous and you want an explicit re-check before acting.',
    execute: async ({ input = {}, context = {} } = {}) => {
      const conversationId = input.conversationId || context?.conversation?.id || '';
      const taskSpace = conversationId
        ? taskViewService.getConversationTaskSpace(conversationId, {
            activeLimit: 5,
            waitingLimit: 5,
            recentLimit: 8
          })
        : null;
      const workspaceContext = observationService.getWorkspaceContext({
        runtimeLimit: 6,
        conversationLimit: 6
      });
      const conversationContext = conversationId
        ? observationService.getConversationContext(conversationId, {
            deliveryLimit: 8
          })
        : null;
      return resolveReferenceContext({
        text: input.phrase,
        taskSpace,
        workspaceContext,
        conversationContext
      });
    }
  });

  registry.register({
    name: 'search_project_memory',
    description: 'Deprecated alias for search_task_and_conversation_memory.',
    execute: async ({ input = {} } = {}) => registry.get('search_task_and_conversation_memory').execute({ input })
  });

  return registry;
}

export default createDefaultAssistantToolRegistry;

