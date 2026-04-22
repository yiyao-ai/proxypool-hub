import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { createAssistantRun } from './models.js';

function nowIso() {
  return new Date().toISOString();
}

export class AssistantRunStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core');
    this.file = join(this.rootDir, 'assistant-runs.json');
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
      return Array.isArray(parsed?.runs) ? parsed.runs : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    writeFileSync(
      this.file,
      JSON.stringify({ runs: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ assistantSessionId, limit = 100 } = {}) {
    return this.records
      .filter((entry) => !assistantSessionId || entry.assistantSessionId === String(assistantSessionId))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  get(runId) {
    return this.records.find((entry) => entry.id === String(runId || '')) || null;
  }

  save(run) {
    const updated = {
      ...run,
      updatedAt: nowIso()
    };
    const index = this.records.findIndex((entry) => entry.id === updated.id);
    if (index >= 0) {
      this.records[index] = updated;
    } else {
      this.records.push(updated);
    }
    this._save();
    return updated;
  }

  create(payload = {}) {
    return this.save(createAssistantRun(payload));
  }
}

export const assistantRunStore = new AssistantRunStore();

export default assistantRunStore;

