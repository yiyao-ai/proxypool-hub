# OpenClaw Integration

[OpenClaw](https://docs.openclaw.ai/) is an open-source AI assistant that supports multiple model providers. ProxyPool Hub can be added as a custom provider.

## One-click Setup

Open http://localhost:8081 → Settings tab → Click **"One-click configure OpenClaw"**.

This automatically adds a `proxypool` provider to your `~/.openclaw/openclaw.json` and sets it as the default model.

## Manual Setup

Add the following to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "proxypool": {
        "baseUrl": "http://localhost:8081",
        "apiKey": "sk-ant-proxy",
        "api": "anthropic-messages",
        "models": [
          { "id": "claude-opus-4-6", "name": "Claude Opus 4.6" },
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" },
          { "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "proxypool/claude-sonnet-4-6"
      }
    }
  }
}
```

Then run:

```bash
openclaw
```

## How It Works

- OpenClaw sends Anthropic Messages API requests to ProxyPool Hub's `/v1/messages` endpoint
- ProxyPool Hub routes the request through your account pool (ChatGPT, Claude, or API keys)
- Responses are streamed back in Anthropic SSE format

## Available Models

| Model ID | Description |
|----------|-------------|
| `proxypool/claude-opus-4-6` | Maximum capability (routed to GPT-5.3 Codex or Anthropic API) |
| `proxypool/claude-sonnet-4-6` | Balanced performance (routed to GPT-5.2 Codex or Anthropic API) |
| `proxypool/claude-haiku-4-5` | Free model via Kilo AI (no auth needed) |

## Revert to Direct Connection

Use the dashboard or call:

```bash
curl -X POST http://localhost:8081/openclaw/config/direct
```

## Troubleshooting

- Use `127.0.0.1` instead of `localhost` if you encounter connection issues
- Verify proxy health: `curl http://localhost:8081/health`
- Check OpenClaw logs for API errors
