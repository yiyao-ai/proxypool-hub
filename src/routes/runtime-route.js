import { listAllCredentials } from '../credential-registry.js';
import { getRecentRoutingDecisions } from '../runtime-state.js';
import { resolveCredentialForRequest } from '../credential-selector.js';
import { getLocalRoutingStatus } from '../local-routing.js';

export function handleGetRuntimeCredentials(req, res) {
  res.json({
    success: true,
    credentials: listAllCredentials()
  });
}

export function handleGetRoutingDecisions(req, res) {
  const limit = Number(req.query.limit) || 20;
  res.json({
    success: true,
    decisions: getRecentRoutingDecisions(limit)
  });
}

export function handleGetRoutingPreview(req, res) {
  const selection = resolveCredentialForRequest({
    appId: String(req.query.appId || 'unknown-openai-client'),
    model: String(req.query.model || ''),
    protocol: String(req.query.protocol || 'openai-chat')
  });

  res.json({
    success: true,
    preview: {
      ...selection,
      candidates: selection.candidates.map((candidate) => ({
        id: candidate.id,
        kind: candidate.kind,
        provider: candidate.provider,
        label: candidate.label,
        status: candidate.status,
        isActive: candidate.isActive
      })),
      selectedCredential: selection.selectedCredential
        ? {
            id: selection.selectedCredential.id,
            kind: selection.selectedCredential.kind,
            provider: selection.selectedCredential.provider,
            label: selection.selectedCredential.label,
            status: selection.selectedCredential.status,
            isActive: selection.selectedCredential.isActive
          }
        : null
    }
  });
}

export function handleGetLocalRoutingStatus(req, res) {
  res.json({
    success: true,
    localRouting: getLocalRoutingStatus()
  });
}

export default {
  handleGetRuntimeCredentials,
  handleGetRoutingDecisions,
  handleGetRoutingPreview,
  handleGetLocalRoutingStatus
};
