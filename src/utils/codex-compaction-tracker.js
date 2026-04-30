/**
 * Codex auto-compaction continuation tracker.
 *
 * Codex CLI's run_turn loop relies on a private response field `end_turn: false`
 * (or an in-flight tool call) to keep iterating. After Codex performs an
 * auto-compaction mid-turn, the model is invoked again with a compacted
 * history; if the model returns a plain text response on a non-OpenAI backend
 * (which doesn't emit `end_turn`), the loop terminates and the user has to
 * type a new prompt to resume work. This module recognizes the post-compaction
 * continuation request so the route can patch `end_turn: false` into the
 * response and let the agent keep going.
 *
 * Detection uses only protocol-level fields, never request-content text:
 *   - `session_id` HTTP header (set by Codex's build_conversation_headers)
 *   - `x-codex-window-id` HTTP header (Codex bumps the trailing generation
 *     number on every replace_compacted_history call)
 *   - `body.tools` shape (compaction requests use Prompt::default(), tools=[])
 *   - request path ending in `/compact` (remote compaction endpoint)
 *
 * Manual `/compact` and auto-compaction look identical at the protocol level
 * (both call replace_compacted_history). They are disambiguated by timing:
 * an auto-compaction continuation arrives within milliseconds of the
 * compaction request, while manual /compact's follow-up requires a human to
 * type something. A 30-second window cleanly separates the two.
 */

const SESSIONS = new Map();
const CONTINUATION_WINDOW_MS = 30_000;
const SESSION_GC_TTL_MS = 5 * 60_000;

function gc(now) {
    for (const [k, v] of SESSIONS) {
        if (now - (v.touchedAt || 0) > SESSION_GC_TTL_MS) SESSIONS.delete(k);
    }
}

function parseWindowGen(headerValue) {
    if (typeof headerValue !== 'string' || headerValue.length === 0) return null;
    const tail = headerValue.split(':').pop();
    const n = Number.parseInt(tail, 10);
    return Number.isFinite(n) ? n : null;
}

function isCompactionRequest(req, body) {
    if (typeof req?.path === 'string' && req.path.endsWith('/compact')) return true;
    const tools = body && Array.isArray(body.tools) ? body.tools : [];
    return tools.length === 0;
}

/**
 * Inspect a request and return whether its response should be patched with
 * `end_turn: false`. Has the side effect of advancing per-session state.
 *
 * Returns false when:
 *   - the request lacks Codex-specific headers (not a Codex request)
 *   - the request itself is a compaction request (don't patch summarization)
 *   - no compaction was seen recently in this session
 *   - the previous compaction was likely a manual /compact (out of time window)
 *
 * @param {object} req  Express request (uses req.headers and req.path)
 * @param {object} body parsed Codex Responses API request body
 * @returns {boolean}
 */
export function shouldInjectEndTurnFalse(req, body) {
    if (!req || !body) return false;
    const sessionId = req.headers && req.headers['session_id'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;

    const windowGen = parseWindowGen(req.headers['x-codex-window-id']);
    if (windowGen === null) return false;

    const now = Date.now();
    gc(now);

    let entry = SESSIONS.get(sessionId);
    if (!entry) {
        entry = { pendingAt: null, lastWindowGen: null, touchedAt: now };
        SESSIONS.set(sessionId, entry);
    }
    entry.touchedAt = now;

    if (isCompactionRequest(req, body)) {
        entry.pendingAt = now;
        entry.lastWindowGen = windowGen;
        return false;
    }

    const pendingAt = entry.pendingAt;
    const lastGen = entry.lastWindowGen;
    const isAutoContinuation =
        pendingAt !== null &&
        now - pendingAt < CONTINUATION_WINDOW_MS &&
        lastGen !== null &&
        windowGen > lastGen;

    entry.pendingAt = null;
    entry.lastWindowGen = windowGen;

    return isAutoContinuation;
}

/**
 * Set `end_turn: false` on a Codex Responses API response object in place.
 * No-op on null / non-object input.
 */
export function applyEndTurnFalse(responsesFormat) {
    if (responsesFormat && typeof responsesFormat === 'object') {
        responsesFormat.end_turn = false;
    }
    return responsesFormat;
}

/**
 * If `res.locals.codexInjectEndTurn` was set earlier in this request, apply
 * end_turn=false to the given response object. Convenience for handlers that
 * use `res.json(...)` directly (the SSE path is handled inside sendResponsesSSE).
 */
export function maybeInjectFromLocals(res, responsesFormat) {
    if (res && res.locals && res.locals.codexInjectEndTurn) {
        applyEndTurnFalse(responsesFormat);
    }
    return responsesFormat;
}
