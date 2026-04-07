const DEFAULT_TIMEOUT_MS = 30000;

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function buildHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ollama',
    ...extra
  };
}

export async function checkOllamaHealth(baseUrl) {
  const url = `${trimSlash(baseUrl)}/api/version`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const payload = await parseJsonSafely(response);
    return {
      ok: response.ok,
      status: response.status,
      version: payload?.version || null,
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      version: null,
      error: error.message
    };
  }
}

export async function listOllamaModels(baseUrl) {
  const response = await fetch(`${trimSlash(baseUrl)}/v1/models`, {
    headers: { Authorization: 'Bearer ollama' }
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Ollama models request failed: HTTP ${response.status} ${bodyText.slice(0, 200)}`);
  }

  const data = await response.json();
  return Array.isArray(data?.data) ? data.data : [];
}

export async function sendOllamaAnthropicRequest(baseUrl, body, { headers = {} } = {}) {
  return fetch(`${trimSlash(baseUrl)}/v1/messages`, {
    method: 'POST',
    headers: buildHeaders(headers),
    body: JSON.stringify(body)
  });
}

export async function sendOllamaChatRequest(baseUrl, body) {
  return fetch(`${trimSlash(baseUrl)}/v1/chat/completions`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body)
  });
}

export async function sendOllamaResponsesRequest(baseUrl, body) {
  return fetch(`${trimSlash(baseUrl)}/v1/responses`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body)
  });
}

export default {
  checkOllamaHealth,
  listOllamaModels,
  sendOllamaAnthropicRequest,
  sendOllamaChatRequest,
  sendOllamaResponsesRequest
};
