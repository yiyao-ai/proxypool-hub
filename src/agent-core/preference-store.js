import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';

function nowIso() {
  return new Date().toISOString();
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
    return this.records.filter((entry) => (
      (!scope || entry.scope === scope)
      && (!scopeRef || entry.scopeRef === String(scopeRef))
      && (!key || entry.key === String(key))
    ));
  }

  getPreference({ scope, scopeRef, key } = {}) {
    return this.records.find((entry) => (
      entry.scope === String(scope || '')
      && entry.scopeRef === String(scopeRef || '')
      && entry.key === String(key || '')
    )) || null;
  }

  upsertPreference({ scope = 'conversation', scopeRef, key, value, metadata = {} } = {}) {
    if (!scopeRef) {
      throw new Error('scopeRef is required');
    }
    if (!key) {
      throw new Error('key is required');
    }

    const existing = this.getPreference({ scope, scopeRef, key });
    if (existing) {
      existing.value = value;
      existing.metadata = metadata && typeof metadata === 'object' ? metadata : {};
      existing.updatedAt = nowIso();
      this._save();
      return existing;
    }

    const record = {
      id: crypto.randomUUID(),
      scope: String(scope || 'conversation'),
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
