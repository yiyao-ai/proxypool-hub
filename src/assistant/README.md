# Legacy Assistant Compatibility Layer

`src/assistant/` is the legacy compatibility layer for ordinary chat assistant behavior.

It currently exists to support:

- manual / product QA prompt injection
- lightweight chat preference handling
- confirm-before-execute chat actions used by `chat-ui-route`

It is not the main `/cligate` assistant path.

Current mainline ownership is:

- `src/assistant-agent/`: LLM supervisor logic
- `src/assistant-core/`: assistant mode orchestration, tools, state, and read models
- `src/agent-orchestrator/`, `src/agent-runtime/`, `src/agent-channels/`: execution/runtime/channel infrastructure

Rules for this directory:

1. Keep changes compatibility-focused.
2. Do not add new `/cligate` supervisor features here.
3. Prefer new assistant capabilities in `assistant-core` or `assistant-agent`.
