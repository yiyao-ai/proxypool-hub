import { spawn } from 'child_process';
import readline from 'readline';
import path from 'path';

import { AGENT_EVENT_TYPE } from '../models.js';
import { buildCliNotFoundError, buildSpawnCommand } from '../cli-resolver.js';
import { ensureCodexRuntimeCompatibility } from '../../codex-runtime-config.js';

const CODEX_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access'
]);

const CODEX_APPROVAL_POLICIES = new Set([
  'never',
  'on-request',
  'on-failure',
  'unless-trusted'
]);
const CODEX_INITIAL_OUTPUT_TIMEOUT_MS = 15000;
const CODEX_NON_FATAL_STDERR_PATTERNS = [
  /Reading additional input from stdin\.\.\./i
];

function readRuntimeOption(source, ...keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null && String(source[key]).trim()) {
      return String(source[key]).trim();
    }
  }
  return '';
}

function normalizeRuntimeOption(value, allowedValues, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (allowedValues.has(normalized)) {
    return normalized;
  }
  return fallback;
}

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function buildCodexSpawnEnv(baseEnv = process.env, runtimeOptions = {}, { platform = process.platform } = {}) {
  const env = { ...baseEnv };
  const pathKey = Object.keys(env).find((key) => /^path$/i.test(key)) || 'PATH';

  if (
    platform === 'win32'
    && !runtimeOptions.dangerouslyBypass
    && env[pathKey]
    && parseBooleanFlag(env.CLIGATE_CODEX_FORCE_WINDOWS_POWERSHELL ?? '1')
  ) {
    const delimiter = path.delimiter;
    const filtered = String(env[pathKey])
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => !/[\\/](?:PowerShell|WindowsPowerShell)[\\/]7([\\/]|$)/i.test(entry));

    for (const key of Object.keys(env)) {
      if (/^path$/i.test(key)) {
        delete env[key];
      }
    }

    env.PATH = filtered.join(delimiter);
  }

  return env;
}

export function resolveCodexRuntimeOptions(session, { env = process.env } = {}) {
  const runtimeOptions = session?.metadata?.runtimeOptions || {};
  const codexOptions = runtimeOptions?.codex || session?.metadata?.codex || {};

  const dangerouslyBypass = parseBooleanFlag(
    codexOptions.dangerouslyBypass
      ?? runtimeOptions.dangerouslyBypass
      ?? env.CLIGATE_CODEX_DANGEROUSLY_BYPASS
  );

  const sandboxMode = normalizeRuntimeOption(
    readRuntimeOption(
      codexOptions,
      'sandboxMode',
      'sandbox_mode',
      'sandbox'
    ) || readRuntimeOption(runtimeOptions, 'sandboxMode', 'sandbox_mode', 'sandbox') || env.CLIGATE_CODEX_SANDBOX_MODE,
    CODEX_SANDBOX_MODES,
    'workspace-write'
  );

  const approvalPolicy = normalizeRuntimeOption(
    readRuntimeOption(
      codexOptions,
      'approvalPolicy',
      'approval_policy'
    ) || readRuntimeOption(runtimeOptions, 'approvalPolicy', 'approval_policy') || env.CLIGATE_CODEX_APPROVAL_POLICY,
    CODEX_APPROVAL_POLICIES,
    'never'
  );

  return {
    sandboxMode,
    approvalPolicy,
    dangerouslyBypass
  };
}

export function buildCodexExecArgs(session, input = '', { env = process.env } = {}) {
  const runtimeOptions = resolveCodexRuntimeOptions(session, { env });
  const args = ['exec'];

  if (runtimeOptions.dangerouslyBypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', runtimeOptions.sandboxMode);
    args.push('-c', `approval_policy="${runtimeOptions.approvalPolicy}"`);
  }
  args.push('--json');

  if (session.model) {
    args.push('--model', session.model);
  }

  if (session.cwd) {
    args.push('--cd', session.cwd);
  }

  args.push('--skip-git-repo-check');

  if (session.providerSessionId) {
    args.push('resume', session.providerSessionId);
  }

  const prompt = String(input || '').trim();
  if (prompt) {
    args.push(prompt);
  }

  return args;
}

