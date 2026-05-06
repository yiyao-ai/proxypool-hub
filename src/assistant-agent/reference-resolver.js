function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeComparableText(value) {
  return normalizeText(value).toLowerCase();
}

function tokenize(value) {
  return [...new Set(
    normalizeComparableText(value)
      .replace(/[^a-z0-9\u3400-\u9fff:\\/._-]+/g, ' ')
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length >= 2)
  )];
}

function scoreTokenOverlap(phrase, values = []) {
  const phraseTokens = tokenize(phrase);
  if (phraseTokens.length === 0) return 0;
  const candidateTokens = new Set(values.flatMap((entry) => tokenize(entry)));
  if (candidateTokens.size === 0) return 0;
  return phraseTokens.filter((entry) => candidateTokens.has(entry)).length;
}

function inferIntent(text = '') {
  const source = normalizeText(text);
  if (!source) return 'freeform';
  if ([/^(status|progress|update)\b/i, /(进展如何|状态如何|现在怎么样|目前怎么样)/].some((pattern) => pattern.test(source))) {
    return 'status';
  }
  if ([/^(continue|resume|follow up|keep going)\b/i, /(继续刚才那个|继续这个|接着做|继续一下)/].some((pattern) => pattern.test(source))) {
    return 'continue';
  }
  if ([/^(retry|try again)\b/i, /(重试|再试一次|重新试)/].some((pattern) => pattern.test(source))) {
    return 'retry';
  }
  if ([/\b(new task|start fresh|start a new)\b/i, /(新开|重新做|再做一个|另外再做一个)/].some((pattern) => pattern.test(source))) {
    return 'new';
  }
  return 'freeform';
}

function scoreToConfidence(score = 0) {
  const normalized = Number(score || 0);
  if (normalized >= 0.9) return 'high';
  if (normalized >= 0.72) return 'medium';
  return 'low';
}

function buildRecommendedAction({
  ambiguous = false,
  topCandidate = null,
  score = 0
} = {}) {
  if (!topCandidate) {
    return 'ask_user';
  }
  if (ambiguous || score < 0.72) {
    return 'ask_user';
  }
  if (topCandidate.kind === 'task') {
    return 'reuse_task';
  }
  if (topCandidate.kind === 'cwd') {
    return 'inspect_workspace';
  }
  return 'inspect_context';
}

function collectTaskCandidates(taskSpace = null) {
  const byId = new Map();
  for (const entry of [
    taskSpace?.focusTask,
    ...(Array.isArray(taskSpace?.activeTasks) ? taskSpace.activeTasks : []),
    ...(Array.isArray(taskSpace?.waitingTasks) ? taskSpace.waitingTasks : []),
    ...(Array.isArray(taskSpace?.recentTasks) ? taskSpace.recentTasks : []),
    ...(Array.isArray(taskSpace?.recentCompletedTasks) ? taskSpace.recentCompletedTasks : []),
    ...(Array.isArray(taskSpace?.recentFailedTasks) ? taskSpace.recentFailedTasks : [])
  ]) {
    const taskId = normalizeText(entry?.taskId || entry?.id);
    if (!taskId || byId.has(taskId)) continue;
    byId.set(taskId, entry);
  }
  return [...byId.values()];
}

function collectCwdCandidates(workspaceContext = null) {
  return Array.isArray(workspaceContext?.knownCwds)
    ? workspaceContext.knownCwds.filter((entry) => normalizeText(entry?.workspaceRef))
    : [];
}

function extractReferencePhrases(text = '', { taskCandidates = [], cwdCandidates = [] } = {}) {
  const source = normalizeText(text);
  if (!source) return [];
  const phrases = new Set();

  for (const match of source.matchAll(/[A-Za-z]:\\[^\s，。；,!?)]*/g)) {
    phrases.add(normalizeText(match[0]));
  }

  for (const match of source.matchAll(/(刚才那个[^，。；,!?]*)|(那个[^，。；,!?]*)|(这个[^，。；,!?]*)|(上周那个[^，。；,!?]*)|(另一个[^，。；,!?]*)/g)) {
    const phrase = normalizeText(match[0]);
    if (phrase) phrases.add(phrase);
  }

  const catalog = [
    ...taskCandidates.flatMap((entry) => [
      entry?.title,
      entry?.task?.title,
      entry?.task?.cwdBasename,
      entry?.task?.cwd
    ]),
    ...cwdCandidates.flatMap((entry) => [
      entry?.workspaceRef,
      entry?.name,
      ...(Array.isArray(entry?.aliases) ? entry.aliases : [])
    ])
  ].map(normalizeText).filter(Boolean);

  if (catalog.some((entry) => normalizeComparableText(source).includes(normalizeComparableText(entry)))) {
    phrases.add(source);
  }

  if (phrases.size === 0 && /(这个|那个|刚才|上周|another|other|that|this|previous)/i.test(source)) {
    phrases.add(source);
  }

  return [...phrases].slice(0, 4);
}

