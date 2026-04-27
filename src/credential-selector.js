import { getServerSettings } from './server-settings.js';
import { listAllCredentials, isCredentialAvailable } from './credential-registry.js';
import { resolveAssignedCredentials } from './app-routing.js';

const OPENAI_CHAT_KEY_TYPES = new Set(['openai', 'azure-openai', 'gemini', 'vertex-ai', 'deepseek']);
const OPENAI_RESPONSES_KEY_TYPES = new Set(['openai', 'azure-openai', 'gemini', 'vertex-ai', 'deepseek']);
const ANTHROPIC_MESSAGE_KEY_TYPES = new Set(['anthropic', 'gemini', 'vertex-ai', 'minimax', 'moonshot', 'zhipu', 'deepseek']);

function protocolPreferences(protocol) {
  switch (protocol) {
    case 'openai-responses':
      return {
        accountKinds: ['chatgpt-account'],
        keyTypes: OPENAI_RESPONSES_KEY_TYPES
      };
    case 'anthropic-messages':
      return {
        accountKinds: ['chatgpt-account', 'claude-account', 'antigravity-account'],
        keyTypes: ANTHROPIC_MESSAGE_KEY_TYPES
      };
    case 'openai-chat':
    default:
      return {
        accountKinds: ['chatgpt-account'],
        keyTypes: OPENAI_CHAT_KEY_TYPES
      };
  }
}

function sortCandidates(candidates) {
  return [...candidates].sort((a, b) => {
    if ((b.totalRequests || 0) !== (a.totalRequests || 0)) {
      return (a.totalRequests || 0) - (b.totalRequests || 0);
    }
    return String(a.label).localeCompare(String(b.label));
  });
}

function dedupe(candidates) {
  const seen = new Set();
  const result = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    result.push(candidate);
  }
  return result;
}

function buildAutomaticCandidates({ credentials, priority, protocol }) {
  const prefs = protocolPreferences(protocol);
  const accounts = credentials.filter((item) => prefs.accountKinds.includes(item.kind));
  const apiKeys = credentials.filter((item) => item.kind === 'api-key' && prefs.keyTypes.has(item.provider));

  const activeAccounts = accounts.filter((item) => item.isActive === true);
  const fallbackAccounts = accounts.filter((item) => item.isActive !== true);
  const orderedAccounts = [...activeAccounts, ...sortCandidates(fallbackAccounts)];
  const orderedApiKeys = sortCandidates(apiKeys);

  return priority === 'apikey-first'
    ? [...orderedApiKeys, ...orderedAccounts]
    : [...orderedAccounts, ...orderedApiKeys];
}

function mapAssignmentCandidate(candidate, credentials) {
  if (!candidate?.credentialType) return null;
  const kind = candidate.credentialType;
  const targetId = candidate.credential?.email || candidate.credential?.id || candidate.binding?.targetId;
  if (!targetId) return null;
  return credentials.find((credential) => credential.kind === kind && credential.targetId === targetId) || null;
}

export function resolveCredentialForRequest({
  appId = 'unknown-openai-client',
  model = '',
  protocol = 'openai-chat',
  settings = getServerSettings()
} = {}) {
  const credentials = listAllCredentials({ includeRaw: true });
  const available = credentials.filter((credential) => isCredentialAvailable(credential));
  const skipped = credentials.filter((credential) => !isCredentialAvailable(credential)).map((credential) => ({
    id: credential.id,
    kind: credential.kind,
    label: credential.label,
    status: credential.status,
    reason: credential.statusReason
  }));

  let candidates = [];
  let reason = 'automatic';

  if (settings.routingMode === 'app-assigned') {
    const assignment = resolveAssignedCredentials(settings, appId);
    if (assignment.matched) {
      const assignedCandidates = (assignment.assignments || [])
        .map((candidate) => mapAssignmentCandidate(candidate, credentials))
        .filter(Boolean);
      candidates = assignedCandidates.filter((candidate) => isCredentialAvailable(candidate));
      if (candidates.length > 0) {
        reason = 'app-assigned';
      } else if (!assignment.fallbackToDefault) {
        return {
          appId,
          model,
          protocol,
          routingMode: settings.routingMode,
          reason: 'app-assigned-unavailable',
          selectedCredential: null,
          candidates: [],
          skipped
        };
      }

      if (assignment.fallbackToDefault && candidates.length === 0) {
        reason = 'app-assigned-fallback';
      }
    }
  }

  if (candidates.length === 0) {
    candidates = buildAutomaticCandidates({
      credentials: available,
      priority: settings.routingPriority || 'account-first',
      protocol
    });
  }

  candidates = dedupe(candidates);

  return {
    appId,
    model,
    protocol,
    routingMode: settings.routingMode || 'automatic',
    reason,
    selectedCredential: candidates[0] || null,
    candidates,
    skipped
  };
}

export default {
  resolveCredentialForRequest
};