function writeCodexInput(stream, value) {
  if (!stream?.writable) return;
  stream.write(String(value ?? ''));
  if (!String(value ?? '').endsWith('\n')) {
    stream.write('\n');
  }
}

function buildCodexApprovalResponse(approval, decision) {
  const raw = approval?.rawRequest || {};
  const approvalRequestId = raw.approval_request_id || raw.approvalRequestId || raw.id || raw.request_id || raw.requestId || '';
  if (!approvalRequestId) {
    return decision === 'approve' ? 'approve' : 'deny';
  }

  return JSON.stringify({
    type: 'mcp_approval_response',
    approval_request_id: approvalRequestId,
    approve: decision === 'approve'
  });
}

function buildCodexQuestionResponse(question, answer) {
  const raw = question?.rawRequest || {};
  if (raw?.request_id || raw?.requestId || raw?.type) {
    return JSON.stringify({
      type: 'input_response',
      request_id: raw.request_id || raw.requestId || question?.questionId,
      content: String(answer ?? '')
    });
  }
  return String(answer ?? '');
}

function summarizeCodexApproval(item = {}) {
  const parts = [];
  if (item?.title) parts.push(String(item.title));
  if (item?.name) parts.push(`tool=${item.name}`);
  if (item?.server_label) parts.push(`server=${item.server_label}`);
  if (item?.arguments) parts.push(String(item.arguments));
  return parts.join(' | ') || 'Codex approval request';
}

function summarizeCodexQuestion(item = {}) {
  return String(
    item?.text
      || item?.message
      || item?.prompt
      || item?.question
      || item?.summary
      || 'Codex requires additional input'
  );
}

