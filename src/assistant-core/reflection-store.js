import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { mergeJsonRecords } from './merge-json-records.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKeywords(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((entry) => normalizeText(entry).toLowerCase())
      .filter(Boolean)
  )];
}

export class AssistantReflectionStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core');
    this.file = join(this.rootDir, 'reflections.json');
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
      return Array.isArray(parsed?.reflections) ? parsed.reflections : [];
    } catch {
      return [];
    }
  }

  _save() {
    this.ensureDirs();
    let diskRecords = [];
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
        diskRecords = Array.isArray(parsed?.reflections) ? parsed.reflections : [];
      } catch {
        diskRecords = [];
      }
    }
    this.records = mergeJsonRecords({
      currentRecords: this.records,
      diskRecords,
      keyOf: (entry) => entry?.id
    });
    writeFileSync(
      this.file,
      JSON.stringify({ reflections: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  saveReflection({
    id = '',
    kind = 'postmortem',
    taskId = '',
    conversationId = '',
    workspaceId = '',
    cwd = '',
    payload = {}
  } = {}) {
    const normalizedTaskId = normalizeText(taskId);
    const record = {
      id: normalizeText(id) || crypto.randomUUID(),
      kind: normalizeText(kind) || 'postmortem',
      taskId: normalizedTaskId,
      conversationId: normalizeText(conversationId),
      workspaceId: normalizeText(workspaceId),
      cwd: normalizeText(cwd),
      payload: {
        purpose: normalizeText(payload?.purpose),
        outcome: normalizeText(payload?.outcome),
        deliverables: Array.isArray(payload?.deliverables)
          ? payload.deliverables.map((entry) => normalizeText(entry)).filter(Boolean)
          : [],
        next: normalizeText(payload?.next),
        keywords: normalizeKeywords(payload?.keywords)
      },
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    const existingIndex = this.records.findIndex((entry) => (
      entry.kind === record.kind
      && normalizeText(entry.taskId) === normalizedTaskId
      && normalizedTaskId
    ));
    if (existingIndex >= 0) {
      this.records[existingIndex] = {
        ...this.records[existingIndex],
        ...record,
        createdAt: this.records[existingIndex].createdAt || record.createdAt,
        updatedAt: nowIso()
      };
    } else {
      this.records.push(record);
    }
    this._save();
    return this.records[existingIndex >= 0 ? existingIndex : this.records.length - 1];
  }

  getLatestPostmortemByTaskId(taskId = '') {
    const normalizedTaskId = normalizeText(taskId);
    if (!normalizedTaskId) return null;
    return this.records
      .filter((entry) => entry.kind === 'postmortem' && normalizeText(entry.taskId) === normalizedTaskId)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
  }

  list({ kind = '', taskId = '', conversationId = '', limit = 100 } = {}) {
    const normalizedKind = normalizeText(kind);
    const normalizedTaskId = normalizeText(taskId);
    const normalizedConversationId = normalizeText(conversationId);
    return this.records
      .filter((entry) => !normalizedKind || entry.kind === normalizedKind)
      .filter((entry) => !normalizedTaskId || normalizeText(entry.taskId) === normalizedTaskId)
      .filter((entry) => !normalizedConversationId || normalizeText(entry.conversationId) === normalizedConversationId)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }
}

export const assistantReflectionStore = new AssistantReflectionStore();

export default assistantReflectionStore;
