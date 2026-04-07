import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './account-manager.js';

const LOCAL_RUNTIMES_FILE = join(CONFIG_DIR, 'local-runtimes.json');

const DEFAULT_RUNTIME = {
  id: 'ollama-local',
  type: 'ollama',
  name: 'Local Ollama',
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
  defaultModels: {
    codex: '',
    'claude-code': '',
    openclaw: ''
  },
  updatedAt: null
};

let cachedData = null;

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function normalizeRuntime(runtime = {}) {
  return {
    ...DEFAULT_RUNTIME,
    ...runtime,
    defaultModels: {
      ...DEFAULT_RUNTIME.defaultModels,
      ...(runtime.defaultModels || {})
    },
    id: runtime.id || DEFAULT_RUNTIME.id,
    type: 'ollama',
    name: runtime.name || DEFAULT_RUNTIME.name,
    baseUrl: String(runtime.baseUrl || DEFAULT_RUNTIME.baseUrl).replace(/\/+$/, ''),
    enabled: runtime.enabled !== false,
    updatedAt: runtime.updatedAt || null
  };
}

function defaultData() {
  return {
    runtimes: [normalizeRuntime(DEFAULT_RUNTIME)]
  };
}

function loadData() {
  if (cachedData) return cachedData;

  ensureConfigDir();
  if (!existsSync(LOCAL_RUNTIMES_FILE)) {
    cachedData = defaultData();
    return cachedData;
  }

  try {
    const parsed = JSON.parse(readFileSync(LOCAL_RUNTIMES_FILE, 'utf8'));
    const runtimes = Array.isArray(parsed?.runtimes) ? parsed.runtimes.map(normalizeRuntime) : [normalizeRuntime(DEFAULT_RUNTIME)];
    cachedData = { runtimes };
  } catch {
    cachedData = defaultData();
  }

  return cachedData;
}

function saveData() {
  ensureConfigDir();
  writeFileSync(LOCAL_RUNTIMES_FILE, JSON.stringify(cachedData, null, 2), { mode: 0o600 });
}

export function listLocalRuntimes() {
  return loadData().runtimes;
}

export function getLocalRuntimeById(id = DEFAULT_RUNTIME.id) {
  return listLocalRuntimes().find((runtime) => runtime.id === id) || null;
}

export function getPrimaryLocalRuntime() {
  return listLocalRuntimes().find((runtime) => runtime.enabled !== false) || null;
}

export function updateLocalRuntime(id, patch = {}) {
  const data = loadData();
  const index = data.runtimes.findIndex((runtime) => runtime.id === id);
  const nextRuntime = normalizeRuntime({
    ...(index >= 0 ? data.runtimes[index] : DEFAULT_RUNTIME),
    ...patch,
    defaultModels: {
      ...(index >= 0 ? data.runtimes[index].defaultModels : DEFAULT_RUNTIME.defaultModels),
      ...(patch.defaultModels || {})
    },
    updatedAt: new Date().toISOString()
  });

  if (index >= 0) {
    data.runtimes[index] = nextRuntime;
  } else {
    data.runtimes.push(nextRuntime);
  }

  cachedData = data;
  saveData();
  return nextRuntime;
}

export function getDefaultLocalModel(appId) {
  const runtime = getPrimaryLocalRuntime();
  if (!runtime) return '';
  return runtime.defaultModels?.[appId] || '';
}

export { LOCAL_RUNTIMES_FILE };

export default {
  listLocalRuntimes,
  getLocalRuntimeById,
  getPrimaryLocalRuntime,
  updateLocalRuntime,
  getDefaultLocalModel,
  LOCAL_RUNTIMES_FILE
};
