/**
 * CliGate
 * Entry point
 */

import { startServer } from './server.js';
import { logger } from './utils/logger.js';
import { getStatus, ACCOUNTS_FILE } from './account-manager.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const PORT = Number(process.env.PORT || 8081);
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

startServer({ port: PORT });

console.log(`
╔══════════════════════════════════════════════════════════════╗
║                      CliGate v${packageJson.version}                             ║
║                   (Direct API Mode)                          ║
╠══════════════════════════════════════════════════════════════╣
║  Server:   http://localhost:${PORT}                          ║
║  WebUI:    http://localhost:${PORT}                          ║
║  Health:   http://localhost:${PORT}/health                   ║
║  Accounts: http://localhost:${PORT}/accounts                 ║
║  Logs:     http://localhost:${PORT}/api/logs/stream          ║
╠══════════════════════════════════════════════════════════════╣
║  Features:                                                   ║
║    ✓ Native tool calling support                             ║
║    ✓ Real-time streaming                                     ║
║    ✓ Multi-account management                                ║
║    ✓ OpenAI & Anthropic API compatibility                    ║
╠══════════════════════════════════════════════════════════════╣
║  Support:                                                    ║
║    ★ Give it a star on GitHub!                               ║
║    https://github.com/codeking-ai/cligate║
╚══════════════════════════════════════════════════════════════╝
`);

const status = getStatus();
logger.info(`Accounts: ${status.total} total, Active: ${status.active || 'None'}`);

if (status.total === 0) {
  logger.warn(`No accounts configured. Open http://localhost:${PORT} to add one.`);
}

// Expose config path in logs for convenience
logger.info(`Accounts config: ${ACCOUNTS_FILE}`);
