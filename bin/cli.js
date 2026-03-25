#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
proxypool-hub v${packageJson.version}

Multi-protocol AI API proxy server with account pooling and visual dashboard.
Supports Claude Code, Codex CLI, Gemini CLI, and OpenClaw.

USAGE:
  proxypool-hub <command> [options]

COMMANDS:
  start                 Start the proxy server (default port: 8081)
  accounts              Manage accounts (interactive)
  accounts add          Add a new account via OAuth
  accounts add --no-browser  Add account manually (headless/VM)
  accounts list         List all configured accounts
  accounts remove       Remove accounts interactively
  accounts verify       Verify account tokens are valid
  accounts clear        Remove all accounts

OPTIONS:
  --help, -h            Show this help message
  --version, -v         Show version number

ENVIRONMENT:
  PORT                  Server port (default: 8081)

EXAMPLES:
  proxypool-hub start
  PORT=3000 proxypool-hub start
  proxypool-hub accounts add
  proxypool-hub accounts add --no-browser

DASHBOARD:
  Open http://localhost:8081 to:
  - Manage ChatGPT & Claude accounts
  - Configure CLI tools (Claude Code, Codex, Gemini, OpenClaw)
  - Monitor usage, costs, and request logs
  - Manage API keys and model mappings
`);
}

function showVersion() {
  console.log(packageJson.version);
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    showVersion();
    process.exit(0);
  }

  switch (command) {
    case 'start':
    case undefined:
      await import('../src/index.js');
      break;

    case 'accounts': {
      const subCommand = args[1] || 'add';
      process.argv = ['node', 'accounts-cli.js', subCommand, ...args.slice(2)];
      await import('../src/cli/accounts.js');
      break;
    }

    case 'help':
      showHelp();
      break;

    case 'version':
      showVersion();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "proxypool-hub --help" for usage information.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
