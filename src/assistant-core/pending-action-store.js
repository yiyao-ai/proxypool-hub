import crypto from 'crypto';

const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

function nowTs() {
  return Date.now();
}

function normalizeText(value) {
  return String(value || '').trim();
}

export class AssistantPendingActionStore {
  constructor() {
    this.actions = new Map();
  }

  cleanupExpired() {
    const now = nowTs();
    for (const [token, action] of this.actions.entries()) {
      if (Number(action?.expiresAt || 0) <= now) {
        this.actions.delete(token);
      }
    }
  }

  create({
    kind = 'assistant_tool_confirmation',
    conversationId = '',
    assistantRunId = '',
    toolName = '',
    input = {},
    title = '',
    summary = '',
    metadata = {}
  } = {}) {
    this.cleanupExpired();
    const confirmToken = crypto.randomUUID();
    const createdAt = nowTs();
    const action = {
      confirmToken,
      kind: normalizeText(kind) || 'assistant_tool_confirmation',
      conversationId: normalizeText(conversationId),
      assistantRunId: normalizeText(assistantRunId),
      toolName: normalizeText(toolName),
      input: input && typeof input === 'object' ? input : {},
      title: normalizeText(title),
      summary: normalizeText(summary),
      metadata: metadata && typeof metadata === 'object' ? metadata : {},
      createdAt,
      expiresAt: createdAt + PENDING_ACTION_TTL_MS
    };
    this.actions.set(confirmToken, action);
    return action;
  }

  get(confirmToken = '') {
    this.cleanupExpired();
    const key = normalizeText(confirmToken);
    return key ? this.actions.get(key) || null : null;
  }

  consume(confirmToken = '') {
    this.cleanupExpired();
    const key = normalizeText(confirmToken);
    if (!key) return null;
    const action = this.actions.get(key) || null;
    if (action) {
      this.actions.delete(key);
    }
    return action;
  }

  findLatestByConversationId(conversationId = '') {
    this.cleanupExpired();
    const normalizedConversationId = normalizeText(conversationId);
    if (!normalizedConversationId) return null;
    const candidates = [...this.actions.values()]
      .filter((entry) => entry.conversationId === normalizedConversationId)
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
    return candidates[0] || null;
  }

  dismiss(confirmToken = '') {
    const key = normalizeText(confirmToken);
    if (!key) return false;
    return this.actions.delete(key);
  }
}

export const assistantPendingActionStore = new AssistantPendingActionStore();

export default assistantPendingActionStore;
