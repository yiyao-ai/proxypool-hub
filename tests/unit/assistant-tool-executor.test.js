import test from 'node:test';
import assert from 'node:assert/strict';

import { AssistantToolRegistry } from '../../src/assistant-core/tool-registry.js';
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
