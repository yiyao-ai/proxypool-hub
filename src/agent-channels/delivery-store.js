import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { CONFIG_DIR } from '../account-manager.js';
import { createChannelDeliveryRecord } from './models.js';

export class AgentChannelDeliveryStore {
  constructor({ configDir = CONFIG_DIR } = {}) {
    this.rootDir = join(configDir, 'agent-channels');
    this.inboundFile = join(this.rootDir, 'processed-inbound.json');
    this.outboundFile = join(this.rootDir, 'deliveries.jsonl');
    this.ensureDirs();
    this.processedInbound = this._loadProcessedInbound();
  }

  ensureDirs() {
    if (!existsSync(this.rootDir)) {
      mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    }
  }

  _loadProcessedInbound() {
    this.ensureDirs();
    if (!existsSync(this.inboundFile)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.inboundFile, 'utf8'));
      return Array.isArray(parsed?.keys) ? parsed.keys : [];
    } catch {
      return [];
    }
  }

  _saveProcessedInbound() {
    this.ensureDirs();
    writeFileSync(
      this.inboundFile,
      JSON.stringify({ keys: this.processedInbound }, null, 2),
      { mode: 0o600 }
    );
  }

  isInboundProcessed(key) {
    return this.processedInbound.includes(String(key || ''));
  }

  markInboundProcessed(key) {
    const normalized = String(key || '');
    if (!normalized || this.isInboundProcessed(normalized)) {
      return false;
    }
    this.processedInbound.push(normalized);
    this._saveProcessedInbound();
    return true;
  }

  saveInbound(record) {
    const normalized = createChannelDeliveryRecord({
      ...record,
      direction: 'inbound'
    });
    this.ensureDirs();
    appendFileSync(this.outboundFile, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
    return normalized;
  }

  saveOutbound(record) {
    const normalized = createChannelDeliveryRecord({
      ...record,
      direction: 'outbound'
    });
    this.ensureDirs();
    appendFileSync(this.outboundFile, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
    return normalized;
  }

  listByConversation(conversationId, { limit = 100 } = {}) {
    if (!existsSync(this.outboundFile)) return [];
    try {
      const rows = readFileSync(this.outboundFile, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .filter((entry) => entry.conversationId === conversationId);
      return rows.slice(-Math.max(1, limit));
    } catch {
      return [];
    }
  }
}

export const agentChannelDeliveryStore = new AgentChannelDeliveryStore();

export default agentChannelDeliveryStore;
