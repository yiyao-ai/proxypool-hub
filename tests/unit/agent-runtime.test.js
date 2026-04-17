import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentRuntimeApprovalService from '../../src/agent-runtime/approval-service.js';
import AgentRuntimeEventBus from '../../src/agent-runtime/event-bus.js';
import { AGENT_EVENT_TYPE, AGENT_SESSION_STATUS } from '../../src/agent-runtime/models.js';
import {
  buildApprovalResponse,
  buildQuestionResponse,
  buildUserMessage,
  createClaudeCodeMessageProcessor
} from '../../src/agent-runtime/providers/claude-code-provider.js';
import { buildCodexExecArgs, buildCodexSpawnEnv, resolveCodexRuntimeOptions } from '../../src/agent-runtime/providers/codex-provider.js';
import { buildCliNotFoundError, buildSpawnCommand, resolveCliExecutable } from '../../src/agent-runtime/cli-resolver.js';
import { applyCodexRuntimeCompatibility, ensureCodexRuntimeCompatibility } from '../../src/codex-runtime-config.js';
import { AgentRuntimeRegistry } from '../../src/agent-runtime/registry.js';
import { AgentRuntimeSessionManager } from '../../src/agent-runtime/session-manager.js';
import AgentRuntimeSessionStore from '../../src/agent-runtime/session-store.js';

function createTempStore() {
  return new AgentRuntimeSessionStore({
    configDir: mkdtempSync(join(tmpdir(), 'cligate-agent-runtime-'))
  });
}

class FakeProvider {
  constructor({ id = 'codex', deferred = false } = {}) {
    this.id = id;
    this.deferred = deferred;
    this.capabilities = {
      supportsResume: true,
      supportsStreamingEvents: true,
      supportsApprovalRequests: false,
      supportsInputInjection: true,
      supportsInterrupt: true
    };
    this.cancelled = false;
    this.finishTurn = null;
  }

  async startTurn({ input, onProviderEvent, onSessionPatch, onTurnFinished }) {
    onSessionPatch({ providerSessionId: 'thread_fake_1' });

    if (this.deferred) {
      this.finishTurn = () => {
        onProviderEvent({
          type: AGENT_EVENT_TYPE.MESSAGE,
          payload: { text: `deferred:${input}` }
        });
        onTurnFinished({
          status: 'ready',
          summary: `done:${input}`
        });
      };
      return {
        pid: 12345,
        cancel: () => {
          this.cancelled = true;
        }
      };
    }

    onProviderEvent({
      type: AGENT_EVENT_TYPE.MESSAGE,
      payload: { text: `echo:${input}` }
    });
    onTurnFinished({
      status: 'ready',
      summary: `done:${input}`
    });
    return {
      pid: 12345,
      cancel: () => {
        this.cancelled = true;
      }
    };
  }
}

class FakeInteractiveProvider {
  constructor() {
    this.id = 'claude-code';
    this.capabilities = {
      supportsResume: true,
      supportsStreamingEvents: true,
      supportsApprovalRequests: true,
      supportsInputInjection: true,
      supportsInterrupt: true
    };
    this.approvals = [];
    this.questions = [];
  }

  async startTurn({ onApprovalRequest, onQuestionRequest, onProviderEvent }) {
    onApprovalRequest({
      title: 'Need permission',
      summary: 'Run command',
      rawRequest: { requestId: 'approval-1', subtype: 'can_use_tool' }
    });
    onQuestionRequest({
      questionId: 'question-1',
      text: 'Continue?'
    });

    return {
      pid: 22222,
      respondApproval: async ({ decision }) => {
        this.approvals.push(decision);
        onProviderEvent({
          type: AGENT_EVENT_TYPE.PROGRESS,
          payload: { phase: 'approval_ack', decision }
        });
      },
      respondQuestion: async ({ answer }) => {
        this.questions.push(answer);
        onProviderEvent({
          type: AGENT_EVENT_TYPE.MESSAGE,
          payload: { text: `answer:${answer}` }
        });
      },
      cancel() {}
    };
  }
}

function createManagerWithProvider(provider, store = createTempStore()) {
  const registry = new AgentRuntimeRegistry();
  registry.register(provider);
  return new AgentRuntimeSessionManager({
    registry,
    store,
    eventBus: new AgentRuntimeEventBus(),
    approvalService: new AgentRuntimeApprovalService()
  });
}

test('AgentRuntimeSessionStore persists sessions and events', () => {
  const store = createTempStore();
  store.saveSessions([
    {
      id: 'session_1',
      provider: 'codex',
      status: AGENT_SESSION_STATUS.READY,
      updatedAt: '2026-04-16T00:00:00.000Z'
    }
  ]);
  store.appendEvent('session_1', {
    sessionId: 'session_1',
    seq: 1,
    type: AGENT_EVENT_TYPE.STARTED,
    payload: { provider: 'codex' }
  });

  const sessions = store.loadSessions();
  const events = store.listEvents('session_1');

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].provider, 'codex');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, AGENT_EVENT_TYPE.STARTED);
});

