// @ts-check
import crypto from 'node:crypto';

/**
 * @typedef {{
 *   ctx: Record<string, any>,
 *   sseRes: import('node:http').ServerResponse | null,
 *   sseKeepalive: NodeJS.Timeout | null,
 *   createdAt: number,
 *   lastActiveAt: number,
 * }} StreamableSessionEntry
 *
 * @typedef {{
 *   res: import('node:http').ServerResponse,
 *   ctx: Record<string, any>,
 *   keepalive: NodeJS.Timeout,
 *   createdAt: number,
 *   lastActiveAt: number,
 * }} LegacySseSessionEntry
 */

/**
 * Manages Streamable HTTP (`/mcp`) and Legacy SSE (`/sse`) session lifecycles with TTL pruning,
 * unauthenticated 429 capacity protection (`VULN-10`), and deterministic shutdown cleanup.
 * @param {{
 *   sessionTtlMs: number,
 *   maxSessions: number,
 *   hasAuthToken: boolean,
 *   makeBaseCtx: (sessionId: string, sendNotification?: ((frame: any) => void) | null) => Record<string, any>,
 * }} options
 */
export function createMcpSessionStore({ sessionTtlMs, maxSessions, hasAuthToken, makeBaseCtx }) {
  /** @type {Map<string, StreamableSessionEntry>} */
  const streamableSessions = new Map();
  /** @type {Map<string, LegacySseSessionEntry>} */
  const legacySseSessions = new Map();

  /** @param {StreamableSessionEntry | undefined} entry */
  const closeStreamableEntry = (entry) => {
    if (!entry) return;
    if (entry.sseKeepalive) clearInterval(entry.sseKeepalive);
    if (entry.sseRes && !entry.sseRes.writableEnded) entry.sseRes.end();
  };

  /** @param {LegacySseSessionEntry | undefined} entry */
  const closeLegacyEntry = (entry) => {
    if (!entry) return;
    clearInterval(entry.keepalive);
    if (entry.res && !entry.res.writableEnded) entry.res.end();
  };

  const pruneExpiredSessions = () => {
    const now = Date.now();
    for (const [id, s] of streamableSessions.entries()) {
      if (now - s.lastActiveAt > sessionTtlMs) {
        closeStreamableEntry(s);
        streamableSessions.delete(id);
      }
    }
    for (const [id, s] of legacySseSessions.entries()) {
      if (now - s.lastActiveAt > sessionTtlMs) {
        closeLegacyEntry(s);
        legacySseSessions.delete(id);
      }
    }
  };

  // Reject new unauthenticated sessions at capacity (429) instead of evicting active victim sessions (`VULN-10`)
  /** @template T @param {Map<string, T>} map @param {(entry: T | undefined) => void} closeEntry @returns {boolean} */
  const ensureCapacityForNewSession = (map, closeEntry) => {
    pruneExpiredSessions();
    if (map.size < maxSessions) return true;
    if (!hasAuthToken) return false;
    while (map.size >= maxSessions) {
      const oldestId = map.keys().next().value;
      if (!oldestId) break;
      closeEntry(map.get(oldestId));
      map.delete(oldestId);
    }
    return true;
  };

  /** @returns {{ ok: true, sid: string, session: StreamableSessionEntry } | { ok: false }} */
  const createStreamableSession = () => {
    if (!ensureCapacityForNewSession(streamableSessions, closeStreamableEntry)) {
      return { ok: false };
    }
    const sid = crypto.randomUUID();
    const now = Date.now();
    /** @type {StreamableSessionEntry} */
    const entry = {
      ctx: {},
      sseRes: null,
      sseKeepalive: null,
      createdAt: now,
      lastActiveAt: now,
    };
    entry.ctx = makeBaseCtx(sid, (/** @type {any} */ frame) => {
      if (entry.sseRes && !entry.sseRes.writableEnded) {
        entry.sseRes.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
      }
    });
    streamableSessions.set(sid, entry);
    return { ok: true, sid, session: entry };
  };

  /** @param {string | null} sid */
  const getStreamableSession = (sid) => (sid ? streamableSessions.get(sid) : undefined);

  /** @param {string | null} sid @returns {boolean} */
  const deleteStreamableSession = (sid) => {
    const s = sid ? streamableSessions.get(sid) : undefined;
    if (!sid || !s) return false;
    closeStreamableEntry(s);
    streamableSessions.delete(sid);
    return true;
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {{ ok: true, sessionId: string } | { ok: false }}
   */
  const createLegacySseSession = (req, res) => {
    if (!ensureCapacityForNewSession(legacySseSessions, closeLegacyEntry)) {
      return { ok: false };
    }
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }, 15_000);
    const notifyFn = (/** @type {any} */ frame) => {
      if (!res.writableEnded) res.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
    };
    const now = Date.now();
    legacySseSessions.set(sessionId, {
      res,
      ctx: makeBaseCtx(sessionId, notifyFn),
      keepalive,
      createdAt: now,
      lastActiveAt: now,
    });
    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    req.on('close', () => {
      clearInterval(keepalive);
      legacySseSessions.delete(sessionId);
    });
    return { ok: true, sessionId };
  };

  /** @param {string | null} sessionId */
  const getLegacySseSession = (sessionId) => (sessionId ? legacySseSessions.get(sessionId) : undefined);

  const closeAll = () => {
    for (const s of legacySseSessions.values()) closeLegacyEntry(s);
    legacySseSessions.clear();
    for (const s of streamableSessions.values()) closeStreamableEntry(s);
    streamableSessions.clear();
  };

  return {
    pruneExpiredSessions,
    createStreamableSession,
    getStreamableSession,
    deleteStreamableSession,
    createLegacySseSession,
    getLegacySseSession,
    closeAll,
  };
}
