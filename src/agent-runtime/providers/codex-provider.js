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

export function buildCodexExecArgs(session, { env = process.env } = {}) {
  const runtimeOptions = resolveCodexRuntimeOptions(session, { env });
  const args = [];

  if (runtimeOptions.dangerouslyBypass) {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', runtimeOptions.sandboxMode);
    args.push('--ask-for-approval', runtimeOptions.approvalPolicy);
  }

  args.push('exec', '--experimental-json');

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

  return args;
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
      supportsApprovalRequests: false,
      supportsInputInjection: true,
      supportsInterrupt: true
    };
  }

  async startTurn({ session, input, onProviderEvent, onSessionPatch, onTurnFinished, onTurnFailed }) {
    ensureCodexRuntimeCompatibility({
      cwd: session.cwd
    });

    const runtimeOptions = resolveCodexRuntimeOptions(session);
    const args = buildCodexExecArgs(session);
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

    let terminalState = null;
    const stderrChunks = [];
    const state = {
      lastAgentMessage: ''
    };
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity
    });

    const pushMappedEvents = (parsed) => {
      if (parsed?.type === 'thread.started' && parsed.thread_id) {
        onSessionPatch({ providerSessionId: parsed.thread_id });
      }

      const mappedEvents = mapCodexEvent(session, parsed, state);
      for (const event of mappedEvents) {
        onProviderEvent(event);
        if (event.type === AGENT_EVENT_TYPE.COMPLETED) {
          terminalState = { status: 'ready', summary: buildCompletionSummary(session, event.payload) };
        } else if (event.type === AGENT_EVENT_TYPE.FAILED) {
          terminalState = { status: 'failed', error: event.payload?.message || 'Codex turn failed' };
        }
      }
    };

    child.once('error', (error) => {
      rl.close();
      if (error?.code === 'ENOENT') {
        onTurnFailed(buildCliNotFoundError('codex', error));
        return;
      }
      onTurnFailed(error);
    });

    child.stderr?.on('data', (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });

    (async () => {
      try {
        for await (const line of rl) {
          const trimmed = String(line || '').trim();
          if (!trimmed) continue;

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

          pushMappedEvents(parsed);
        }
      } catch (error) {
        onTurnFailed(error);
      }
    })();

    child.once('exit', (code, signal) => {
      rl.close();
      if (terminalState?.status === 'ready') {
        onTurnFinished(terminalState);
        return;
      }
      if (terminalState?.status === 'failed') {
        onTurnFailed(new Error(terminalState.error));
        return;
      }

      if (code === 0 && !signal) {
        onTurnFinished({
          status: 'ready',
          summary: buildCompletionSummary(session, {
            result: state.lastAgentMessage || ''
          })
        });
        return;
      }

      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      onTurnFailed(new Error(stderrText || `Codex exited with ${detail}`));
    });

    if (!child.stdin) {
      child.kill();
      throw new Error('Codex child process has no stdin');
    }

    child.stdin.write(String(input || ''));
    child.stdin.end();

    return {
      pid: child.pid || null,
      cancel() {
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
