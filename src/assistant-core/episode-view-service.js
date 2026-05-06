import chatUiConversationStore from '../chat-ui/conversation-store.js';
import agentChannelDeliveryStore from '../agent-channels/delivery-store.js';
import supervisorTaskStore from '../agent-orchestrator/supervisor-task-store.js';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeComparableText(value) {
  return normalizeText(value).toLowerCase();
}

function scoreOverlap(query, values = []) {
  const source = normalizeComparableText(query);
  if (!source) return 0;
  let score = 0;
  for (const value of values) {
    const normalized = normalizeComparableText(value);
    if (!normalized) continue;
    if (normalized === source) score = Math.max(score, 1);
    else if (normalized.includes(source) || source.includes(normalized)) score = Math.max(score, 0.75);
    else {
      const sourceTokens = new Set(source.split(/\s+/).filter(Boolean));
      const targetTokens = new Set(normalized.split(/\s+/).filter(Boolean));
      const overlap = [...sourceTokens].filter((entry) => targetTokens.has(entry)).length;
      if (overlap > 0) {
        score = Math.max(score, Math.min(0.7, overlap * 0.2));
      }
    }
  }
  return Number(score.toFixed(3));
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/.test(normalizeText(value));
}

function summarizeTaskEpisode(task = null) {
  if (!task?.id) return null;
  return {
    kind: 'task',
    id: task.id,
    conversationId: normalizeText(task.conversationId),
    title: normalizeText(task.title),
    summary: normalizeText(task.summary),
    result: normalizeText(task.result),
    error: normalizeText(task.error),
    cwd: normalizeText(task.cwd),
    cwdBasename: normalizeText(task.cwdBasename),
    postmortem: task.postmortem && typeof task.postmortem === 'object'
      ? {
          purpose: normalizeText(task.postmortem.purpose),
          outcome: normalizeText(task.postmortem.outcome),
          deliverables: Array.isArray(task.postmortem.deliverables) ? task.postmortem.deliverables : [],
          next: normalizeText(task.postmortem.next),
          keywords: Array.isArray(task.postmortem.keywords) ? task.postmortem.keywords : []
        }
      : null,
    lastConversationId: normalizeText(task.lastConversationId || task.conversationId),
    updatedAt: normalizeText(task.updatedAt || task.lastUpdateAt)
  };
}

function summarizeDeliveryEpisode(delivery = null) {
  if (!delivery?.id) return null;
  return {
    kind: 'delivery',
    id: delivery.id,
    conversationId: normalizeText(delivery.conversationId),
    direction: normalizeText(delivery.direction),
    text: normalizeText(delivery?.payload?.text || delivery?.payload?.content || delivery?.payload?.summary || delivery?.payload?.fullText),
    updatedAt: normalizeText(delivery.updatedAt || delivery.createdAt),
    createdAt: normalizeText(delivery.createdAt)
  };
}

export class AssistantEpisodeViewService {
  constructor({
    conversationStore = chatUiConversationStore,
    deliveryStore = agentChannelDeliveryStore,
    supervisorTaskStore: supervisorTaskStoreArg = supervisorTaskStore
  } = {}) {
    this.conversationStore = conversationStore;
    this.deliveryStore = deliveryStore;
    this.supervisorTaskStore = supervisorTaskStoreArg;
  }

  buildRecentIntentTimeline({ conversationId = '', limit = 8 } = {}) {
    const normalizedConversationId = normalizeText(conversationId);
    if (!normalizedConversationId) return [];
    return this.deliveryStore.listByConversation(normalizedConversationId, {
      limit: Math.max(limit * 3, limit)
    })
      .filter((entry) => normalizeText(entry.direction) === 'inbound')
      .slice(-Math.max(1, limit))
      .map((entry) => ({
        ts: entry.createdAt || '',
        userText: normalizeText(entry?.payload?.text || entry?.payload?.content || ''),
        action: 'user_message'
      }));
  }

