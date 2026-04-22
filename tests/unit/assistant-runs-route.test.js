import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AssistantRunStore } from '../../src/assistant-core/run-store.js';
import {
  handleListAssistantRuns,
  handleGetAssistantRun
} from '../../src/routes/assistant-runs-route.js';

function createTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function mockRes() {
  return {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; }
  };
}

test('assistant run routes list and fetch persisted runs', async () => {
  const store = new AssistantRunStore({
    configDir: createTempDir('cligate-assistant-runs-route-')
  });
  const run = store.create({
    assistantSessionId: 'assistant-session-1',
    conversationId: 'conversation-1',
    triggerText: 'status',
    mode: 'one-shot',
    status: 'completed',
    summary: 'done',
    result: 'Workspace overview'
  });

  const singleton = (await import('../../src/assistant-core/run-store.js')).default;
  const { list, get, listByConversationId } = singleton;
  singleton.list = store.list.bind(store);
  singleton.get = store.get.bind(store);
  singleton.listByConversationId = store.listByConversationId.bind(store);

  try {
    const listRes = mockRes();
    handleListAssistantRuns({ query: { assistantSessionId: 'assistant-session-1' } }, listRes);
    assert.equal(listRes._status, 200);
    assert.equal(listRes._body.success, true);
    assert.equal(listRes._body.runs[0].id, run.id);

    const conversationListRes = mockRes();
    handleListAssistantRuns({ query: { conversationId: 'conversation-1' } }, conversationListRes);
    assert.equal(conversationListRes._body.runs[0].id, run.id);

    const detailRes = mockRes();
    handleGetAssistantRun({ params: { id: run.id } }, detailRes);
    assert.equal(detailRes._status, 200);
    assert.equal(detailRes._body.run.id, run.id);

    const missingRes = mockRes();
    handleGetAssistantRun({ params: { id: 'missing' } }, missingRes);
    assert.equal(missingRes._status, 404);
  } finally {
    singleton.list = list;
    singleton.get = get;
    singleton.listByConversationId = listByConversationId;
  }
});
