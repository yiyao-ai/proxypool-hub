# Product Manual

## Overview

CliGate is a local multi-protocol AI proxy system that unifies requests from Claude Code, Codex CLI, Gemini CLI, and OpenClaw. Its main features include:

- account pool management
- API key management
- request routing and model mapping
- a web dashboard
- direct testing in Web Chat
- one-click configuration for Claude Code, Codex CLI, Gemini CLI, and OpenClaw

CliGate runs locally by default and does not require a third-party relay service. In most cases, you only need to start the service, add at least one valid account or API key, and then test requests from the dashboard.

## Quick Start

### Start the service

You can start CliGate in either of these ways:

1. Run directly: `npx cligate@latest start`
2. Run after global install: `cligate start`

From `v1.2.0` onward, tagged releases are expected to publish GitHub desktop artifacts and the npm package together. If npm returns `404`, verify the matching GitHub tag and release workflow first.

The default dashboard address is:

`http://localhost:8081`

### Recommended first-time setup

1. Start CliGate
2. Open the dashboard
3. Go to Accounts or API Keys
4. Add at least one working account or API key
5. Open the Chat page and test a model
6. If you want to use Claude Code or another CLI through CliGate, go to Settings and run the one-click configuration

## Main Dashboard Pages

### Dashboard

The Dashboard page shows overall status, including account counts, availability, quick tests, and setup guidance for Claude Code, Codex CLI, Gemini CLI, and OpenClaw.

### Chat

The Chat page is the built-in Web Chat panel for testing accounts, Claude accounts, and API keys directly from the dashboard.

You can configure:

- Chat Source: the account or API key used for the conversation
- Model: the model name to send
- Product Assistant: when enabled, the assistant prioritizes this manual for product usage questions
- System Prompt: optional conversation-level instruction

The Chat page is only a testing surface. It does not change proxy behavior unless you explicitly confirm a configuration action.

### Accounts

The Accounts page is used to manage:

- ChatGPT accounts
- Claude accounts
- Antigravity accounts

You can add, switch, enable, disable, refresh, and remove them from the dashboard.

### API Keys

The API Keys page supports providers such as:

- OpenAI
- Anthropic
- Azure OpenAI
- Gemini
- Vertex AI
- MiniMax
- Moonshot
- ZhipuAI

Once enabled, an API key can participate in routing and can also be selected directly as a Chat source.

### Settings

The Settings page is used for:

- one-click Claude Code configuration
- one-click Codex CLI configuration
- one-click Gemini CLI configuration
- one-click OpenClaw configuration
- routing priority
- per-app assignments
- free model toggle
- local model routing
- model mapping

## Accounts and API Keys

### ChatGPT Accounts

ChatGPT accounts are added through OAuth. After they are added, CliGate stores the token locally and includes the account in routing according to the configured strategy.

### Claude Accounts

Claude accounts are added through Claude OAuth. They can serve Anthropic-compatible requests and can also be selected directly as a chat source in Web Chat.

### Antigravity Accounts

Antigravity browser OAuth requires `ANTIGRAVITY_GOOGLE_CLIENT_SECRET` in the server environment. If that secret is not available, use manual import instead of the browser login flow.

### API Keys

If you do not want to rely on account pools, you can use API keys instead. Once enabled, the system treats them as available providers for routing and chat testing.

### Minimum requirement

At least one of the following must exist:

1. a working ChatGPT account
2. a working Claude account
3. a working API key

If none of them are available, requests cannot be routed successfully.

## How to Use the Chat Page

### Start a test conversation

1. Open the Chat page
2. Choose a Chat Source
3. Enter or select a model
4. Type a prompt
5. Send the message

### What Product Assistant does

When Product Assistant is enabled, the Chat page prioritizes this manual when answering product usage questions. Example questions:

- How do I configure Claude Code?
- How do I add an API key?
- What does routing mode mean?
- How do I disable the Claude Code proxy?

If you use Chat for ordinary conversation, Product Assistant does not change the selected upstream source or model.

### Does Product Assistant affect the original proxy?

No. Product Assistant only works inside the Web Chat page. It does not alter the existing proxy behavior for Claude Code, Codex CLI, Gemini CLI, or OpenClaw.

## Claude Code Usage

### Enable Claude Code proxy

You can use the one-click action in Settings to point Claude Code to CliGate. After this operation, CliGate updates Claude Code configuration so that Claude Code uses the local proxy.

Default proxy URL:

`http://localhost:8081`

The resulting configuration uses values like:

- `ANTHROPIC_BASE_URL=http://localhost:8081`
- `ANTHROPIC_API_KEY=sk-ant-claude-code-proxy`

It also writes the default Sonnet, Opus, and Haiku model configuration used by Claude Code.

### Enable Claude Code proxy from Product Assistant

With Product Assistant enabled in Chat, you can ask:

- Help me enable the Claude Code proxy

The system will first show a pending action. The actual config is only written after you confirm it.

### Disable Claude Code proxy

If you no longer want Claude Code to use CliGate, disable the proxy. This removes the proxy-related Claude Code configuration and restores direct mode.

With Product Assistant enabled, you can ask:

- Help me disable the Claude Code proxy
- Remove the Claude Code proxy

Again, the system requires confirmation before executing the action.

### View current Claude Code config

You can inspect the current Claude configuration through:

- `GET /claude/config`

## Routing and Models

### Routing Priority

The system supports two priority modes:

- Account Pool First
- API Key First

If both pools are available, routing follows this configured priority.

### Routing Mode

Two routing modes are supported:

1. `automatic`: keep the original automatic routing behavior
2. `app-assigned`: bind specific applications to specific credentials

### App Assignments

In app-assigned mode, you can bind individual clients to fixed credentials. Examples:

- Codex always uses one ChatGPT account
- Claude Code always uses one Claude account
- OpenClaw always uses one API key

### Model Mapping

CliGate supports provider-specific model mapping. That means the requested model name and the final upstream model do not always need to be the same.

### Free Models

You can enable or disable system free model routing. When disabled, those requests are routed only through your own accounts or API keys.

## Common Scenarios

### I only want to verify that a model works

1. Add an account or API key
2. Open Chat
3. Select a source
4. Enter a model
5. Send a simple prompt

### I want Claude Code to use the local proxy

1. Make sure CliGate is running
2. Click the one-click Claude Code setup in Settings
3. Or ask Product Assistant to enable the Claude Code proxy
4. Confirm the pending action
5. Start Claude Code

### I want Claude Code to return to direct mode

1. Disable the proxy from Settings
2. Or ask Product Assistant to remove the Claude Code proxy
3. Confirm the action

## Troubleshooting

### The dashboard does not open

Make sure the service is running. The default dashboard URL is:

`http://localhost:8081`

### Claude Code is not using the proxy

Check the following:

1. CliGate is running
2. Claude Code has been configured through the one-click setup
3. `ANTHROPIC_BASE_URL` points to `http://localhost:8081`

### Chat requests fail

Check:

1. at least one working account or API key exists
2. the selected Chat Source is valid
3. the selected model is accepted by the upstream provider

### Product Assistant gives an unexpected answer

Product Assistant only answers product usage questions based on this manual. If something is not clearly stated here, it should say that the information was not found instead of inventing implementation details.

## Important Notes

1. Product Assistant only affects the Web Chat page
2. It does not automatically change the existing proxy behavior
3. Claude Code config is only written after you explicitly confirm the action
4. Asking how to do something does not automatically execute the action
