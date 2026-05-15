import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantToolRegistry, createDefaultAssistantToolRegistry } from '../../src/assistant-core/tool-registry.js';
import { AssistantToolExecutor } from '../../src/assistant-core/tool-executor.js';

test('AssistantToolExecutor surfaces policy denial as a recoverable tool result instead of throwing', async () => {
  const registry = new AssistantToolRegistry();
  registry.register({
    name: 'start_runtime_task',
    execute: async () => ({ id: 'session-1' })
  });

  const executor = new AssistantToolExecutor({
    toolRegistry: registry,
    policyService: {
      canExecuteToolCall() {
        return {
          allowed: false,
          reason: 'tool_not_permitted_by_policy'
        };
      }
    }
  });

  const result = await executor.executeToolCall({
    toolName: 'start_runtime_task',
    input: { provider: 'codex', task: 'inspect repo' }
  }, {
    conversation: null,
    run: { metadata: {} }
  });

  assert.equal(result.success, false);
  assert.equal(result.result?.kind, 'policy_block');
  assert.equal(result.result?.recoverable, true);
  assert.equal(result.result?.reason, 'tool_not_permitted_by_policy');
  assert.match(String(result.summary || ''), /blocked by policy/i);
});

test('AssistantToolExecutor returns a structured policy block when confirmation is required', async () => {
  const registry = new AssistantToolRegistry();
  registry.register({
    name: 'delegate_to_runtime',
    execute: async () => ({ id: 'session-1' })
  });

  const executor = new AssistantToolExecutor({
    toolRegistry: registry,
    policyService: {
      canExecuteToolCall() {
        return {
          allowed: true,
          reason: 'assistant_delegation_within_scope',
          requiresConfirmation: true,
          scopeExpanded: true
        };
      }
    }
  });

  const result = await executor.executeToolCall({
    toolName: 'delegate_to_runtime',
    input: { provider: 'codex', task: 'check weather' }
  }, {
    conversation: null,
    run: { metadata: {} }
  });

  assert.equal(result.success, false);
  assert.equal(result.result?.kind, 'policy_block');
  assert.equal(result.result?.requiresConfirmation, true);
  assert.match(String(result.summary || ''), /requires confirmation/i);
});

test('Assistant ReAct stop policy treats policy confirmation blocks as waiting_user', async () => {
  const { deriveAssistantRunStopState } = await import('../../src/assistant-agent/stop-policy.js');

  const stopState = deriveAssistantRunStopState({
    toolResults: [{
      toolName: 'delegate_to_runtime',
      result: {
        kind: 'policy_block',
        requiresConfirmation: true,
        reason: 'assistant_scope_required'
      }
    }],
    assistantText: '',
    maxIterationsReached: false
  });

  assert.equal(stopState.status, 'waiting_user');
  assert.equal(stopState.closure, 'waiting_user');
  assert.equal(stopState.reason, 'assistant_confirmation_required');
});

test('continue_task never falls back to assistant execution id as sessionId', async () => {
  const calls = [];
  const registry = createDefaultAssistantToolRegistry({
    taskViewService: {
      getTask() {
        return {
          assistantDomain: {
            execution: {
              id: 'assistant-exec-1',
              currentRuntimeSessionId: ''
            }
          },
          task: {
            latestExecutionId: '',
            primaryExecutionId: ''
          },
          runtimeSession: null
        };
      }
    },
    messageService: {
      async continueRuntimeTask(payload) {
        calls.push(payload);
        return payload;
      }
    }
  });

  await assert.rejects(
    () => registry.get('continue_task').execute({
      input: {
        taskId: 'task-1',
        message: 'continue'
      }
    }),
    /requires taskId or sessionId/i
  );

  assert.equal(calls.length, 0);
});

// --- create_scheduled_task: declarative-only inputs --------------------------

