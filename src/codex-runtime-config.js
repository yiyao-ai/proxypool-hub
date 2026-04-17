import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path, { dirname, join, resolve } from 'path';
import { homedir } from 'os';

const CODEX_DIR = join(homedir(), '.codex');
const CODEX_CONFIG_FILE = join(CODEX_DIR, 'config.toml');

const RECOMMENDED_CODEX_RUNTIME_SETTINGS = Object.freeze({
  allowLoginShell: false,
  sandboxMode: 'workspace-write',
  powershellUtf8: false,
  windowsSandbox: 'unelevated'
});

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function ensureParentDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function ensureTrailingNewline(text) {
  const value = String(text || '');
  return value.endsWith('\n') ? value : `${value}\n`;
}

function normalizeWindowsExtendedPath(inputPath) {
  const resolved = resolve(String(inputPath || ''));
  if (!resolved || process.platform !== 'win32') {
    return resolved;
  }

  if (resolved.startsWith('\\\\?\\')) {
    return resolved;
  }

  if (/^[A-Za-z]:\\/.test(resolved)) {
    return `\\\\?\\${resolved}`;
  }

  return resolved;
}

function buildTrustedProjectKeys(cwd) {
  const target = String(cwd || '').trim();
  if (!target) {
    return [];
  }

  const resolved = resolve(target);
  const keys = [resolved];
  const extended = normalizeWindowsExtendedPath(resolved);
  if (extended && extended !== resolved) {
    keys.push(extended);
  }
  return [...new Set(keys.filter(Boolean))];
}

function ensureTopLevelKey(content, key, valueLiteral) {
  const source = String(content || '');
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*.*$`, 'm');
  if (pattern.test(source)) {
    return source.replace(pattern, `${key} = ${valueLiteral}`);
  }

  const lines = source.split('\n');
  let insertIdx = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('[')) {
      break;
    }
    insertIdx = index + 1;
  }
  lines.splice(insertIdx, 0, `${key} = ${valueLiteral}`);
  return lines.join('\n');
}

function findSectionRange(content, sectionName) {
  const source = String(content || '');
  const lines = source.split('\n');
  const header = `[${sectionName}]`;
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() === header) {
      start = index;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('[')) {
      end = index;
      break;
    }
  }

  return { lines, start, end };
}

function ensureSectionKey(content, sectionName, key, valueLiteral) {
  let source = ensureTrailingNewline(content);
  let section = findSectionRange(source, sectionName);

  if (!section) {
    source = `${source.trimEnd()}\n\n[${sectionName}]\n${key} = ${valueLiteral}\n`;
    return source;
  }

  const { lines, start, end } = section;
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*.*$`);

  for (let index = start + 1; index < end; index += 1) {
    if (keyPattern.test(lines[index])) {
      lines[index] = `${key} = ${valueLiteral}`;
      return lines.join('\n');
    }
  }

  lines.splice(end, 0, `${key} = ${valueLiteral}`);
  return lines.join('\n');
}

function parseTopLevelKey(content, key) {
  const match = String(content || '').match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function parseSectionKey(content, sectionName, key) {
  const section = findSectionRange(content, sectionName);
  if (!section) {
    return null;
  }

  const { lines, start, end } = section;
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*=\\s*(.+)$`);
  for (let index = start + 1; index < end; index += 1) {
    const match = lines[index].match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

export function readCodexConfig(filePath = CODEX_CONFIG_FILE) {
  if (!existsSync(filePath)) {
    return '';
  }
  return readFileSync(filePath, 'utf8');
}

export function getCodexRuntimeCompatibilityStatus(content = '') {
  return {
    allowLoginShell: parseTopLevelKey(content, 'allow_login_shell'),
    sandboxMode: parseTopLevelKey(content, 'sandbox_mode'),
    powershellUtf8: parseSectionKey(content, 'features', 'powershell_utf8'),
    windowsSandbox: parseSectionKey(content, 'windows', 'sandbox')
  };
}

export function applyCodexRuntimeCompatibility(content = '', {
  cwd = '',
  settings = RECOMMENDED_CODEX_RUNTIME_SETTINGS
} = {}) {
  let next = ensureTrailingNewline(content);
  next = ensureTopLevelKey(next, 'allow_login_shell', settings.allowLoginShell ? 'true' : 'false');
  next = ensureTopLevelKey(next, 'sandbox_mode', JSON.stringify(settings.sandboxMode));
  next = ensureSectionKey(next, 'features', 'powershell_utf8', settings.powershellUtf8 ? 'true' : 'false');

  if (process.platform === 'win32' && settings.windowsSandbox) {
    next = ensureSectionKey(next, 'windows', 'sandbox', JSON.stringify(settings.windowsSandbox));
  }

  for (const projectKey of buildTrustedProjectKeys(cwd)) {
    next = ensureSectionKey(next, `projects.'${projectKey}'`, 'trust_level', JSON.stringify('trusted'));
  }

  return next;
}

export function ensureCodexRuntimeCompatibility({
  cwd = '',
  filePath = CODEX_CONFIG_FILE,
  settings = RECOMMENDED_CODEX_RUNTIME_SETTINGS
} = {}) {
  ensureParentDir(filePath);
  const current = readCodexConfig(filePath);
  const next = applyCodexRuntimeCompatibility(current, { cwd, settings });

  if (next !== current) {
    writeFileSync(filePath, next, 'utf8');
  }

  return {
    filePath,
    updated: next !== current,
    trustedProjects: buildTrustedProjectKeys(cwd),
    compatibility: getCodexRuntimeCompatibilityStatus(next)
  };
}

export {
  CODEX_DIR,
  CODEX_CONFIG_FILE,
  RECOMMENDED_CODEX_RUNTIME_SETTINGS
};

export default {
  CODEX_DIR,
  CODEX_CONFIG_FILE,
  RECOMMENDED_CODEX_RUNTIME_SETTINGS,
  readCodexConfig,
  getCodexRuntimeCompatibilityStatus,
  applyCodexRuntimeCompatibility,
  ensureCodexRuntimeCompatibility
};
