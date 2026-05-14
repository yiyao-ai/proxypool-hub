import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAssistantTasksPageModule } from '../../public/js/modules/assistant-tasks-page.js';

function createHarness() {
  return {
    ...createAssistantTasksPageModule(),
    t(key) {
      return key;
    }
  };
}

test('assistant tasks page treats waiting_runtime as running instead of waiting approval', () => {
  const app = createHarness();

  assert.equal(
    app.assistantTaskStateLabel({ state: 'waiting_runtime' }),
    'agentRuntimeStatusRunning'
  );
  assert.equal(
    app.assistantTaskStatePillClass({ state: 'waiting_runtime' }),
    'border-neon-green/30 bg-neon-green/10 text-neon-green'
  );
});