function stubScheduledTaskMessageService({ scheduledTaskFactory } = {}) {
  const calls = [];
  return {
    calls,
    service: {
      createScheduledTask(input) {
        calls.push({ tool: 'create_scheduled_task', input });
        return scheduledTaskFactory
          ? scheduledTaskFactory(input)
          : {
              id: 'scheduled-1',
              title: input.title,
              schedule: input.schedule,
              payload: input.payload,
              state: 'scheduled',
              nextRunAt: input.nextRunAt
            };
      },
      updateScheduledTask(input) {
        calls.push({ tool: 'update_scheduled_task', input });
        return { id: input.id, state: 'scheduled', schedule: input.schedule || {}, payload: input.payload || {}, nextRunAt: '2026-05-15T14:25:00.000Z' };
      },
      cancelScheduledTask(input) {
        calls.push({ tool: 'cancel_scheduled_task', input });
        return { id: input.id, state: 'cancelled' };
      },
      listScheduledTasks(input) {
        calls.push({ tool: 'list_scheduled_tasks', input });
        return [
          { id: 'scheduled-1', title: 'A', schedule: { recurrence: 'daily', timezone: 'Asia/Shanghai', localTime: '20:00' }, payload: { message: 'do A' }, state: 'scheduled', nextRunAt: '2026-05-15T12:00:00.000Z' }
        ];
      },
      stateCoordinator: {
        scheduledTaskStore: {
          get() { return null; }
        }
      }
    }
  };
}

test('create_scheduled_task rejects empty title and message', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: { recurrence: 'once', delayMinutes: 5 },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /title or message/i);
  assert.equal(calls.length, 0);
});

test('create_scheduled_task daily: rejects when localTime is missing', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: { title: '提醒', message: 'x', recurrence: 'daily' },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /localTime/);
  assert.equal(calls.length, 0);
});

test('create_scheduled_task daily: rejects delayMinutes + daily combination (the historical bug)', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: '提醒带孩子出去玩',
      message: '带孩子出去玩',
      recurrence: 'daily',
      localTime: '20:00',
      delayMinutes: 5
    },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /delayMinutes\/delaySeconds cannot be combined/);
  assert.equal(calls.length, 0, 'must not reach the messageService when input is malformed');
});

test('create_scheduled_task daily: rejects delaySeconds + daily combination', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: '提醒',
      message: 'x',
      recurrence: 'daily',
      localTime: '20:00',
      delaySeconds: 1
    },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /delayMinutes\/delaySeconds cannot be combined/);
  assert.equal(calls.length, 0);
});

test('create_scheduled_task daily: happy path computes UTC nextRunAt server-side', async () => {
  const { calls, service } = stubScheduledTaskMessageService({
    scheduledTaskFactory: (input) => ({
      id: 'sched-daily',
      title: input.title,
      schedule: input.schedule,
      payload: input.payload,
      state: 'scheduled',
      nextRunAt: input.nextRunAt
    })
  });
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: '提醒吃营养健康餐',
      message: '提醒你吃营养健康餐',
      recurrence: 'daily',
      localTime: '20:10',
      timezone: 'Asia/Shanghai'
    },
    context: { conversation: { id: 'conv-x' } }
  });

  assert.equal(result.scheduledTaskId, 'sched-daily');
  assert.equal(result.recurrence, 'daily');
  assert.equal(result.localTime, '20:10');
  assert.match(String(result.nextRunAtUtc || ''), /:10:00\.000Z$/, `expected UTC :10 minute, got ${result.nextRunAtUtc}`);
  assert.equal(new Date(result.nextRunAtUtc).getUTCHours(), 12);
  assert.equal(new Date(result.nextRunAtUtc).getUTCMinutes(), 10);
  assert.match(String(result.humanReadable || ''), /Asia\/Shanghai/);

  assert.equal(calls.length, 1);
  const storedSchedule = calls[0].input.schedule;
  assert.equal(storedSchedule.recurrence, 'daily');
  assert.equal(storedSchedule.localTime, '20:10');
  assert.equal(storedSchedule.timezone, 'Asia/Shanghai');
  // conversationId is auto-promoted into notifyTargets[] (no longer in payload).
  assert.equal(calls[0].input.payload.message, '提醒你吃营养健康餐');
  assert.equal(calls[0].input.payload.action, 'notify_user');
  assert.ok(Array.isArray(calls[0].input.notifyTargets));
  assert.equal(calls[0].input.notifyTargets.length, 1);
  assert.equal(calls[0].input.notifyTargets[0].conversationId, 'conv-x');
});

