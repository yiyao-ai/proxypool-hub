import agentRuntimeSessionManager from '../agent-runtime/session-manager.js';

function withInteractiveCodexDefaults(provider, metadata = {}, cwd = '') {
  const next = { ...(metadata || {}) };
  if (provider !== 'codex' || !String(cwd || '').trim()) {
    return next;
  }

  next.runtimeOptions = {
    ...(next.runtimeOptions || {}),
    codex: {
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      ...((next.runtimeOptions || {}).codex || {})
    }
  };
  return next;
}

function parseLimit(value, fallback = 50) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function prepareSse(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function handleListAgentRuntimeProviders(_req, res) {
  res.json({
    success: true,
    providers: agentRuntimeSessionManager.listProviders()
  });
}

export function handleListAgentRuntimeSessions(req, res) {
  res.json({
    success: true,
    sessions: agentRuntimeSessionManager.listSessions({
      limit: parseLimit(req.query.limit, 50)
    })
  });
}

export function handleGetAgentRuntimeSession(req, res) {
  const session = agentRuntimeSessionManager.getSession(String(req.params.id || ''));
  if (!session) {
    return res.status(404).json({ success: false, error: 'session not found' });
  }

  return res.json({
    success: true,
    session,
    turns: agentRuntimeSessionManager.listTurns(session.id, {
      limit: parseLimit(req.query.turnLimit, 20)
    })
  });
}

export function handleGetAgentRuntimeTurn(req, res) {
  const sessionId = String(req.params.id || '');
  const turnId = String(req.params.turnId || '');
  const session = agentRuntimeSessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'session not found' });
  }

  const turn = agentRuntimeSessionManager.getTurn(sessionId, turnId);
  if (!turn) {
    return res.status(404).json({ success: false, error: 'turn not found' });
  }

  return res.json({
    success: true,
    session,
    turn,
    events: agentRuntimeSessionManager.listTurnEvents(sessionId, turnId, {
      limit: parseLimit(req.query.eventLimit, 100)
    })
  });
}

export async function handleCreateAgentRuntimeSession(req, res) {
  try {
    const { provider, input, cwd, model, metadata } = req.body || {};
    const session = await agentRuntimeSessionManager.createSession({
      provider,
      input,
      cwd,
      model,
      metadata: withInteractiveCodexDefaults(provider, metadata, cwd)
    });
    return res.json({ success: true, session });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: error.message
    });
  }
}

export async function handleSendAgentRuntimeInput(req, res) {
  try {
    const session = await agentRuntimeSessionManager.sendInput(
      String(req.params.id || ''),
      req.body?.input
    );
    return res.json({ success: true, session });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    return res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

export async function handleResolveAgentRuntimeApproval(req, res) {
  try {
    const approval = await agentRuntimeSessionManager.resolveApproval(
      String(req.params.id || ''),
      String(req.body?.approvalId || ''),
      String(req.body?.decision || '')
    );
    return res.json({ success: true, approval });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    return res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

export async function handleAnswerAgentRuntimeQuestion(req, res) {
  try {
    const question = await agentRuntimeSessionManager.answerQuestion(
      String(req.params.id || ''),
      String(req.body?.questionId || ''),
      req.body?.answer
    );
    return res.json({ success: true, question });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    return res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

export function handleCancelAgentRuntimeSession(req, res) {
  try {
    const session = agentRuntimeSessionManager.cancelSession(String(req.params.id || ''));
    return res.json({ success: true, session });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : 400;
    return res.status(status).json({
      success: false,
      error: error.message
    });
  }
}

export function handleStreamAgentRuntimeSession(req, res) {
  const sessionId = String(req.params.id || '');
  const session = agentRuntimeSessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ success: false, error: 'session not found' });
  }

  prepareSse(res);

  if (req.query.history !== 'false') {
    const events = agentRuntimeSessionManager.getEvents(sessionId, {
      afterSeq: Number.parseInt(String(req.query.afterSeq || '0'), 10) || 0,
      limit: parseLimit(req.query.limit, 200)
    });
    for (const event of events) {
      writeSse(res, event);
    }
  }

  const unsubscribe = agentRuntimeSessionManager.subscribe(sessionId, (event) => {
    writeSse(res, event);
  });

  req.on('close', () => {
    unsubscribe();
    res.end();
  });
}

export default {
  handleListAgentRuntimeProviders,
  handleListAgentRuntimeSessions,
  handleGetAgentRuntimeSession,
  handleGetAgentRuntimeTurn,
  handleCreateAgentRuntimeSession,
  handleSendAgentRuntimeInput,
  handleResolveAgentRuntimeApproval,
  handleAnswerAgentRuntimeQuestion,
  handleCancelAgentRuntimeSession,
  handleStreamAgentRuntimeSession
};
