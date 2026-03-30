# App Routing Design

## Goal

Add a new routing mode that lets users manually bind a specific application to a specific credential while preserving the existing automatic routing behavior.

Examples:

- Codex -> ChatGPT account A
- Claude Code -> Claude account B
- OpenClaw -> API key C
- Multiple apps -> same account or key

## Routing Modes

- `automatic`: keep current behavior. Requests follow existing route-specific priority and account rotation.
- `app-assigned`: resolve the calling application first. If a matching binding exists, try that credential before falling back to the existing automatic flow.

## App IDs

- `codex`
- `claude-code`
- `gemini-cli`
- `openclaw`
- `unknown-openai-client`
- `unknown-anthropic-client`

## Binding Types

- `chatgpt-account`
- `claude-account`
- `api-key`

## Settings Shape

Stored in `~/.proxypool-hub/settings.json`.

```json
{
  "routingMode": "app-assigned",
  "appRouting": {
    "codex": {
      "enabled": true,
      "bindingType": "chatgpt-account",
      "bindingId": "user@example.com",
      "fallbackToDefault": true
    }
  }
}
```

## Resolution Rules

1. Detect app from request path and headers.
2. If routing mode is `automatic`, use existing logic unchanged.
3. If routing mode is `app-assigned` and the app has an enabled binding:
   - Resolve the bound credential.
   - If usable, route request through that credential only.
   - If unavailable and `fallbackToDefault=true`, continue with existing automatic logic.
   - If unavailable and `fallbackToDefault=false`, return an explicit error.

## Detection Notes

- `codex`: `/responses`, `/v1/responses`, `/backend-api/codex/*`
- `gemini-cli`: `/v1beta/models/*`
- `claude-code` and `openclaw` both use Anthropic-compatible routes. Detection uses known headers and falls back to `unknown-anthropic-client` when the source is ambiguous.
- Generic OpenAI-compatible traffic falls back to `unknown-openai-client`.

## UX

Settings page exposes:

- Routing mode toggle
- Per-app binding enable switch
- Binding type select
- Binding target select
- Fallback-to-default switch

## Safety

- Existing settings remain valid.
- Existing automatic routing remains the default.
- Invalid assignments are rejected by the settings API.