export function createCodexMessageProcessor({
  session,
  onProviderEvent,
  onApprovalRequest,
  onQuestionRequest,
  onSessionPatch,
  closeInput
} = {}) {
  const pendingApprovals = new Map();
  const pendingQuestions = new Map();
  let terminalState = null;
  const state = {
    lastAgentMessage: ''
  };

  const emit = (event) => {
    onProviderEvent?.(event);
    if (event.type === AGENT_EVENT_TYPE.COMPLETED) {
      terminalState = {
        status: 'ready',
        summary: buildCompletionSummary(session, event.payload)
      };
      closeInput?.();
    } else if (event.type === AGENT_EVENT_TYPE.FAILED) {
      terminalState = {
        status: 'failed',
        error: event.payload?.message || 'Codex turn failed'
      };
      closeInput?.();
    }
  };

  const processMessage = (parsed) => {
    if (parsed?.type === 'thread.started' && parsed.thread_id) {
      onSessionPatch?.({ providerSessionId: parsed.thread_id });
      emit({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'thread_started',
          providerSessionId: parsed.thread_id
        }
      });
      return;
    }

    if (parsed?.type === 'turn.started') {
      emit({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'turn_started',
          turn: session?.turnCount
        }
      });
      return;
    }

    if (parsed?.type === 'turn.completed') {
      emit({
        type: AGENT_EVENT_TYPE.COMPLETED,
        payload: {
          result: state.lastAgentMessage || '',
          summary: buildCompletionSummary(session, {
            usage: parsed.usage || null,
            result: state.lastAgentMessage || ''
          }),
          usage: parsed.usage || null
        }
      });
      return;
    }

    if (parsed?.type === 'turn.failed' || parsed?.type === 'error') {
      emit({
        type: AGENT_EVENT_TYPE.FAILED,
        payload: {
          message: parsed?.error?.message || parsed?.message || 'Codex turn failed'
        }
      });
      return;
    }

    const item = parsed?.item || null;
    if (!item) {
      emit({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: parsed?.type || 'unknown',
          event: parsed
        }
      });
      return;
    }

    if (item.type === 'agent_message' && parsed?.type === 'item.completed') {
      const text = item.text || '';
      if (text) {
        state.lastAgentMessage = text;
      }
      emit({
        type: AGENT_EVENT_TYPE.MESSAGE,
        payload: {
          text,
          itemType: item.type
        }
      });
      return;
    }

    if (item.type === 'command_execution') {
      emit({
        type: AGENT_EVENT_TYPE.COMMAND,
        payload: {
          id: item.id,
          command: item.command,
          output: item.aggregated_output || '',
          exitCode: item.exit_code,
          status: item.status || (parsed?.type === 'item.completed' ? 'completed' : 'in_progress')
        }
      });
      return;
    }

    if (item.type === 'file_change') {
      emit({
        type: AGENT_EVENT_TYPE.FILE_CHANGE,
        payload: {
          id: item.id,
          status: item.status || (parsed?.type === 'item.completed' ? 'completed' : 'in_progress'),
          changes: Array.isArray(item.changes) ? item.changes : []
        }
      });
      return;
    }

    if (item.type === 'todo_list') {
      emit({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'todo_list',
          items: Array.isArray(item.items) ? item.items : []
        }
      });
      return;
    }

    if (item.type === 'reasoning') {
      emit({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'reasoning',
          text: item.text || ''
        }
      });
      return;
    }

    if (item.type === 'mcp_approval_request' && parsed?.type === 'item.completed') {
      const approvalKey = item.id || item.approval_request_id || item.approvalRequestId || `approval:${pendingApprovals.size + 1}`;
      pendingApprovals.set(approvalKey, item);
      onApprovalRequest?.({
        kind: 'tool_permission',
        title: item.title || item.name || 'Codex approval request',
        summary: summarizeCodexApproval(item),
        rawRequest: {
          ...item,
          approvalRequestId: approvalKey
        }
      });
      return;
    }

    if ((item.type === 'question' || item.type === 'input_request' || item.type === 'elicitation') && parsed?.type === 'item.completed') {
      const questionKey = item.id || item.request_id || item.requestId || `question:${pendingQuestions.size + 1}`;
      pendingQuestions.set(questionKey, item);
      onQuestionRequest?.({
        questionId: questionKey,
        text: summarizeCodexQuestion(item),
        options: Array.isArray(item.options) ? item.options : [],
        rawRequest: {
          ...item,
          requestId: questionKey
        }
      });
      return;
    }

    if (item.type === 'error') {
      emit({
        type: AGENT_EVENT_TYPE.FAILED,
        payload: {
          message: item.message || 'Codex reported an error item'
        }
      });
      return;
    }

    emit({
      type: AGENT_EVENT_TYPE.PROGRESS,
      payload: {
        phase: item.type || parsed?.type || 'unknown',
        event: parsed
      }
    });
  };

  return {
    pendingApprovals,
    pendingQuestions,
    processMessage,
    getLastAgentMessage() {
      return state.lastAgentMessage;
    },
    getTerminalState() {
      return terminalState;
    }
  };
}

