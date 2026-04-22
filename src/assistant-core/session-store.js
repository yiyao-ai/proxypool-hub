import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { createAssistantSession } from './models.js';

function nowIso() {
  return new Date().toISOString();
}

export class AssistantSessionStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core');
    this.file = join(this.rootDir, 'assistant-sessions.json');
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
      return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    writeFileSync(
      this.file,
      JSON.stringify({ sessions: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ limit = 100 } = {}) {
    return [...this.records]
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  get(sessionId) {
    return this.records.find((entry) => entry.id === String(sessionId || '')) || null;
  }

  findByConversationId(conversationId) {
    return this.records.find((entry) => entry.conversationId === String(conversationId || '')) || null;
  }

  save(session) {
    const updated = {
      ...session,
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

  findOrCreateByConversationId(conversationId, patch = {}) {
    const existing = this.findByConversationId(conversationId);
    if (existing) {
      return this.save({
        ...existing,
        ...patch
      });
    }

    return this.save(createAssistantSession({
      conversationId,
      ...patch
    }));
  }
}

export const assistantSessionStore = new AssistantSessionStore();

export default assistantSessionStore;

