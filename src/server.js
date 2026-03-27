/**
 * Server bootstrap
 * Creates the Express app, middleware, and registers API routes.
 */

import express from 'express';
import cors from 'cors';

import { ensureAccountsPersist, startAutoRefresh } from './account-manager.js';
import { ensureAccountsPersist as ensureClaudeAccountsPersist, startAutoRefresh as startClaudeAutoRefresh } from './claude-account-manager.js';
import { registerApiRoutes } from './routes/api-routes.js';
import { handleResponses } from './routes/responses-route.js';
import { setRequestLoggingEnabled } from './request-logger.js';
import { getServerSettings } from './server-settings.js';
import { startModelDiscovery } from './model-discovery.js';

export function createServer({ port }) {
  ensureAccountsPersist();
  startAutoRefresh();

  // Claude accounts
  ensureClaudeAccountsPersist();
  startClaudeAutoRefresh();

  // Sync request logging state from persisted settings
  const settings = getServerSettings();
  setRequestLoggingEnabled(settings.enableRequestLogging !== false);

  // Start automatic model discovery (initial + periodic refresh)
  startModelDiscovery();

  const app = express();
  app.disable('x-powered-by');

  // High-level request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      const msg = `[${req.method}] ${req.originalUrl} ${res.statusCode} (${duration}ms)`;
      if (res.statusCode >= 400) {
        console.log(`\x1b[31m${msg}\x1b[0m`); // Red for error
      } else if (req.originalUrl !== '/health') { // Skip health check logs to reduce noise
        console.log(`\x1b[36m${msg}\x1b[0m`); // Cyan for success
      }
    });
    next();
  });

  app.use(cors({
    origin: [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      'http://localhost',
      'http://127.0.0.1'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Content-Encoding',
                     'ChatGPT-Account-ID', 'OpenAI-Organization'],
    credentials: false
  }));

  // Register /responses BEFORE express.json() —
  // Codex CLI sends zstd-compressed bodies that express.json() cannot parse.
  // This route reads the raw body and forwards it as-is.
  app.post('/responses', handleResponses);
  app.post('/v1/responses', handleResponses);

  app.use(express.json({ limit: '10mb' }));

  registerApiRoutes(app, { port });

  // Global error handler — catches unhandled errors in route handlers
  app.use((err, req, res, _next) => {
    console.error(`[Server] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ type: 'error', error: { type: 'server_error', message: err.message } });
    }
  });

  return app;
}

export function startServer({ port }) {
  const app = createServer({ port });
  return app.listen(port);
}

export default { createServer, startServer };