function scoreTaskCandidate(task, phrase, { focusTaskId = '', currentConversationId = '' } = {}) {
  const title = normalizeText(task?.task?.title || task?.title);
  const cwd = normalizeText(task?.task?.cwd);
  const cwdBasename = normalizeText(task?.task?.cwdBasename);
  const taskId = normalizeText(task?.taskId || task?.id);
  const lastConversationId = normalizeText(task?.task?.lastConversationId || task?.conversationId);
  const phraseNormalized = normalizeComparableText(phrase);
  let score = 0;

  if (!taskId) return 0;
  if (phraseNormalized && [normalizeComparableText(taskId), normalizeComparableText(cwd), normalizeComparableText(title)].includes(phraseNormalized)) {
    score = 0.98;
  } else {
    const overlap = scoreTokenOverlap(phrase, [title, cwd, cwdBasename]);
    score += Math.min(0.6, overlap * 0.2);
    if (cwd && phraseNormalized.includes(normalizeComparableText(cwd))) score += 0.45;
    if (cwdBasename && phraseNormalized.includes(normalizeComparableText(cwdBasename))) score += 0.35;
    if (title && phraseNormalized.includes(normalizeComparableText(title))) score += 0.35;
  }

  if (/(这个|刚才|that|this|previous)/i.test(phrase) && taskId === focusTaskId) {
    score += 0.25;
  }
  if (/(另一个|other|another)/i.test(phrase) && taskId !== focusTaskId) {
    score += 0.18;
  }
  if (normalizeText(task?.state || task?.task?.status).startsWith('waiting_')) {
    score += 0.05;
  }
  if (currentConversationId && lastConversationId === currentConversationId) {
    score += 0.05;
  }

  return Math.min(0.99, Number(score.toFixed(3)));
}

function scoreCwdCandidate(cwdEntry, phrase) {
  const workspaceRef = normalizeText(cwdEntry?.workspaceRef);
  const name = normalizeText(cwdEntry?.name);
  const aliases = Array.isArray(cwdEntry?.aliases) ? cwdEntry.aliases.map(normalizeText).filter(Boolean) : [];
  const basename = normalizeText(workspaceRef.split(/[\\/]+/).filter(Boolean).pop());
  const phraseNormalized = normalizeComparableText(phrase);
  let score = 0;

  if (!workspaceRef) return 0;
  if (phraseNormalized && [normalizeComparableText(workspaceRef), normalizeComparableText(name)].includes(phraseNormalized)) {
    score = 0.97;
  } else {
    const overlap = scoreTokenOverlap(phrase, [workspaceRef, name, basename, ...aliases]);
    score += Math.min(0.55, overlap * 0.18);
    if (workspaceRef && phraseNormalized.includes(normalizeComparableText(workspaceRef))) score += 0.45;
    if (basename && phraseNormalized.includes(normalizeComparableText(basename))) score += 0.35;
    if (aliases.some((alias) => phraseNormalized.includes(normalizeComparableText(alias)))) score += 0.35;
  }

  return Math.min(0.98, Number(score.toFixed(3)));
}

function buildTaskLabel(task) {
  return normalizeText(task?.task?.title || task?.title || task?.taskId || task?.id);
}

function buildCwdLabel(cwdEntry) {
  return normalizeText(cwdEntry?.name || cwdEntry?.workspaceRef);
}

export function resolveReferenceContext({
  text = '',
  taskSpace = null,
  workspaceContext = null,
  conversationContext = null
} = {}) {
  const taskCandidates = collectTaskCandidates(taskSpace);
  const cwdCandidates = collectCwdCandidates(workspaceContext);
  const focusTaskId = normalizeText(taskSpace?.focusTask?.taskId);
  const currentConversationId = normalizeText(conversationContext?.conversation?.id || taskSpace?.conversation?.id);
  const phrases = extractReferencePhrases(text, { taskCandidates, cwdCandidates });

  const references = phrases.map((phrase) => {
    const candidates = [
      ...taskCandidates.map((entry) => ({
        kind: 'task',
        id: normalizeText(entry?.taskId || entry?.id),
        label: buildTaskLabel(entry),
        score: scoreTaskCandidate(entry, phrase, {
          focusTaskId,
          currentConversationId
        }),
        conversationId: normalizeText(entry?.conversationId),
        isCurrentConversation: normalizeText(entry?.task?.lastConversationId || entry?.conversationId) === currentConversationId
      })),
      ...cwdCandidates.map((entry) => ({
        kind: 'cwd',
        id: normalizeText(entry?.workspaceRef),
        label: buildCwdLabel(entry),
        score: scoreCwdCandidate(entry, phrase)
      }))
    ]
      .filter((entry) => entry.id && entry.score >= 0.35)
      .sort((left, right) => right.score - left.score)
      .slice(0, 5);

    const top = candidates[0] || null;
    const second = candidates[1] || null;
    const ambiguous = Boolean(top && second && top.score >= 0.6 && Math.abs(top.score - second.score) < 0.15);
    const confidence = scoreToConfidence(top?.score || 0);
    const recommendedAction = buildRecommendedAction({
      ambiguous,
      topCandidate: top,
      score: top?.score || 0
    });

    return {
      phrase,
      topCandidates: candidates,
      ambiguous,
      confidence,
      recommendedAction,
      preferredTaskId: top?.kind === 'task' ? normalizeText(top.id) : '',
      preferredWorkspaceRef: top?.kind === 'cwd' ? normalizeText(top.id) : '',
      shouldAskUser: recommendedAction === 'ask_user'
    };
  }).filter((entry) => entry.topCandidates.length > 0);

  const primaryReference = references[0] || null;
  const summary = {
    referenceCount: references.length,
    primaryPhrase: normalizeText(primaryReference?.phrase),
    confidence: normalizeText(primaryReference?.confidence),
    recommendedAction: normalizeText(primaryReference?.recommendedAction),
    preferredTaskId: normalizeText(primaryReference?.preferredTaskId),
    preferredWorkspaceRef: normalizeText(primaryReference?.preferredWorkspaceRef),
    shouldAskUser: primaryReference?.shouldAskUser === true
  };

  return {
    intent: inferIntent(text),
    references,
    summary
  };
}

export default {
  resolveReferenceContext
};