function mapCodexEvent(session, event, state = {}) {
  const events = [];

  if (event?.type === 'thread.started') {
    events.push({
      type: AGENT_EVENT_TYPE.PROGRESS,
      payload: {
        phase: 'thread_started',
        providerSessionId: event.thread_id
      }
    });
  } else if (event?.type === 'turn.started') {
    events.push({
      type: AGENT_EVENT_TYPE.PROGRESS,
      payload: {
        phase: 'turn_started',
        turn: session.turnCount
      }
    });
  } else if (event?.type === 'item.started' || event?.type === 'item.updated' || event?.type === 'item.completed') {
    const item = event.item || {};
    if (item.type === 'agent_message') {
      if (event.type === 'item.completed') {
        const text = item.text || '';
        if (text) {
          state.lastAgentMessage = text;
        }
        events.push({
          type: AGENT_EVENT_TYPE.MESSAGE,
          payload: {
            text,
            itemType: item.type
          }
        });
      }
    } else if (item.type === 'command_execution') {
      events.push({
        type: AGENT_EVENT_TYPE.COMMAND,
        payload: {
          id: item.id,
          command: item.command,
          output: item.aggregated_output || '',
          exitCode: item.exit_code,
          status: item.status || 'in_progress'
        }
      });
    } else if (item.type === 'file_change') {
      events.push({
        type: AGENT_EVENT_TYPE.FILE_CHANGE,
        payload: {
          id: item.id,
          status: item.status,
          changes: Array.isArray(item.changes) ? item.changes : []
        }
      });
    } else if (item.type === 'todo_list') {
      events.push({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'todo_list',
          items: Array.isArray(item.items) ? item.items : []
        }
      });
    } else if (item.type === 'reasoning') {
      events.push({
        type: AGENT_EVENT_TYPE.PROGRESS,
        payload: {
          phase: 'reasoning',
          text: item.text || ''
        }
      });
    } else if (item.type === 'error') {
      events.push({
        type: AGENT_EVENT_TYPE.FAILED,
        payload: {
          message: item.message || 'Codex reported an error item'
        }
      });
    }
  } else if (event?.type === 'turn.completed') {
    events.push({
      type: AGENT_EVENT_TYPE.COMPLETED,
      payload: {
        result: state.lastAgentMessage || '',
        summary: buildCompletionSummary(session, {
          usage: event.usage || null,
          result: state.lastAgentMessage || ''
        }),
        usage: event.usage || null
      }
    });
  } else if (event?.type === 'turn.failed') {
    events.push({
      type: AGENT_EVENT_TYPE.FAILED,
      payload: {
        message: event.error?.message || 'Codex turn failed'
      }
    });
  } else if (event?.type === 'error') {
    events.push({
      type: AGENT_EVENT_TYPE.FAILED,
      payload: {
        message: event.message || 'Codex stream error'
      }
    });
  }

  return events;
}

export class CodexProvider {
  constructor() {
    this.id = 'codex';
    this.capabilities = {
      supportsResume: true,
      supportsStreamingEvents: true,
      supportsApprovalRequests: true,
      supportsInputInjection: true,
      supportsInterrupt: true
    };
  }

  async startTurn({ session, input, onProviderEvent, onApprovalRequest, onQuestionRequest, onSessionPatch, onTurnFinished, onTurnFailed }) {
    ensureCodexRuntimeCompatibility({
      cwd: session.cwd
    });

    const runtimeOptions = resolveCodexRuntimeOptions(session);
    const args = buildCodexExecArgs(session, input);
    const childEnv = buildCodexSpawnEnv(process.env, runtimeOptions);

    const spawnSpec = buildSpawnCommand('codex', args);

    let child;
    try {
      child = spawn(spawnSpec.command, spawnSpec.args, {
        cwd: session.cwd,
        env: childEnv
      });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw buildCliNotFoundError('codex', error);
      }
      throw error;
    }

    if (!child.stdout) {
      child.kill();
      throw new Error('Codex child process has no stdout');
    }

