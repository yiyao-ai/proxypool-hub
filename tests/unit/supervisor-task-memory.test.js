import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeSupervisorTaskMemory,
  upsertSupervisorTaskRecord,
  finalizeSupervisorTaskMemory,
  buildTrackedSupervisorTaskIds,
  pickCurrentSupervisorTask
} from '../../src/agent-orchestrator/supervisor-task-memory.js';
import { buildSupervisorBrief } from '../../src/agent-orchestrator/supervisor-brief.js';

test('normalizeSupervisorTaskMemory builds compatible byTask and activeTaskId views', () => {
  const memory = normalizeSupervisorTaskMemory({
    current: {
      sessionId: 'session_1',
      provider: 'codex',
      title: 'Build login page',
      status: 'running'
    }
  });

  assert.equal(memory.activeSessionId, 'session_1');
  assert.equal(memory.activeTaskId, 'session_1');
  assert.ok(memory.bySession.session_1);
  assert.ok(memory.byTask.session_1);
  assert.equal(memory.currentTask.taskId, 'session_1');
  assert.deepEqual(buildTrackedSupervisorTaskIds(memory), ['session_1']);
});

test('upsert and finalize supervisor task memory preserve task-first terminal views', () => {
  let memory = upsertSupervisorTaskRecord(null, 'session_1', {
    provider: 'codex',
    title: 'Build dashboard',
    status: 'running',
    summary: 'in progress'
  }, { activate: true });

  memory = finalizeSupervisorTaskMemory(memory, 'session_1', {
    status: 'completed',
    summary: 'done',
    result: 'dashboard ready'
  }, 'completed');

  assert.equal(memory.activeTaskId, 'session_1');
  assert.equal(memory.lastCompletedTask.taskId, 'session_1');
  assert.equal(memory.lastCompleted.taskId, 'session_1');
  assert.equal(memory.byTask.session_1.result, 'dashboard ready');
});

test('buildSupervisorBrief exposes task identifiers for current and terminal tasks', () => {
  let memory = upsertSupervisorTaskRecord(null, 'session_1', {
    provider: 'claude-code',
    title: 'Review API',
    status: 'waiting_user',
    pendingQuestion: 'Use REST or GraphQL?'
  }, { activate: true });

  let brief = buildSupervisorBrief({ taskMemory: memory });
  assert.equal(brief.kind, 'current');
  assert.equal(brief.taskId, 'session_1');
  assert.equal(brief.sessionId, 'session_1');
  assert.match(String(brief.summary || ''), /Task "Review API" is waiting for your reply\./);

  memory = finalizeSupervisorTaskMemory(memory, 'session_1', {
    status: 'failed',
    error: 'blocked'
  }, 'failed');
  const current = pickCurrentSupervisorTask(memory);
  assert.equal(current.taskId, 'session_1');
  assert.equal(memory.lastFailedTask.taskId, 'session_1');

  brief = buildSupervisorBrief({
    taskMemory: {
      ...memory,
      byTask: {},
      bySession: {},
      current: null,
      currentTask: null,
      activeTaskId: null,
      activeSessionId: null
    }
  });
  assert.equal(brief.kind, 'last_failed');
  assert.equal(brief.taskId, 'session_1');
});
