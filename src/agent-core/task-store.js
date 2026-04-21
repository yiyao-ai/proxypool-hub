import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';

function nowIso() {
  return new Date().toISOString();
}

export class AgentTaskStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-core');
    this.file = join(this.rootDir, 'tasks.json');
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
      return Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    writeFileSync(
      this.file,
      JSON.stringify({ tasks: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ conversationId, runtimeSessionId, limit = 100 } = {}) {
    return this.records
      .filter((entry) => (
        (!conversationId || entry.conversationId === String(conversationId))
        && (!runtimeSessionId || entry.runtimeSessionId === String(runtimeSessionId))
      ))
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  get(taskId) {
    return this.records.find((entry) => entry.id === String(taskId || '')) || null;
  }

  findByRuntimeSessionId(runtimeSessionId) {
    return this.records.find((entry) => entry.runtimeSessionId === String(runtimeSessionId || '')) || null;
  }

  findLatestByConversation(conversationId) {
    return this.list({ conversationId, limit: 1 })[0] || null;
  }

  save(task) {
    const index = this.records.findIndex((entry) => entry.id === task.id);
    const updated = {
      ...task,
      updatedAt: nowIso()
    };

    if (index >= 0) {
      this.records[index] = updated;
    } else {
      this.records.push(updated);
    }

    this._save();
    return updated;
  }

  create({
    conversationId = '',
    runtimeSessionId = '',
    provider = '',
    title = '',
    status = 'starting',
    input = '',
    summary = '',
    result = '',
    error = '',
    originKind = 'direct',
    metadata = {}
  } = {}) {
    const now = nowIso();
    return this.save({
      id: crypto.randomUUID(),
      conversationId: String(conversationId || ''),
      runtimeSessionId: String(runtimeSessionId || ''),
      provider: String(provider || ''),
      title: String(title || input || 'Untitled task'),
      status: String(status || 'starting'),
      input: String(input || ''),
      summary: String(summary || ''),
      result: String(result || ''),
      error: String(error || ''),
      originKind: String(originKind || 'direct'),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      createdAt: now,
      updatedAt: now
    });
  }
}

export const agentTaskStore = new AgentTaskStore();

export default agentTaskStore;
