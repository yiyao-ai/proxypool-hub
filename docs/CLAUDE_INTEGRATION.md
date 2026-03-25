# Claude Code Integration

## Setup

### One-click (Dashboard)

Open http://localhost:8081 → Settings tab → Click **"One-click configure Claude Code"**.

### Automatic (API)

```bash
curl -X POST http://localhost:8081/claude/config/proxy
```

Updates `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8081",
    "ANTHROPIC_API_KEY": "sk-ant-proxy",
    "ANTHROPIC_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-4-6",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-6",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5"
  }
}
```

### Manual

```bash
export ANTHROPIC_BASE_URL=http://localhost:8081
export ANTHROPIC_API_KEY=any-key
claude
```

## How It Works

```
Claude Code (Anthropic format)
         ↓
    ProxyPool Hub
         ↓
  Format Conversion (Anthropic → OpenAI Responses API)
         ↓
  Route Selection (ChatGPT account / Claude account / API key / Kilo free)
         ↓
  Upstream API call
         ↓
  Response Conversion (→ Anthropic SSE)
         ↓
Claude Code (Anthropic format)
```

### Format Conversion

**Anthropic → OpenAI Responses API:**

```javascript
// Anthropic request
{
  "model": "claude-sonnet-4-6",
  "system": "You are helpful.",
  "messages": [{"role": "user", "content": "Hello"}],
  "tools": [...]
}

// Converted to OpenAI Responses API
{
  "model": "gpt-5.2-codex",
  "instructions": "You are helpful.",
  "input": [{"type": "message", "role": "user", "content": "Hello"}],
  "tools": [...],
  "stream": true
}
```

**Key Conversions:**
- `system` → `instructions`
- `messages` → `input` array
- `tool_use` → `function_call` + `function_call_output` items
- Tool IDs prefixed with `fc_` for API compatibility

### Streaming Events

| OpenAI Event | Anthropic Event |
|--------------|-----------------|
| `response.output_item.added` | `message_start`, `content_block_start` |
| `response.output_text.delta` | `content_block_delta` (text_delta) |
| `response.function_call_arguments.delta` | `content_block_delta` (input_json_delta) |
| `response.completed` | `message_delta`, `message_stop` |

## View Configuration

```bash
curl http://localhost:8081/claude/config
```

## Revert to Direct API

```bash
curl -X POST http://localhost:8081/claude/config/direct \
  -H "Content-Type: application/json" \
  -d '{"apiKey":"sk-ant-..."}'
```

## Troubleshooting

- **Claude Code hangs**: Check `curl http://localhost:8081/health`, re-configure with the one-click button
- **"No active account" error**: Add an account in the Dashboard → Accounts tab
- **Token expired after refresh**: ProxyPool Hub uses smart refresh (only when < 5 min remaining) and writes back to `~/.claude/.credentials.json` for imported accounts
