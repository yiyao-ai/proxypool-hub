import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { platform as getPlatform } from 'os';
import path from 'path';

const TOOL_DEFAULTS = Object.freeze({
  codex: {
    envVar: 'CLIGATE_CODEX_BIN',
    command: 'codex'
  },
  'claude-code': {
    envVar: 'CLIGATE_CLAUDE_CODE_BIN',
    command: 'claude'
  }
});

function normalizeCandidates(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function scoreWindowsCandidate(candidate) {
  const lower = candidate.toLowerCase();
  if (lower.endsWith('.cmd')) return 30;
  if (lower.endsWith('.exe')) return 20;
  if (lower.endsWith('.bat')) return 10;
  return 0;
}

export function resolveCliExecutable(toolId, {
  env = process.env,
  platform = getPlatform(),
  whereResolver = (command) => execFileSync('where.exe', [command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
} = {}) {
  const tool = TOOL_DEFAULTS[toolId];
  if (!tool) {
    throw new Error(`Unknown CLI tool: ${toolId}`);
  }

  const overridden = env?.[tool.envVar];
  if (overridden && String(overridden).trim()) {
    return String(overridden).trim();
  }

  if (platform === 'win32') {
    try {
      const candidates = normalizeCandidates(whereResolver(tool.command));
      if (candidates.length > 0) {
        return [...candidates].sort((left, right) => scoreWindowsCandidate(right) - scoreWindowsCandidate(left))[0];
      }
    } catch {
      // Fall through to the bare command below.
    }
  }

  return tool.command;
}

export function buildCliNotFoundError(toolId, cause = null) {
  const tool = TOOL_DEFAULTS[toolId];
  const label = toolId === 'claude-code' ? 'Claude Code CLI' : 'Codex CLI';
  const envHint = tool?.envVar ? ` or set ${tool.envVar}` : '';
  const detail = cause?.message ? ` (${cause.message})` : '';
  return new Error(`${label} was not found. Install the CLI, ensure it is on PATH${envHint}.${detail}`.trim());
}

function quoteForCmd(value) {
  const text = String(value ?? '');
  if (!text) return '""';
  if (!/[\s"]/u.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function tryResolveNodeShim(executable) {
  try {
    const content = readFileSync(executable, 'utf8');
    const match = content.match(/"%dp0%\\([^"]+)" %\*/i);
    if (!match) {
      return null;
    }

    const baseDir = path.dirname(executable);
    const relativeScript = match[1].replace(/\\/g, path.sep);
    const scriptPath = path.join(baseDir, relativeScript);
    if (!existsSync(scriptPath)) {
      return null;
    }

    const bundledNode = path.join(baseDir, 'node.exe');
    return {
      command: existsSync(bundledNode) ? bundledNode : 'node',
      bootstrapArgs: [scriptPath]
    };
  } catch {
    return null;
  }
}

export function buildSpawnCommand(toolId, args = [], {
  env = process.env,
  platform = getPlatform(),
  whereResolver
} = {}) {
  const executable = resolveCliExecutable(toolId, { env, platform, whereResolver });
  const normalizedArgs = Array.isArray(args) ? args.map((item) => String(item)) : [];

  if (platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const nodeShim = tryResolveNodeShim(executable);
    if (nodeShim) {
      return {
        command: nodeShim.command,
        args: [...nodeShim.bootstrapArgs, ...normalizedArgs]
      };
    }

    const commandLine = [quoteForCmd(executable), ...normalizedArgs.map(quoteForCmd)].join(' ');
    return {
      command: env?.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine]
    };
  }

  return {
    command: executable,
    args: normalizedArgs
  };
}

export default {
  resolveCliExecutable,
  buildCliNotFoundError,
  buildSpawnCommand
};