    const stderrChunks = [];
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });
    let turnSettled = false;
    let sawAnyOutput = false;
    let stdinClosed = false;
    const closeInputIfOpen = () => {
      if (!stdinClosed && child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        stdinClosed = true;
        child.stdin.end();
      }
    };
    const processor = createCodexMessageProcessor({
      session,
      onProviderEvent,
      onApprovalRequest,
      onQuestionRequest,
      onSessionPatch,
      closeInput: closeInputIfOpen
    });
    const settleSuccess = (payload = {}) => {
      if (turnSettled) return;
      turnSettled = true;
      clearTimeout(initialOutputTimer);
      onTurnFinished(payload);
    };
    const settleFailure = (error) => {
      if (turnSettled) return;
      turnSettled = true;
      clearTimeout(initialOutputTimer);
      onTurnFailed(error instanceof Error ? error : new Error(String(error || 'Codex turn failed')));
    };
    const initialOutputTimer = setTimeout(() => {
      if (turnSettled || sawAnyOutput) {
        return;
      }
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      closeInputIfOpen();
      if (!child.killed) {
        child.kill();
      }
      settleFailure(new Error(
        stderrText
          || 'Codex started but did not emit any events within 15 seconds.'
      ));
    }, CODEX_INITIAL_OUTPUT_TIMEOUT_MS);

    child.once('error', (error) => {
      rl.close();
      if (error?.code === 'ENOENT') {
        settleFailure(buildCliNotFoundError('codex', error));
        return;
      }
      settleFailure(error);
    });

    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });

    (async () => {
      try {
        for await (const line of rl) {
          const trimmed = String(line || '').trim();
          if (!trimmed) continue;
          sawAnyOutput = true;

          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            onProviderEvent({
              type: AGENT_EVENT_TYPE.PROGRESS,
              payload: {
                phase: 'stdout',
                text: trimmed
              }
            });
            continue;
          }

          if (turnSettled) {
            continue;
          }

          processor.processMessage(parsed);
          const resolvedTerminalState = processor.getTerminalState();
          if (resolvedTerminalState?.status === 'ready') {
            settleSuccess(resolvedTerminalState);
          } else if (resolvedTerminalState?.status === 'failed') {
            settleFailure(new Error(resolvedTerminalState.error));
          }
        }
      } catch (error) {
        settleFailure(error);
      }
    })();

    child.once('exit', (code, signal) => {
      rl.close();
      if (turnSettled) {
        return;
      }
      const resolvedTerminalState = processor.getTerminalState();
      const lastAgentMessage = processor.getLastAgentMessage();
      if (resolvedTerminalState?.status === 'ready') {
        settleSuccess(resolvedTerminalState);
        return;
      }
      if (resolvedTerminalState?.status === 'failed') {
        settleFailure(new Error(resolvedTerminalState.error));
        return;
      }

      if (code === 0 && !signal) {
        closeInputIfOpen();
        settleSuccess({
          status: 'ready',
          summary: buildCompletionSummary(session, {
            result: lastAgentMessage || ''
          })
        });
        return;
      }

      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      const meaningfulStderr = stderrText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !CODEX_NON_FATAL_STDERR_PATTERNS.some((pattern) => pattern.test(line)))
        .join('\n');
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      settleFailure(new Error(meaningfulStderr || stderrText || `Codex exited with ${detail}`));
    });

    if (!child.stdin) {
      child.kill();
      throw new Error('Codex child process has no stdin');
    }

    closeInputIfOpen();

    return {
      pid: child.pid || null,
      async respondApproval({ approval, decision }) {
        writeCodexInput(child.stdin, buildCodexApprovalResponse(approval, decision));
      },
      async respondQuestion({ question, answer }) {
        writeCodexInput(child.stdin, buildCodexQuestionResponse(question, answer));
      },
      cancel() {
        closeInputIfOpen();
        if (!child.killed) {
          child.kill();
        }
      }
    };
  }
}

function buildCompletionSummary(session, payload) {
  const result = String(payload?.result || '').trim();
  const usage = payload?.usage;
  if (result) {
    const snippet = result.replace(/\s+/g, ' ').slice(0, 320);
    if (usage) {
      return `${snippet}\n\n[Codex turn ${session.turnCount} | ${usage.input_tokens || 0}/${usage.output_tokens || 0} tokens]`;
    }
    return snippet;
  }
  if (usage) {
    return `Codex turn ${session.turnCount} completed (${usage.input_tokens || 0}/${usage.output_tokens || 0} tokens).`;
  }
  return `Codex turn ${session.turnCount} completed.`;
}

export default CodexProvider;
