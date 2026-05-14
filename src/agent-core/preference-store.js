import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';

const CANONICAL_SCOPE_BY_ALIAS = {
  execution: 'execution',
  runtime_session: 'execution',
  session: 'execution',
  task: 'task',
  conversation: 'task',
  project: 'project',
  workspace: 'project',
  person: 'person',
  global_user: 'person',
  global: 'person'
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeScope(scope = '') {
  const value = String(scope || '').trim();
  if (!value) return '';
  return CANONICAL_SCOPE_BY_ALIAS[value] || value;
}

export class AgentPreferenceStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-core');
    this.file = join(this.rootDir, 'preferences.json');
    this.ensureDirs();
    this.records = this._load();
  }

  ensureDirs() {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  _load() {
    this.ensureDirs();
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      return Array.isArray(parsed?.preferences) ? parsed.preferences : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    writeFileSync(
      this.file,
      JSON.stringify({ preferences: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  listPreferences({ scope, scopeRef, key } = {}) {
    const normalizedScope = normalizeScope(scope);
    return this.records.filter((entry) => (
      (!normalizedScope || normalizeScope(entry.scope) === normalizedScope)
      && (!scopeRef || entry.scopeRef === String(scopeRef))
      && (!key || entry.key === String(key))
    ));
  }

  getPreference({ scope, scopeRef, key } = {}) {
    const normalizedScope = normalizeScope(scope);
    return this.records.find((entry) => (
      normalizeScope(entry.scope) === normalizedScope
      && entry.scopeRef === String(scopeRef || '')
      && entry.key === String(key || '')
    )) || null;
  }

  upsertPreference({ scope = 'task', scopeRef, key, value, metadata = {} } = {}) {
    if (!scopeRef) {
      throw new Error('scopeRef is required');
    }
    if (!key) {
      throw new Error('key is required');
    }

    const normalizedScope = normalizeScope(scope) || 'task';
    const existing = this.getPreference({ scope: normalizedScope, scopeRef, key });
    if (existing) {
      existing.value = value;
      existing.scope = normalizedScope;
      existing.metadata = metadata && typeof metadata === 'object' ? metadata : {};
      existing.updatedAt = nowIso();
      this._save();
      return existing;
    }

    const record = {
      id: crypto.randomUUID(),
      scope: normalizedScope,
      scopeRef: String(scopeRef),
      key: String(key),
      value,
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    this.records.push(record);
    this._save();
    return record;
  }
}

export const agentPreferenceStore = new AgentPreferenceStore();

export default agentPreferenceStore;