test('AgentRuntimeSessionManager creates a session, emits events, and persists provider session id', async () => {
  const store = createTempStore();
  const manager = createManagerWithProvider(new FakeProvider(), store);

  const session = await manager.createSession({
    provider: 'codex',
    input: 'inspect repo',
    cwd: process.cwd(),
    model: 'gpt-5.3-codex'
  });

  assert.equal(session.provider, 'codex');
  assert.equal(session.status, AGENT_SESSION_STATUS.READY);
  assert.equal(session.providerSessionId, 'thread_fake_1');
  assert.equal(session.summary, 'done:inspect repo');
  assert.equal(session.turnCount, 1);

  const events = manager.getEvents(session.id);
  assert.ok(events.some((event) => event.type === AGENT_EVENT_TYPE.STARTED));
  assert.ok(events.some((event) => event.type === AGENT_EVENT_TYPE.MESSAGE));
});

test('AgentRuntimeSessionManager supports follow-up input after a synchronously completed turn', async () => {
  const manager = createManagerWithProvider(new FakeProvider());

  const session = await manager.createSession({
    provider: 'codex',
    input: 'first turn'
  });

  assert.equal(session.status, AGENT_SESSION_STATUS.READY);

  const updated = await manager.sendInput(session.id, 'second turn');
  assert.equal(updated.status, AGENT_SESSION_STATUS.READY);
  assert.equal(updated.turnCount, 2);
  assert.equal(updated.summary, 'done:second turn');
});

test('AgentRuntimeSessionManager blocks concurrent input and supports cancellation for running turns', async () => {
  const provider = new FakeProvider({ deferred: true });
  const manager = createManagerWithProvider(provider);

  const session = await manager.createSession({
    provider: 'codex',
    input: 'long running task'
  });

  assert.equal(session.status, AGENT_SESSION_STATUS.RUNNING);
  await assert.rejects(
    () => manager.sendInput(session.id, 'follow-up'),
    /already running/i
  );

  const cancelled = manager.cancelSession(session.id);
  assert.equal(cancelled.status, AGENT_SESSION_STATUS.CANCELLED);
  assert.equal(provider.cancelled, true);
});

test('AgentRuntimeSessionManager restores unfinished sessions as failed after reload', () => {
  const store = createTempStore();
  store.saveSessions([
    {
      id: 'session_restart',
      provider: 'codex',
      status: AGENT_SESSION_STATUS.RUNNING,
      updatedAt: '2026-04-16T00:00:00.000Z'
    }
  ]);

  const manager = createManagerWithProvider(new FakeProvider(), store);
  const restored = manager.getSession('session_restart');

  assert.equal(restored.status, AGENT_SESSION_STATUS.FAILED);
  assert.match(restored.error, /interrupted/i);
});

test('AgentRuntimeSessionManager resolves approval and question state for interactive providers', async () => {
  const manager = createManagerWithProvider(new FakeInteractiveProvider());

  const session = await manager.createSession({
    provider: 'claude-code',
    input: 'interactive task'
  });

  assert.equal(session.status, AGENT_SESSION_STATUS.WAITING_USER);

  const [approval] = manager.approvalService.listPending(session.id);
  assert.ok(approval);

  const resolvedApproval = await manager.resolveApproval(session.id, approval.approvalId, 'approve');
  assert.equal(resolvedApproval.status, 'approved');
  assert.equal(manager.getSession(session.id).status, AGENT_SESSION_STATUS.WAITING_USER);

  const [question] = manager.listPendingQuestions(session.id);
  assert.ok(question);

  const answeredQuestion = await manager.answerQuestion(session.id, question.questionId, 'yes');
  assert.equal(answeredQuestion.status, 'answered');
  assert.equal(manager.getSession(session.id).status, AGENT_SESSION_STATUS.RUNNING);

  const events = manager.getEvents(session.id);
  assert.ok(events.some((event) => event.type === AGENT_EVENT_TYPE.APPROVAL_REQUEST));
  assert.ok(events.some((event) => event.type === AGENT_EVENT_TYPE.APPROVAL_RESOLVED));
  assert.ok(events.some((event) => event.type === AGENT_EVENT_TYPE.QUESTION));
});