test('create_scheduled_task weekly: rejects bad dayOfWeek', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: 'weekly',
      message: 'x',
      recurrence: 'weekly',
      localTime: '09:00',
      dayOfWeek: 'xyz'
    },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /dayOfWeek/);
  assert.equal(calls.length, 0);
});

test('create_scheduled_task weekly: accepts named weekday', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: '每周一晨会',
      message: '别忘了晨会',
      recurrence: 'weekly',
      localTime: '09:00',
      dayOfWeek: 'mon',
      timezone: 'Asia/Shanghai'
    },
    context: { conversation: { id: 'conv-w' } }
  });

  assert.equal(result.scheduledTaskId, 'scheduled-1');
  assert.equal(result.recurrence, 'weekly');
  assert.equal(calls.length, 1);
  // The raw input passes the dayOfWeek through as-is; the domain model
  // normalizes it to [1] when actually persisted. The mock here echoes
  // back what the tool passed in.
  assert.equal(calls[0].input.schedule.dayOfWeek, 'mon');
});

test('create_scheduled_task monthly: requires dayOfMonth', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: 'monthly',
      message: 'x',
      recurrence: 'monthly',
      localTime: '09:00'
    },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /dayOfMonth/);
  assert.equal(calls.length, 0);
});

test('create_scheduled_task yearly: requires month + dayOfMonth', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const r1 = await registry.get('create_scheduled_task').execute({
    input: { title: 'yearly', message: 'x', recurrence: 'yearly', dayOfMonth: 1, localTime: '00:00' },
    context: { conversation: { id: 'conv-1' } }
  });
  assert.equal(r1.kind, 'tool_error');
  assert.match(String(r1.error || ''), /month \(1\.\.12\)/);

  const r2 = await registry.get('create_scheduled_task').execute({
    input: { title: 'yearly', message: 'x', recurrence: 'yearly', month: 1, localTime: '00:00' },
    context: { conversation: { id: 'conv-1' } }
  });
  assert.equal(r2.kind, 'tool_error');
  assert.match(String(r2.error || ''), /dayOfMonth \(1\.\.31\)/);

  const r3 = await registry.get('create_scheduled_task').execute({
    input: { title: '元旦提醒', message: '新年快乐', recurrence: 'yearly', month: 1, dayOfMonth: 1, localTime: '00:00' },
    context: { conversation: { id: 'conv-1' } }
  });
  assert.equal(r3.scheduledTaskId, 'scheduled-1');
  assert.equal(calls.length, 1);
});

test('create_scheduled_task once + delayMinutes: happy path, no timezone math by LLM', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });
  const before = Date.now();

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: '5 分钟后提醒',
      message: '该走了',
      recurrence: 'once',
      delayMinutes: 5
    },
    context: { conversation: { id: 'conv-once' } }
  });

  assert.equal(result.scheduledTaskId, 'scheduled-1');
  assert.equal(result.recurrence, 'once');
  const fireMs = Date.parse(result.nextRunAtUtc);
  assert.ok(fireMs >= before + 5 * 60_000 - 1000, 'fire should be ~5 minutes from now');
  assert.ok(fireMs <= Date.now() + 5 * 60_000 + 1000, 'fire should be ~5 minutes from now');
  assert.equal(calls[0].input.schedule.recurrence, 'once');
});

test('create_scheduled_task once + only date is rejected (date needs localTime)', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: '明天某时刻',
      message: 'x',
      recurrence: 'once',
      date: '2026-06-01'
    },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /localTime/);
  assert.equal(calls.length, 0);
});

