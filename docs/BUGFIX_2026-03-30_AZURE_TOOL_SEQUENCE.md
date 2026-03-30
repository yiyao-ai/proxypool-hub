# 2026-03-30 Azure OpenAI Codex Tool Execution Fix

## Time

- Author: YiYaoAI
- First observed: 2026-03-30 14:43:54 Asia/Shanghai
- Root cause confirmed: 2026-03-30 15:59:32 Asia/Shanghai
- Fix completed: 2026-03-30 16:01:33 Asia/Shanghai

## Description

When Codex requests were routed through the `azure-openai` API key path, the model could reply, but tool-driven tasks could not complete reliably.

Observed failures appeared in three phases:

1. Azure Chat Completions rejected converted tool-call history with invalid ordering.
2. After switching to Azure native Responses API, Azure rejected Codex encrypted payload fields.
3. After request compatibility was fixed, Codex could receive model text but still did not execute tools because proxy-generated SSE events did not fully represent native Responses tool items.

The same task succeeded through ChatGPT account passthrough because that path forwarded the original Codex protocol instead of rebuilding it.

## Impact

- Affected routes: `/responses` and `/backend-api/codex/responses`
- Affected provider path: `azure-openai` API key routing
- User-visible symptoms:
  - HTTP 400 / 503 during tool turns
  - `Invalid patch: The last line of the patch must be '*** End Patch'`
  - Codex only saying "I will now modify the file" without actually executing the tool
- ChatGPT account passthrough was not affected

## Root Causes

### 1. Invalid tool-call sequencing in Chat Completions fallback

The API key fallback path converted Responses-style `input[]` into Chat Completions `messages[]`.

During tool execution, Codex can emit runtime messages between the assistant tool call and the later tool output. Before the fix, the converted order could become:

```text
assistant(tool_calls) -> system/runtime message -> tool(tool_call_id=...)
```

Azure/OpenAI Chat Completions requires the matching `tool` messages to come immediately after the assistant message with `tool_calls`, so the request was rejected.

### 2. Azure native Responses API rejected encrypted Codex fields

After routing Azure through native Responses API, Azure returned:

```text
The encrypted content ... could not be verified.
Reason: Encrypted content could not be decrypted or parsed.
```

Codex request bodies contained fields that are valid for OpenAI/Codex native infrastructure but not accepted by Azure Responses:

- `encrypted_content`
- `signature`
- `thoughtSignature`
- `include: ["reasoning.encrypted_content"]`
- `type: "compaction"` items

These had to be removed before sending the body to Azure.

### 3. Native Responses tool items were not fully replayed as SSE

Even after Azure returned `200`, Codex still sometimes only showed explanatory text and did not execute the task.

The remaining issue was not in the request body. It was in proxy-side SSE replay. Azure native Responses returned output items such as:

```text
reasoning, message, custom_tool_call
```

but the proxy SSE bridge mainly handled `message` and `function_call`. As a result, native tool items such as `custom_tool_call` and `apply_patch_call` were not emitted with the event pattern Codex expected, so the client saw text but not executable tool work.

## Fix

The final fix had three layers.

### A. Normalize tool-call ordering for Chat Completions fallback

Updated:

- `src/routes/responses-route.js`
- `src/routes/codex-route.js`

Changes:

1. Merge assistant text adjacent to `function_call` into the same assistant message.
2. Defer runtime `system` / `user` messages while tool outputs are still pending.
3. Flush deferred messages only after the required `tool` messages are emitted.
4. Add sequence validation logs before sending Chat Completions requests.
5. Stop retrying repeated invalid `400` request payloads in the same provider loop.

### B. Sanitize Codex Responses payloads for Azure compatibility

Updated:

- `src/providers/azure-openai.js`

Changes:

1. Route `azure-openai` native Responses traffic to `/openai/v1/responses`.
2. Strip `encrypted_content`.
3. Strip `signature` and `thoughtSignature`.
4. Remove `compaction` items.
5. Remove `reasoning.encrypted_content` from `include`.
6. Add sanitization logs for verification.

Expected log pattern:

```text
[Azure OpenAI] Sanitized responses payload | encrypted_fields=30 | signature_fields=0 | compaction_items=0 | include_entries=1
```

### C. Replay native tool outputs as Codex-compatible SSE

Updated:

- `src/utils/responses-sse.js`
- `src/routes/responses-route.js`
- `src/routes/codex-route.js`

Changes:

1. Emit `response.in_progress`.
2. Emit `custom_tool_call` input delta/done events.
3. Emit lifecycle events for `apply_patch_call`, `shell_call`, `local_shell_call`, `mcp_call`, and `mcp_approval_request`.
4. Include `item_id`, `call_id`, and `name` on tool input events where applicable.
5. Add output-type summary logs for native Responses replies.

Expected diagnostic log pattern:

```text
[Codex] Native responses output | azure-openai/company-5.4 | reasoning, message, custom_tool_call
```

## Verification

Added or updated targeted regression coverage in:

- `tests/unit/azure-openai-provider.test.js`
- `tests/unit/responses-route.test.js`
- `tests/unit/codex-route.test.js`
- `tests/unit/responses-sse.test.js`

Validated command:

```text
node --test tests\unit\responses-sse.test.js tests\unit\azure-openai-provider.test.js tests\unit\responses-route.test.js tests\unit\codex-route.test.js
```

Result:

```text
12 passed, 0 failed
```

## Final Success Evidence

Normal production logs after the fix:

```text
2026-03-30 16:01:14 [Codex] >>> API KEY RESPONSES | azure-openai/company-5.4 | gpt-5.4→gpt-5.4
2026-03-30 16:01:14 [Azure OpenAI] Sanitized responses payload | encrypted_fields=30 | signature_fields=0 | compaction_items=0 | include_entries=1
2026-03-30 16:01:24 [Codex] Native responses output | azure-openai/company-5.4 | reasoning, message, custom_tool_call
2026-03-30 16:01:24 [Codex] <<< API KEY OK | azure-openai/company-5.4 | model=gpt-5.4 | 9185ms

2026-03-30 16:01:24 [Codex] Native responses output | azure-openai/company-5.4 | message, function_call
2026-03-30 16:01:29 [Codex] Native responses output | azure-openai/company-5.4 | message
```

This confirms:

- Azure native Responses routing is active
- Azure payload sanitization is active
- Native tool items are visible at the proxy boundary
- Codex can now proceed from reasoning/text into actual tool execution

## Files Changed

- `src/providers/azure-openai.js`
- `src/routes/responses-route.js`
- `src/routes/codex-route.js`
- `src/utils/responses-sse.js`
- `tests/unit/azure-openai-provider.test.js`
- `tests/unit/responses-route.test.js`
- `tests/unit/codex-route.test.js`
- `tests/unit/responses-sse.test.js`
- `docs/BUGFIX_2026-03-30_AZURE_TOOL_SEQUENCE.md`