test('createClaudeCodeMessageProcessor maps Claude control flow into normalized events', () => {
  const providerEvents = [];
  const approvals = [];
  const questions = [];
  const patches = [];
  let closed = false;

  const processor = createClaudeCodeMessageProcessor({
    onProviderEvent: (event) => providerEvents.push(event),
    onApprovalRequest: (approval) => approvals.push(approval),
    onQuestionRequest: (question) => questions.push(question),
    onSessionPatch: (patch) => patches.push(patch),
    closeInput: () => {
      closed = true;
    }
  });

  processor.processMessage({
    type: 'assistant',
    session_id: 'claude-session-1',
    message: { content: 'assistant reply' }
  });
  processor.processMessage({
    type: 'control_request',
    request_id: 'req-approval',
    request: {
      subtype: 'can_use_tool',
      title: 'Permission',
      description: 'Need shell access',
      tool_name: 'Bash'
    }
  });
  processor.processMessage({
    type: 'control_request',
    request_id: 'req-question',
    request: {
      subtype: 'elicitation',
      message: 'Which branch should I use?'
    }
  });
  processor.processMessage({
    type: 'result',
    result: 'all done',
    usage: { input_tokens: 1, output_tokens: 2 }
  });

  assert.deepEqual(patches, [{ providerSessionId: 'claude-session-1' }]);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].rawRequest.requestId, 'req-approval');
  assert.match(approvals[0].summary, /shell access/i);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].questionId, 'req-question');
  assert.equal(closed, true);
  assert.equal(processor.getTerminalState()?.status, 'ready');
  assert.equal(processor.getResultText(), 'all done');
  assert.ok(providerEvents.some((event) => event.type === AGENT_EVENT_TYPE.MESSAGE));
  assert.ok(providerEvents.some((event) => event.type === AGENT_EVENT_TYPE.COMPLETED));
});

test('Claude Code response builders emit expected protocol envelopes', () => {
  assert.deepEqual(buildUserMessage('weather'), {
    type: 'user',
    content: 'weather',
    uuid: '',
    session_id: '',
    message: {
      role: 'user',
      content: 'weather'
    },
    parent_tool_use_id: null
  });

  const approval = buildApprovalResponse('req-1', { tool_use_id: 'tool-1', input: { cmd: 'dir' } }, 'approve');
  assert.equal(approval.type, 'control_response');
  assert.equal(approval.response.request_id, 'req-1');
  assert.equal(approval.response.response.behavior, 'allow');
  assert.equal(approval.response.response.toolUseID, 'tool-1');

  const question = buildQuestionResponse('req-2', 'Proceed');
  assert.equal(question.type, 'control_response');
  assert.equal(question.response.request_id, 'req-2');
  assert.equal(question.response.response.action, 'accept');
  assert.deepEqual(question.response.response.content, { answer: 'Proceed' });
});

test('resolveCliExecutable prefers explicit env override when present', () => {
  const resolved = resolveCliExecutable('codex', {
    env: { CLIGATE_CODEX_BIN: 'D:\\tools\\codex.cmd' },
    platform: 'win32',
    whereResolver: () => 'C:\\Users\\liuting\\AppData\\Roaming\\npm\\codex.cmd'
  });

  assert.equal(resolved, 'D:\\tools\\codex.cmd');
});

test('resolveCliExecutable prefers .cmd shim on Windows when where.exe returns multiple paths', () => {
  const resolved = resolveCliExecutable('codex', {
    env: {},
    platform: 'win32',
    whereResolver: () => [
      'C:\\Users\\liuting\\AppData\\Roaming\\npm\\codex',
      'C:\\Users\\liuting\\AppData\\Roaming\\npm\\codex.cmd'
    ].join('\n')
  });

  assert.equal(resolved, 'C:\\Users\\liuting\\AppData\\Roaming\\npm\\codex.cmd');
});

test('buildCliNotFoundError returns actionable install guidance', () => {
  const error = buildCliNotFoundError('codex', new Error('spawn codex ENOENT'));
  assert.match(error.message, /Codex CLI was not found/i);
  assert.match(error.message, /CLIGATE_CODEX_BIN/);
});