  recall({ query = '', scope = 'workspace', conversationId = '', limit = 10 } = {}) {
    const normalizedQuery = normalizeText(query);
    const max = Math.max(1, limit);
    const normalizedConversationId = normalizeText(conversationId);
    const scopedDeliveries = (scope === 'conversation' && normalizedConversationId
      ? this.deliveryStore.listByConversation(normalizedConversationId, { limit: Math.max(max * 8, max) })
      : this.deliveryStore.listAll({ limit: Math.max(max * 20, max) }))
      .map(summarizeDeliveryEpisode)
      .filter(Boolean);
    const deliveryTextsByConversation = new Map();
    const deliveryHitScoreByConversation = new Map();
    for (const entry of scopedDeliveries) {
      const key = normalizeText(entry.conversationId);
      if (!key) continue;
      if (!deliveryTextsByConversation.has(key)) {
        deliveryTextsByConversation.set(key, []);
      }
      deliveryTextsByConversation.get(key).push(entry.text);
      const score = scoreOverlap(normalizedQuery, [entry.text]);
      if (score > 0) {
        deliveryHitScoreByConversation.set(
          key,
          Math.max(deliveryHitScoreByConversation.get(key) || 0, score)
        );
      }
    }

    const tasks = this.supervisorTaskStore.list({
      conversationId: scope === 'conversation' ? normalizedConversationId : '',
      limit: Math.max(max * 5, max)
    })
      .map(summarizeTaskEpisode)
      .filter(Boolean)
      .map((entry) => ({
        ...entry,
        score: Math.max(
          scoreOverlap(normalizedQuery, [
            entry.title,
            entry.summary,
            entry.result,
            entry.error,
            entry.cwd,
            entry.cwdBasename,
            entry.postmortem?.purpose,
            entry.postmortem?.outcome,
            ...(Array.isArray(entry.postmortem?.deliverables) ? entry.postmortem.deliverables : []),
            ...(Array.isArray(entry.postmortem?.keywords) ? entry.postmortem.keywords : [])
          ]),
          scoreOverlap(normalizedQuery, deliveryTextsByConversation.get(normalizeText(entry.conversationId)) || []),
          Math.max(0, (deliveryHitScoreByConversation.get(normalizeText(entry.conversationId)) || 0) - 0.05)
        )
      }))
      .filter((entry) => {
        if (!normalizedQuery) return true;
        if (entry.score > 0) return true;
        if (containsChinese(normalizedQuery)) {
          return deliveryTextsByConversation.has(normalizeText(entry.conversationId));
        }
        return false;
      });

    const deliveries = scopedDeliveries
      .map((entry) => ({
        ...entry,
        score: scoreOverlap(normalizedQuery, [entry.text])
      }))
      .filter((entry) => !normalizedQuery || entry.score > 0);

    const conversations = this.conversationStore.list({ limit: Math.max(max * 5, max) })
      .filter((entry) => !normalizedConversationId || scope !== 'conversation' || entry.id === normalizedConversationId)
      .map((entry) => ({
        kind: 'conversation',
        id: entry.id,
        title: normalizeText(entry.title),
        conversationId: entry.id,
        updatedAt: normalizeText(entry.updatedAt),
        score: scoreOverlap(normalizedQuery, [
          entry.title,
          entry?.metadata?.supervisor?.brief?.title,
          entry?.metadata?.supervisor?.brief?.summary
        ])
      }))
      .filter((entry) => !normalizedQuery || entry.score > 0);

    const rankedTasks = tasks.sort((left, right) => right.score - left.score).slice(0, max);
    const rankedDeliveries = deliveries.sort((left, right) => right.score - left.score).slice(0, max);
    const rankedConversations = conversations.sort((left, right) => right.score - left.score).slice(0, max);
    const bestTask = rankedTasks[0] || null;
    const bestDelivery = rankedDeliveries[0] || null;
    const bestConversation = rankedConversations[0] || null;
    const bestScore = Math.max(
      Number(bestTask?.score || 0),
      Number(bestDelivery?.score || 0),
      Number(bestConversation?.score || 0)
    );

    return {
      query: normalizedQuery,
      scope: normalizeText(scope) || 'workspace',
      summary: {
        bestScore: Number(bestScore.toFixed(3)),
        primaryKind: bestTask && Number(bestTask.score || 0) >= Number(bestDelivery?.score || 0) && Number(bestTask.score || 0) >= Number(bestConversation?.score || 0)
          ? 'task'
          : (bestDelivery && Number(bestDelivery.score || 0) >= Number(bestConversation?.score || 0) ? 'delivery' : 'conversation'),
        taskCount: rankedTasks.length,
        deliveryCount: rankedDeliveries.length,
        conversationCount: rankedConversations.length
      },
      tasks: rankedTasks,
      deliveries: rankedDeliveries,
      conversations: rankedConversations
    };
  }
}

export const assistantEpisodeViewService = new AssistantEpisodeViewService();

export default assistantEpisodeViewService;