test('create_scheduled_task daily + date is rejected (date is once-only)', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('create_scheduled_task').execute({
    input: {
      title: 'daily with date',
      message: 'x',
      recurrence: 'daily',
      localTime: '20:00',
      date: '2026-06-01'
    },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /date.*once/);
  assert.equal(calls.length, 0);
});

test('update_scheduled_task: requires scheduledTaskId', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('update_scheduled_task').execute({
    input: { localTime: '22:30' },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.kind, 'tool_error');
  assert.match(String(result.error || ''), /scheduledTaskId/);
  assert.equal(calls.length, 0);
});

test('update_scheduled_task: applies localTime patch and returns humanReadable', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  // Stub the store lookup so the tool's pre-check finds an existing task.
  service.stateCoordinator.scheduledTaskStore.get = () => ({
    id: 'sched-1',
    schedule: { recurrence: 'daily', timezone: 'Asia/Shanghai', localTime: '22:15', dayOfWeek: [], dayOfMonth: null, month: null, date: '' },
    payload: { message: 'old msg', conversationId: 'conv-1' },
    state: 'scheduled'
  });
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('update_scheduled_task').execute({
    input: { scheduledTaskId: 'sched-1', localTime: '22:25' },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(result.scheduledTaskId, 'sched-1');
  assert.equal(result.localTime, '22:25');
  assert.match(String(result.humanReadable || ''), /已更新|Asia\/Shanghai/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'update_scheduled_task');
  assert.equal(calls[0].input.schedule.localTime, '22:25');
  // Original recurrence/timezone preserved.
  assert.equal(calls[0].input.schedule.recurrence, 'daily');
  assert.equal(calls[0].input.schedule.timezone, 'Asia/Shanghai');
});

test('cancel_scheduled_task: requires scheduledTaskId, otherwise calls messageService.cancelScheduledTask', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const noId = await registry.get('cancel_scheduled_task').execute({
    input: {},
    context: { conversation: { id: 'conv-1' } }
  });
  assert.equal(noId.kind, 'tool_error');
  assert.equal(calls.length, 0);

  const ok = await registry.get('cancel_scheduled_task').execute({
    input: { scheduledTaskId: 'sched-1', reason: 'user_no_longer_needs' },
    context: { conversation: { id: 'conv-1' } }
  });
  assert.equal(ok.state, 'cancelled');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.id, 'sched-1');
  assert.equal(calls[0].input.reason, 'user_no_longer_needs');
});

test('list_scheduled_tasks: returns conversation-scoped list with humanReadable strings', async () => {
  const { calls, service } = stubScheduledTaskMessageService();
  const registry = createDefaultAssistantToolRegistry({ messageService: service });

  const result = await registry.get('list_scheduled_tasks').execute({
    input: {},
    context: { conversation: { id: 'conv-list' } }
  });

  assert.equal(result.count, 1);
  assert.equal(result.items[0].scheduledTaskId, 'scheduled-1');
  assert.match(String(result.items[0].humanReadable || ''), /Asia\/Shanghai/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.conversationId, 'conv-list');
});

test('assistant tool registry exposes execution handoff tools through message service', async () => {
  const calls = [];
  const registry = createDefaultAssistantToolRegistry({
    messageService: {
      createExecutionHandoff(input) {
        calls.push({ tool: 'handoff_execution', input });
        return { ok: true, handoffId: 'handoff-1' };
      },
      consumeExecutionHandoff(input) {
        calls.push({ tool: 'consume_execution_handoff', input });
        return { ok: true, handoffId: input.handoffId };
      }
    }
  });

  const created = await registry.get('handoff_execution').execute({
    input: { executionId: 'exec-1', kind: 'review_request', title: 'review this' },
    context: { conversation: { id: 'conv-1' } }
  });
  const consumed = await registry.get('consume_execution_handoff').execute({
    input: { executionId: 'exec-1', handoffId: 'handoff-1' },
    context: { conversation: { id: 'conv-1' } }
  });

  assert.equal(created.handoffId, 'handoff-1');
  assert.equal(consumed.handoffId, 'handoff-1');
  assert.equal(calls.length, 2);
});
