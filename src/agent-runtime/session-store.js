import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';

export class AgentRuntimeSessionStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-runtime');
    this.eventsDir = join(this.rootDir, 'events');
    this.turnsDir = join(this.rootDir, 'turns');
    this.sessionsFile = join(this.rootDir, 'sessions.json');
    this.ensureDirs();
  }

  ensureDirs() {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(this.eventsDir)) {
      mkdirSync(this.eventsDir, { recursive: true, mode: 0o700 });
    }
    if (!existsSync(this.turnsDir)) {
      mkdirSync(this.turnsDir, { recursive: true, mode: 0o700 });
    }
  }

  _turnsFile(sessionId) {
    return join(this.turnsDir, `${sessionId}.json`);
  }

  loadSessions() {
    this.ensureDirs();
    if (!existsSync(this.sessionsFile)) return [];

    try {
      const parsed = JSON.parse(readFileSync(this.sessionsFile, 'utf8'));
      return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    } catch {
      return [];
    }
  }

  saveSessions(sessions) {
    this.ensureDirs();
    writeFileSync(
      this.sessionsFile,
      JSON.stringify({ sessions }, null, 2),
      { mode: 0o600 }
    );
  }

  appendEvent(sessionId, event) {
    this.ensureDirs();
    const file = join(this.eventsDir, `${sessionId}.jsonl`);
    appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }

  listEvents(sessionId, { afterSeq = 0, limit = 200 } = {}) {
    const file = join(this.eventsDir, `${sessionId}.jsonl`);
    if (!existsSync(file)) return [];

    try {
      const lines = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (Number(parsed?.seq) > Number(afterSeq || 0)) {
            events.push(parsed);
          }
        } catch {
          // ignore malformed lines
        }
      }
      return events.slice(-Math.max(0, limit));
    } catch {
      return [];
    }
  }

  loadTurns(sessionId) {
    this.ensureDirs();
    const file = this._turnsFile(sessionId);
    if (!existsSync(file)) return [];

    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(parsed?.turns) ? parsed.turns : [];
    } catch {
      return [];
    }
  }

  saveTurns(sessionId, turns) {
    this.ensureDirs();
    writeFileSync(
      this._turnsFile(sessionId),
      JSON.stringify({ turns: Array.isArray(turns) ? turns : [] }, null, 2),
      { mode: 0o600 }
    );
  }
}

export default AgentRuntimeSessionStore;

