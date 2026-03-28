/**
 * SSE Helpers
 * Shared utilities for Server-Sent Events streaming and error responses.
 */

import { formatSSEEvent } from '../response-streamer.js';
import { logger } from '../utils/logger.js';

/**
 * Sets the standard SSE response headers and flushes them.
 * @param {import('express').Response} res
 */
export function initSSEResponse(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/**
 * Streams an async generator of Anthropic-format SSE events to the response.
 * Writes [DONE] and ends the response when the generator is exhausted.
 *
 * @param {import('express').Response} res
 * @param {AsyncIterable<object>} eventStream
 */
export async function pipeSSEStream(res, eventStream) {
  for await (const event of eventStream) {
    if (res.writableEnded || res.destroyed) break;
    res.write(formatSSEEvent(event));
  }
  if (!res.writableEnded && !res.destroyed) {
    try {
      res.write('data: [DONE]\n\n');
      res.end();
    } catch { /* client disconnected */ }
  }
}

/**
 * Sends a structured Anthropic-style error JSON response.
 * If headers have already been sent (mid-stream), writes an SSE error event instead.
 *
 * @param {import('express').Response} res
 * @param {Error} error
 * @param {string} model
 * @param {number} startTime
 */
export function handleStreamError(res, error, model, startTime) {
  const duration = Date.now() - startTime;
  logger.response(500, { model, error: error.message, duration });

  // Response already fully closed — nothing we can do, just log and bail
  if (res.writableEnded || res.destroyed) {
    return;
  }

  if (res.headersSent) {
    try {
      res.write(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: error.message }
        })}\n\n`
      );
    } catch { /* ignore write errors on closing streams */ }
    try { res.end(); } catch { /* ignore */ }
    return;
  }

  if (error.message.includes('AUTH_EXPIRED')) {
    return res.status(401).json({
      type: 'error',
      error: { type: 'authentication_error', message: 'Token expired. Please refresh or re-authenticate.' }
    });
  }

  if (error.message.startsWith('RATE_LIMITED:')) {
    const parts = error.message.split(':');
    const resetMs = parseInt(parts[1], 10);
    const errorText = parts.slice(2).join(':') || error.message;

    return res.status(429).json({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: errorText,
        resetMs: resetMs,
        resetSeconds: Math.round(resetMs / 1000)
      }
    });
  }

  if (error.message.includes('RESOURCE_EXHAUSTED') || error.message.includes('MODEL_QUOTA_EXHAUSTED')) {
    return res.status(429).json({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Model usage quota exhausted. Try a different model or wait for quota to reset.' }
    });
  }

  res.status(500).json({
    type: 'error',
    error: { type: 'api_error', message: error.message }
  });
}

export default { initSSEResponse, pipeSSEStream, handleStreamError };
