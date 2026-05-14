import '../test-env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskActivitySnapshot } from '../../src/assistant-core/domain/task-activity-snapshot.js';

test('buildTaskActivitySnapshot summarizes execution states', () => {
  const snapshot = buildTaskActivitySnapshot([
    { status: 'running' },
    { status: 'waiting_approval' },
    { status: 'failed' },
    { status: 'done', metadata: { stuck: true } }
  ]);

  assert.equal(snapshot.activeExecutionCount, 2);
  assert.equal(snapshot.hasRunningExecution, true);
  assert.equal(snapshot.hasPendingApproval, true);
  assert.equal(snapshot.hasPendingQuestion, false);
  assert.equal(snapshot.hasBlockingIssue, true);
  assert.equal(snapshot.hasStuckExecution, true);
  assert.equal(snapshot.allExecutionsTerminal, false);
});

test('buildTaskActivitySnapshot marks all terminal only when every execution is terminal', () => {
  const snapshot = buildTaskActivitySnapshot([
    { status: 'done' },
    { status: 'failed' },
    { status: 'cancelled' }
  ]);

  assert.equal(snapshot.allExecutionsTerminal, true);
  assert.equal(snapshot.activeExecutionCount, 0);
});