test('buildSpawnCommand wraps Windows cmd shims with cmd.exe', () => {
  const spawnSpec = buildSpawnCommand('codex', ['--version'], {
    env: { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
    platform: 'win32',
    whereResolver: () => 'C:\\Users\\liuting\\AppData\\Roaming\\npm\\codex.cmd'
  });

  assert.equal(spawnSpec.command, 'C:\\WINDOWS\\system32\\cmd.exe');
  assert.deepEqual(spawnSpec.args, [
    '/d',
    '/s',
    '/c',
    'C:\\Users\\liuting\\AppData\\Roaming\\npm\\codex.cmd --version'
  ]);
});

test('buildSpawnCommand preserves embedded quotes in config-style arguments', () => {
  const spawnSpec = buildSpawnCommand('codex', ['--config', 'approval_policy="never"'], {
    env: { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' },
    platform: 'win32',
    whereResolver: () => 'C:\\Users\\liuting\\AppData\\Roaming\\npm\\codex.cmd'
  });

  assert.deepEqual(spawnSpec.args, [
    '/d',
    '/s',
    '/c',
    'C:\\Users\\liuting\\AppData\\Roaming\\npm\\codex.cmd --config approval_policy="never"'
  ]);
});

test('resolveCodexRuntimeOptions defaults to workspace-write and never approval', () => {
  const options = resolveCodexRuntimeOptions({
    metadata: {}
  }, {
    env: {}
  });

  assert.deepEqual(options, {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    dangerouslyBypass: false
  });
});

test('resolveCodexRuntimeOptions prefers metadata overrides over environment defaults', () => {
  const options = resolveCodexRuntimeOptions({
    metadata: {
      runtimeOptions: {
        codex: {
          sandboxMode: 'danger-full-access',
          approvalPolicy: 'on-request',
          dangerouslyBypass: false
        }
      }
    }
  }, {
    env: {
      CLIGATE_CODEX_SANDBOX_MODE: 'read-only',
      CLIGATE_CODEX_APPROVAL_POLICY: 'never'
    }
  });

  assert.deepEqual(options, {
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'on-request',
    dangerouslyBypass: false
  });
});

test('buildCodexExecArgs emits writable defaults and supports dangerous bypass', () => {
  const defaultArgs = buildCodexExecArgs({
    cwd: 'D:\\cligatespace',
    model: 'gpt-5.4',
    metadata: {}
  }, {
    env: {}
  });

  assert.deepEqual(defaultArgs.slice(0, 7), [
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'never',
    'exec',
    '--experimental-json',
    '--model'
  ]);
  assert.ok(defaultArgs.includes('--cd'));
  assert.ok(defaultArgs.includes('D:\\cligatespace'));

  const bypassArgs = buildCodexExecArgs({
    metadata: {
      runtimeOptions: {
        codex: {
          dangerouslyBypass: true
        }
      }
    }
  }, {
    env: {}
  });

  assert.deepEqual(bypassArgs.slice(0, 3), [
    '--dangerously-bypass-approvals-and-sandbox',
    'exec',
    '--experimental-json'
  ]);
  assert.ok(!bypassArgs.includes('--sandbox'));
  assert.ok(!bypassArgs.includes('--ask-for-approval'));
});

test('buildCodexSpawnEnv filters PowerShell 7 from PATH on windows sandbox runs', () => {
  const env = buildCodexSpawnEnv({
    Path: [
      'D:\\soft\\windowspowershell\\7',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
      'C:\\Windows\\System32'
    ].join(';'),
    PATH: 'D:\\soft\\windowspowershell\\7;C:\\Windows\\System32',
    CLIGATE_CODEX_FORCE_WINDOWS_POWERSHELL: '1'
  }, {
    dangerouslyBypass: false
  }, {
    platform: 'win32'
  });

  assert.equal('PATH' in env, true);
  assert.equal(env.PATH.includes('windowspowershell\\7'), false);
  assert.equal(env.PATH.includes('WindowsPowerShell\\v1.0'), true);
});

test('applyCodexRuntimeCompatibility injects recommended windows-safe settings', () => {
  const next = applyCodexRuntimeCompatibility([
    'model = "gpt-5.4"',
    '',
    '[projects.\'D:\\tmp\']',
    'trust_level = "trusted"'
  ].join('\n'), {
    cwd: 'D:\\cligatespace'
  });

  assert.match(next, /^allow_login_shell = false/m);
  assert.match(next, /^sandbox_mode = "workspace-write"$/m);
  assert.match(next, /\[features\][\s\S]*powershell_utf8 = false/);
  if (process.platform === 'win32') {
    assert.match(next, /\[windows\][\s\S]*sandbox = "unelevated"/);
  }
  assert.match(next, /projects\.'D:\\cligatespace'/);
  if (process.platform === 'win32') {
    assert.match(next, /projects\.'\\\\\?\\D:\\cligatespace'/);
  }
});

test('ensureCodexRuntimeCompatibility writes config file and reports trusted projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cligate-codex-config-'));
  const filePath = join(dir, 'config.toml');
  const result = ensureCodexRuntimeCompatibility({
    cwd: 'D:\\cligatespace',
    filePath
  });

  assert.equal(existsSync(filePath), true);
  const written = readFileSync(filePath, 'utf8');
  assert.match(written, /^allow_login_shell = false/m);
  assert.match(written, /^sandbox_mode = "workspace-write"$/m);
  assert.ok(Array.isArray(result.trustedProjects));
  assert.ok(result.trustedProjects.length >= 1);
  assert.equal(result.compatibility.sandboxMode, '"workspace-write"');
});
