import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantToolRegistry, createDefaultAssistantToolRegistry } from '../../src/assistant-core/tool-registry.js';
import { AssistantToolExecutor } from '../../src/assistant-core/tool-executor.js';

test('AssistantToolExecutor enforces policy gate before executing mutating tools', async () => {
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

  await assert.rejects(
    () => executor.executeToolCall({
      toolName: 'start_runtime_task',
      input: { provider: 'codex', task: 'inspect repo' }
    }, {
      conversation: null,
      run: { metadata: {} }
    }),
    /blocked tool/i
  );
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

test('assistant tool registry exposes execution handoff and scheduled-task tools through message service', async () => {
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
      },
      createScheduledTask(input) {
        calls.push({ tool: 'create_scheduled_task', input });
        return { ok: true, scheduledTaskId: 'scheduled-1' };
      }
    }
  });

  const created = await registry.get('handoff_execution').execute({
    input: {
      executionId: 'exec-1',
      kind: 'review_request',
      title: 'review this'
    },
    context: {
      conversation: { id: 'conv-1' }
    }
  });
  const consumed = await registry.get('consume_execution_handoff').execute({
    input: {
      executionId: 'exec-1',
      handoffId: 'handoff-1'
    },
    context: {
      conversation: { id: 'conv-1' }
    }
  });
  const scheduled = await registry.get('create_scheduled_task').execute({
    input: {
      taskId: 'task-1',
      kind: 'check_in',
      title: 'check later'
    }
  });

  assert.equal(created.handoffId, 'handoff-1');
  assert.equal(consumed.handoffId, 'handoff-1');
  assert.equal(scheduled.scheduledTaskId, 'scheduled-1');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].tool, 'handoff_execution');
  assert.equal(calls[1].tool, 'consume_execution_handoff');
  assert.equal(calls[2].tool, 'create_scheduled_task');
});
