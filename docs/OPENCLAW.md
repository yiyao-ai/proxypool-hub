# OpenClaw Integration

[OpenClaw](https://docs.openclaw.ai/) is an open-source AI assistant that supports multiple model providers. ProxyPool Hub can be added as a custom provider.

## One-click Setup

Open http://localhost:8081 → Settings tab → Click **"One-click configure OpenClaw"**.

This automatically adds a `proxypool` provider to your `~/.openclaw/openclaw.json` and sets it as the default model. It works whether or not the config file already exists.

## Manual Setup

Add the following to `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "proxypool": {
        "baseUrl": "http://localhost:8081",
        "apiKey": "sk-ant-proxy",
        "api": "anthropic-messages",
        "models": [
          {
            "id": "claude-opus-4-6",
            "name": "Claude Opus 4.6",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 32768,
            "cost": { "input": 0.015, "output": 0.075, "cacheRead": 0.0015, "cacheWrite": 0.01875 }
          },
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6",
            "reasoning": true,
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 16384,
            "cost": { "input": 0.003, "output": 0.015, "cacheRead": 0.0003, "cacheWrite": 0.00375 }
          },
          {
            "id": "claude-haiku-4-5",
            "name": "Claude Haiku 4.5",
            "reasoning": false,
            "input": ["text", "image"],
            "contextWindow": 200000,
            "maxTokens": 8192,
            "cost": { "input": 0.0008, "output": 0.004, "cacheRead": 0.00008, "cacheWrite": 0.001 }
          }
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
- Run `openclaw doctor` to check configuration syntax and provider connectivity
- If you ran `openclaw onboard` after configuring the proxy, re-click "One-click configure OpenClaw" — onboard may overwrite the config
