import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleListAssistantTasks,
  handleGetAssistantTask
} from '../../src/routes/assistant-tasks-route.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

test('assistant task routes list and fetch aggregated task records', async () => {
  const singleton = (await import('../../src/assistant-core/task-view-service.js')).default;
  const { listTasks, getTask } = singleton;
  const record = {
    id: 'task-record-1',
    conversationId: 'conversation-1',
    state: 'completed',
    summary: 'done',
    conversation: { id: 'conversation-1' }
  };
  singleton.listTasks = () => [record];
  singleton.getTask = (taskId) => (taskId === record.id ? record : null);

  try {
    const listRes = mockRes();
    handleListAssistantTasks({ query: {} }, listRes);
    assert.equal(listRes._status, 200);
    assert.equal(listRes._body.success, true);
    assert.equal(listRes._body.tasks[0].id, record.id);

    const detailRes = mockRes();
    handleGetAssistantTask({ params: { id: record.id } }, detailRes);
    assert.equal(detailRes._status, 200);
    assert.equal(detailRes._body.task.id, record.id);

    const missingRes = mockRes();
    handleGetAssistantTask({ params: { id: 'missing' } }, missingRes);
    assert.equal(missingRes._status, 404);
  } finally {
    singleton.listTasks = listTasks;
    singleton.getTask = getTask;
  }
});
