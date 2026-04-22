import test from 'node:test';
import assert from 'node:assert/strict';

import agentRuntimeSessionManager from '../../src/agent-runtime/session-manager.js';
import {
  handleAnswerAgentRuntimeQuestion,
  handleCreateAgentRuntimeSession,
  handleGetAgentRuntimeSession,
  handleGetAgentRuntimeTurn,
  handleListAgentRuntimeProviders,
  handleResolveAgentRuntimeApproval,
  handleSendAgentRuntimeInput,
  handleStreamAgentRuntimeSession
} from '../../src/routes/agent-runtimes-route.js';

function mockRes() {
  return {
    _status: 200,
    _body: null,
    _headers: {},
    _writes: [],
    _flushHeaders: false,
    status(code) {
      this._status = code;
      return this;
    },
    json(body) {
      this._body = body;
      return this;
    },
    setHeader(name, value) {
      this._headers[name] = value;
    },
    flushHeaders() {
      this._flushHeaders = true;
    },
    write(chunk) {
      this._writes.push(String(chunk));
    },
    end() {
      this._ended = true;
    }
  };
}

function mockReq({ body = {}, params = {}, query = {} } = {}) {
  const listeners = new Map();
  return {
    body,
    params,
    query,
    on(event, listener) {
      listeners.set(event, listener);
    },
    emit(event) {
      listeners.get(event)?.();
    }
  };
}

function withManagerOverrides(overrides, fn) {
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = agentRuntimeSessionManager[key];
    agentRuntimeSessionManager[key] = value;
  }

  const finalize = () => {
    for (const [key, value] of Object.entries(originals)) {
      agentRuntimeSessionManager[key] = value;
    }
  };

  return Promise.resolve()
    .then(fn)
    .finally(finalize);
}

test('agent runtime route lists providers from session manager', async () => {
  await withManagerOverrides({
    listProviders: () => [{ id: 'codex' }, { id: 'claude-code' }]
  }, async () => {
    const res = mockRes();
    handleListAgentRuntimeProviders({}, res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.deepEqual(res._body.providers.map((item) => item.id), ['codex', 'claude-code']);
  });
});

test('agent runtime route creates session and maps validation failures to 400', async () => {
  await withManagerOverrides({
    createSession: async ({ provider, input }) => {
      if (!provider || !input) throw new Error('input is required');
      return { id: 'session-1', provider, status: 'running' };
    }
  }, async () => {
    const okRes = mockRes();
    await handleCreateAgentRuntimeSession(
      mockReq({ body: { provider: 'codex', input: 'inspect repo' } }),
      okRes
    );
    assert.equal(okRes._status, 200);
    assert.equal(okRes._body.session.id, 'session-1');

    const badRes = mockRes();
    await handleCreateAgentRuntimeSession(
      mockReq({ body: { provider: 'codex' } }),
      badRes
    );
    assert.equal(badRes._status, 400);
    assert.equal(badRes._body.success, false);
  });
});

test('agent runtime route returns 404 when session is missing', async () => {
  await withManagerOverrides({
    getSession: () => null
  }, async () => {
    const res = mockRes();
    handleGetAgentRuntimeSession(mockReq({ params: { id: 'missing' } }), res);
    assert.equal(res._status, 404);
    assert.equal(res._body.error, 'session not found');
  });
});

test('agent runtime route returns session turns in detail payload', async () => {
  await withManagerOverrides({
    getSession: () => ({ id: 'session-1', status: 'ready' }),
    listTurns: () => [{ id: 'session-1:turn:1', input: 'inspect repo', status: 'ready' }]
  }, async () => {
    const res = mockRes();
    handleGetAgentRuntimeSession(mockReq({ params: { id: 'session-1' }, query: { turnLimit: '5' } }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.session.id, 'session-1');
    assert.equal(res._body.turns.length, 1);
    assert.equal(res._body.turns[0].id, 'session-1:turn:1');
  });
});

test('agent runtime route returns turn detail and events payload', async () => {
  await withManagerOverrides({
    getSession: () => ({ id: 'session-1', status: 'ready' }),
    getTurn: () => ({ id: 'session-1:turn:1', input: 'inspect repo', status: 'ready' }),
    listTurnEvents: () => [{ sessionId: 'session-1', turnId: 'session-1:turn:1', seq: 2, type: 'worker.message', payload: { text: 'done' } }]
  }, async () => {
    const res = mockRes();
    handleGetAgentRuntimeTurn(mockReq({ params: { id: 'session-1', turnId: 'session-1:turn:1' }, query: { eventLimit: '5' } }), res);

    assert.equal(res._status, 200);
    assert.equal(res._body.success, true);
    assert.equal(res._body.turn.id, 'session-1:turn:1');
    assert.equal(res._body.events.length, 1);
    assert.equal(res._body.events[0].turnId, 'session-1:turn:1');
  });
});

test('agent runtime route maps input, approval, and question errors by not-found status', async () => {
  await withManagerOverrides({
    sendInput: async () => {
      throw new Error('session not found');
    },
    resolveApproval: async () => {
      throw new Error('approval not found');
    },
    answerQuestion: async () => {
      throw new Error('question not found');
    }
  }, async () => {
    const inputRes = mockRes();
    await handleSendAgentRuntimeInput(mockReq({ params: { id: 'missing' }, body: { input: 'hi' } }), inputRes);
    assert.equal(inputRes._status, 404);

    const approvalRes = mockRes();
    await handleResolveAgentRuntimeApproval(
      mockReq({ params: { id: 'missing' }, body: { approvalId: 'a-1', decision: 'approve' } }),
      approvalRes
    );
    assert.equal(approvalRes._status, 404);

    const questionRes = mockRes();
    await handleAnswerAgentRuntimeQuestion(
      mockReq({ params: { id: 'missing' }, body: { questionId: 'q-1', answer: 'yes' } }),
      questionRes
    );
    assert.equal(questionRes._status, 404);
  });
});

test('agent runtime stream route emits history and live SSE events', async () => {
  let listener = null;
  let unsubscribed = false;

  await withManagerOverrides({
    getSession: () => ({ id: 'session-1', status: 'running' }),
    getEvents: () => [{ sessionId: 'session-1', seq: 1, type: 'worker.started', payload: { provider: 'codex' } }],
    subscribe: (_sessionId, fn) => {
      listener = fn;
      return () => {
        unsubscribed = true;
      };
    }
  }, async () => {
    const req = mockReq({ params: { id: 'session-1' }, query: { history: 'true' } });
    const res = mockRes();

    handleStreamAgentRuntimeSession(req, res);
    assert.equal(res._headers['Content-Type'], 'text/event-stream; charset=utf-8');
    assert.equal(res._flushHeaders, true);
    assert.equal(res._writes.length, 1);
    assert.match(res._writes[0], /worker\.started/);

    listener?.({ sessionId: 'session-1', seq: 2, type: 'worker.message', payload: { text: 'hello' } });
    assert.equal(res._writes.length, 2);
    assert.match(res._writes[1], /worker\.message/);

    req.emit('close');
    assert.equal(unsubscribed, true);
    assert.equal(res._ended, true);
  });
});
