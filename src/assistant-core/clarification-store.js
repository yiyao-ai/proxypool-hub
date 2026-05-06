import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { mergeJsonRecords } from './merge-json-records.js';
import { createPendingClarification } from './models.js';

function nowIso() {
  return new Date().toISOString();
}

function toText(value) {
  return String(value || '').trim();
}

function isExpired(record = null, now = Date.now()) {
  if (!record) return false;
  if (['answered', 'expired', 'cancelled'].includes(toText(record.status))) {
    return false;
  }
  const askedAtMs = Date.parse(record.askedAt || record.createdAt || '');
  const ttlMs = Math.max(0, Number(record.ttlSec || 0)) * 1000;
  if (!Number.isFinite(askedAtMs) || ttlMs <= 0) {
    return false;
  }
  return askedAtMs + ttlMs <= now;
}

function normalizeCandidate(entry = {}, index = 0) {
  return {
    kind: toText(entry?.kind) || 'free',
    id: toText(entry?.id) || `candidate_${index + 1}`,
    label: toText(entry?.label || entry?.id) || `Candidate ${index + 1}`,
    ...(Number.isFinite(Number(entry?.confidence))
      ? { confidence: Number(entry.confidence) }
      : {})
  };
}

function normalizeRecord(record = {}) {
  if (!record || typeof record !== 'object') return null;
  const id = toText(record.id);
  if (!id) return null;
  return {
    id,
    conversationId: toText(record.conversationId),
    askedAt: toText(record.askedAt) || toText(record.createdAt) || nowIso(),
    question: toText(record.question),
    candidates: Array.isArray(record.candidates) ? record.candidates.map(normalizeCandidate).filter(Boolean) : [],
    status: toText(record.status) || 'pending',
    ttlSec: Math.max(0, Number(record.ttlSec || 0)) || 1800,
    resolution: record.resolution && typeof record.resolution === 'object'
      ? {
          ...(toText(record.resolution.selectedCandidateId)
            ? { selectedCandidateId: toText(record.resolution.selectedCandidateId) }
            : {}),
          ...(toText(record.resolution.freeTextAnswer)
            ? { freeTextAnswer: toText(record.resolution.freeTextAnswer) }
            : {}),
          answeredAt: toText(record.resolution.answeredAt) || nowIso()
        }
      : null,
    createdAt: toText(record.createdAt) || nowIso(),
    updatedAt: toText(record.updatedAt) || nowIso()
  };
}

export class AssistantClarificationStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'assistant-core');
    this.file = join(this.rootDir, 'pending-clarifications.json');
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
      return Array.isArray(parsed?.clarifications)
        ? parsed.clarifications.map(normalizeRecord).filter(Boolean)
        : [];
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
        diskRecords = Array.isArray(parsed?.clarifications)
          ? parsed.clarifications.map(normalizeRecord).filter(Boolean)
          : [];
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
      JSON.stringify({ clarifications: this.records }, null, 2),
      { mode: 0o600 }
    );
  }

  list({ conversationId = '', status = '', limit = 100 } = {}) {
    this.expirePending();
    const normalizedConversationId = toText(conversationId);
    const normalizedStatus = toText(status);
    return [...this.records]
      .filter((entry) => !normalizedConversationId || entry.conversationId === normalizedConversationId)
      .filter((entry) => !normalizedStatus || entry.status === normalizedStatus)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))
      .slice(0, Math.max(1, limit));
  }

  get(clarificationId) {
    this.expirePending();
    return this.records.find((entry) => entry.id === toText(clarificationId)) || null;
  }

  getPendingByConversationId(conversationId) {
    this.expirePending();
    return this.records.find((entry) => (
      entry.conversationId === toText(conversationId)
      && entry.status === 'pending'
    )) || null;
  }

  save(record = {}) {
    const updated = normalizeRecord({
      ...record,
      updatedAt: nowIso()
    });
    if (!updated) {
      throw new Error('clarification id is required');
    }
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
    return this.save(createPendingClarification(payload));
  }

  answer(clarificationId, {
    selectedCandidateId = '',
    freeTextAnswer = ''
  } = {}) {
    const current = this.get(clarificationId);
    if (!current) return null;
    return this.save({
      ...current,
      status: 'answered',
      resolution: {
        ...(toText(selectedCandidateId) ? { selectedCandidateId: toText(selectedCandidateId) } : {}),
        ...(toText(freeTextAnswer) ? { freeTextAnswer: toText(freeTextAnswer) } : {}),
        answeredAt: nowIso()
      }
    });
  }

  cancel(clarificationId) {
    const current = this.get(clarificationId);
    if (!current) return null;
    return this.save({
      ...current,
      status: 'cancelled'
    });
  }

  expirePending() {
    const now = Date.now();
    let changed = false;
    this.records = this.records.map((entry) => {
      if (!isExpired(entry, now)) return entry;
      changed = true;
      return {
        ...entry,
        status: 'expired',
        updatedAt: nowIso()
      };
    });
    if (changed) {
      this._save();
    }
    return changed;
  }
}

export const assistantClarificationStore = new AssistantClarificationStore();

export default assistantClarificationStore;
