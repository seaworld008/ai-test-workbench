// @ts-check
import http from 'node:http';
import path from 'node:path';
import { McpJobManager } from '../jobs.mjs';
import {
  BATCH_CAPABLE_MCP_VERSIONS,
  MCP_SERVER_INFO,
  SUPPORTED_MCP_VERSIONS,
  handleMcpJsonRpcMessage,
  rpcError,
} from './protocol.mjs';
import {
  hasJsonContentType,
  isAllowedHttpHost,
  isAllowedHttpOrigin,
  isLoopbackHost,
  parseWorkspaceRoots,
  readHttpBody,
  sanitizeHttpErrorMessage,
  sendHttpJson as sendJson,
  verifyBearerTokenConstantTime,
} from './security.mjs';
import { createMcpSessionStore } from './session-store.mjs';

const MAX_JSONRPC_BATCH_SIZE = 16;

/**
 * Hardened Streamable HTTP (`/mcp`) + Legacy SSE (`/sse` + `/messages`) MCP Server (`M-02..M-09`).
 *
 * - Immediate SSE streaming on `Accept: text/event-stream` POSTs using per-request `onNotification` (no race!).
 * - Session capacity/TTL management delegated to `createMcpSessionStore` (`VULN-10` 429 guard).
 * - Per-request try/catch prevents malformed requests from crashing the server.
 * - Shutdown kills all running child job process trees and closes all open SSE sockets immediately.
 * @param {{
 *   host?: string, port?: number, authToken?: string, sessionTtlMs?: number, maxSessions?: number,
 *   workspaceRoots?: string | string[], defaultTarget?: string | null, lang?: string | null,
 *   allowedOrigins?: string[], jobManager?: McpJobManager,
 * }} [options]
 */
export function createMcpHttpServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const authToken = options.authToken || process.env.AITEST_MCP_TOKEN || '';
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 60_000;
  const maxSessions = options.maxSessions ?? 32;
  const configuredRoots = parseWorkspaceRoots(options.workspaceRoots || (options.defaultTarget ? [options.defaultTarget] : []));
  const workspaceRoots = configuredRoots.length > 0 ? configuredRoots : [process.cwd()];

  if (!isLoopbackHost(host) && !authToken) {
    throw new Error(`Refusing to bind non-loopback host "${host}" without --auth-token or AITEST_MCP_TOKEN.`);
  }

  const sharedJobManager = options.jobManager || new McpJobManager();
  /** @param {string} sessionId @param {((frame: any) => void) | null} [sendNotification] */
  const makeBaseCtx = (sessionId, sendNotification = null) => ({
    sessionId,
    defaultTarget: options.defaultTarget ? path.resolve(options.defaultTarget) : null,
    defaultLang: options.lang || null,
    workspaceRoots,
    clientRoots: /** @type {string[]} */ ([]),
    protocolVersion: SUPPORTED_MCP_VERSIONS[0],
    initialized: false,
    logLevel: 'info',
    jobManager: sharedJobManager,
    sendNotification,
  });

  const sessions = createMcpSessionStore({
    sessionTtlMs,
    maxSessions,
    hasAuthToken: Boolean(authToken),
    makeBaseCtx,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const addr = server.address();
      const listenPort = addr && typeof addr === 'object' ? addr.port : options.port ?? null;
      if (!isAllowedHttpHost(req.headers.host, host, listenPort)) {
        sendJson(res, 421, { error: 'Misdirected Request: Host header not allowed' });
        return;
      }

      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = reqUrl.pathname;

      if (!isAllowedHttpOrigin(req.headers.origin, options.allowedOrigins, { listenPort, hasAuthToken: Boolean(authToken) })) {
        sendJson(res, 403, { error: 'Origin not allowed (DNS rebinding / cross-port protection)' });
        return;
      }

      if (pathname === '/health' && req.method === 'GET') {
        if (!isLoopbackHost(host) && authToken && !verifyBearerTokenConstantTime(req.headers.authorization, authToken)) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          server: MCP_SERVER_INFO,
          supportedVersions: SUPPORTED_MCP_VERSIONS,
          transports: ['streamable-http (/mcp)', 'legacy-sse (/sse + /messages)'],
        });
        return;
      }

      if (authToken && !verifyBearerTokenConstantTime(req.headers.authorization, authToken)) {
        sendJson(res, 401, { error: 'Unauthorized: missing or invalid Bearer token' });
        return;
      }

      const protocolHeader = req.headers['mcp-protocol-version'];
      if (protocolHeader && !SUPPORTED_MCP_VERSIONS.includes(String(protocolHeader))) {
        sendJson(res, 400, { error: `Unsupported MCP-Protocol-Version header "${protocolHeader}"` });
        return;
      }

      // Legacy 2024-11-05 HTTP+SSE Transport: GET /sse & POST /messages?sessionId=...
      if (pathname === '/sse' && req.method === 'GET') {
        const created = sessions.createLegacySseSession(req, res);
        if (!created.ok) {
          sendJson(res, 429, { error: 'Too Many Requests: active MCP SSE session capacity reached' });
        }
        return;
      }

      if (pathname === '/messages' && req.method === 'POST') {
        sessions.pruneExpiredSessions();
        if (!hasJsonContentType(req.headers['content-type'])) {
          sendJson(res, 415, { error: 'Unsupported Media Type: expected application/json' });
          return;
        }
        const sessionId = reqUrl.searchParams.get('sessionId');
        const session = sessions.getLegacySseSession(sessionId);
        if (!session || session.res.writableEnded) {
          sendJson(res, 404, { error: 'Unknown or closed SSE sessionId' });
          return;
        }
        session.lastActiveAt = Date.now();

        let payload;
        try {
          payload = JSON.parse(await readHttpBody(req));
        } catch (err) {
          sendJson(
            res,
            400,
            rpcError(null, -32700, sanitizeHttpErrorMessage(err instanceof Error ? err.message : String(err)))
          );
          return;
        }

        if (Array.isArray(payload) && (payload.length === 0 || payload.length > MAX_JSONRPC_BATCH_SIZE)) {
          sendJson(res, 400, rpcError(null, -32600, `Invalid JSON-RPC batch size (1..${MAX_JSONRPC_BATCH_SIZE} allowed)`));
          return;
        }
        const messages = Array.isArray(payload) ? payload : [payload];
        res.writeHead(202, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Accepted');

        // Dispatch asynchronously per MCP 2024-11-05 HTTP+SSE spec so clients receive 202 immediately
        // and can concurrently send notifications/cancelled while long tool calls run.
        void (async () => {
          for (const item of messages) {
            try {
              const rpcRes = await handleMcpJsonRpcMessage(item, session.ctx, {
                onNotification: session.ctx.sendNotification,
              });
              if (rpcRes !== null && !session.res.writableEnded) {
                session.res.write(`event: message\ndata: ${JSON.stringify(rpcRes)}\n\n`);
              }
            } catch (err) {
              if (!session.res.writableEnded) {
                const msg = err instanceof Error && err.message ? err.message : String(err);
                const errFrame = rpcError(item?.id ?? null, -32603, `Internal SSE dispatch error: ${msg}`);
                session.res.write(`event: message\ndata: ${JSON.stringify(errFrame)}\n\n`);
              }
            }
          }
        })();
        return;
      }

      // Modern Streamable HTTP Transport: POST / GET / DELETE /mcp
      if (pathname === '/mcp') {
        sessions.pruneExpiredSessions();

        if (req.method === 'DELETE') {
          const sid = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : null;
          if (!sessions.deleteStreamableSession(sid)) {
            sendJson(res, 404, { error: 'Unknown or expired Mcp-Session-Id' });
            return;
          }
          sendJson(res, 200, { ok: true, closed: true });
          return;
        }

        if (req.method === 'GET') {
          const sid = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : null;
          const session = sessions.getStreamableSession(sid);
          if (!sid || !session) {
            sendJson(res, 404, { error: 'Unknown or expired Mcp-Session-Id; initialize session first' });
            return;
          }
          if (session.sseRes && !session.sseRes.writableEnded) {
            sendJson(res, 409, { error: 'Conflict: SSE stream already open for this Mcp-Session-Id' });
            return;
          }
          session.lastActiveAt = Date.now();
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'Mcp-Session-Id': sid,
          });
          res.write(': stream-open\n\n');
          const keepalive = setInterval(() => {
            if (!res.writableEnded) res.write(': keepalive\n\n');
          }, 15_000);
          session.sseRes = res;
          session.sseKeepalive = keepalive;
          req.on('close', () => {
            clearInterval(keepalive);
            if (session.sseRes === res) {
              session.sseRes = null;
              session.sseKeepalive = null;
            }
          });
          return;
        }

        if (req.method === 'POST') {
          if (!hasJsonContentType(req.headers['content-type'])) {
            sendJson(res, 415, { error: 'Unsupported Media Type: expected application/json' });
            return;
          }
          let payload;
          try {
            payload = JSON.parse(await readHttpBody(req));
          } catch (err) {
            sendJson(
              res,
              400,
              rpcError(null, -32700, sanitizeHttpErrorMessage(err instanceof Error ? err.message : String(err)))
            );
            return;
          }

          const isInitCall = !Array.isArray(payload) && payload?.method === 'initialize';
          let sid = req.headers['mcp-session-id'] ? String(req.headers['mcp-session-id']) : null;
          let session;

          if (isInitCall) {
            const created = sessions.createStreamableSession();
            if (!created.ok) {
              sendJson(res, 429, { error: 'Too Many Requests: active MCP session capacity reached' });
              return;
            }
            sid = created.sid;
            session = created.session;
          } else {
            session = sessions.getStreamableSession(sid);
            if (!sid || !session) {
              sendJson(res, 404, {
                error: 'Missing or unknown Mcp-Session-Id. Streamable HTTP requires calling "initialize" first.',
              });
              return;
            }
          }

          session.lastActiveAt = Date.now();

          if (Array.isArray(payload)) {
            if (!BATCH_CAPABLE_MCP_VERSIONS.has(session.ctx.protocolVersion)) {
              sendJson(
                res,
                400,
                rpcError(
                  null,
                  -32600,
                  `JSON-RPC batching was removed in MCP ${session.ctx.protocolVersion}; send individual requests.`
                )
              );
              return;
            }
            if (payload.length === 0 || payload.length > MAX_JSONRPC_BATCH_SIZE) {
              sendJson(
                res,
                400,
                rpcError(null, -32600, `Invalid JSON-RPC batch size (1..${MAX_JSONRPC_BATCH_SIZE} allowed)`)
              );
              return;
            }
            const replies = (
              await Promise.all(
                payload.map((item) =>
                  handleMcpJsonRpcMessage(item, session.ctx, { onNotification: session.ctx.sendNotification })
                )
              )
            ).filter((r) => r !== null);
            if (replies.length === 0) {
              res.writeHead(202, {
                'Mcp-Session-Id': sid,
                'MCP-Protocol-Version': session.ctx.protocolVersion,
              });
              res.end();
              return;
            }
            sendJson(res, 200, replies, {
              'Mcp-Session-Id': sid,
              'MCP-Protocol-Version': session.ctx.protocolVersion,
            });
            return;
          }

          const accept = String(req.headers.accept || '');
          const acceptsSse = accept.includes('text/event-stream');
          const hasProgressToken = payload?.params?._meta?.progressToken !== undefined;
          const wantsSseStream = acceptsSse && (!accept.includes('application/json') || hasProgressToken);

          if (wantsSseStream) {
            const headers = {
              'Mcp-Session-Id': sid,
              'MCP-Protocol-Version': session.ctx.protocolVersion,
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache, no-transform',
            };
            let sseHeadersSent = false;
            const ensureSseHeaders = () => {
              if (!sseHeadersSent && !res.writableEnded) {
                res.writeHead(200, headers);
                sseHeadersSent = true;
              }
            };
            const perRequestNotify = (/** @type {any} */ frame) => {
              ensureSseHeaders();
              if (!res.writableEnded) {
                res.write(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
              }
            };

            const reply = await handleMcpJsonRpcMessage(payload, session.ctx, {
              onNotification: perRequestNotify,
            });
            if (reply === null) {
              if (!sseHeadersSent) {
                res.writeHead(202, {
                  'Mcp-Session-Id': sid,
                  'MCP-Protocol-Version': session.ctx.protocolVersion,
                });
              }
              res.end();
              return;
            }
            ensureSseHeaders();
            if (!res.writableEnded) {
              res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
              res.end();
            }
            return;
          }

          const reply = await handleMcpJsonRpcMessage(payload, session.ctx, {
            onNotification: session.ctx.sendNotification,
          });
          const headers = {
            'Mcp-Session-Id': sid,
            'MCP-Protocol-Version': session.ctx.protocolVersion,
          };
          if (reply === null) {
            res.writeHead(202, headers);
            res.end();
            return;
          }
          sendJson(res, 200, reply, headers);
          return;
        }

        res.writeHead(405, { Allow: 'GET, POST, DELETE' });
        res.end('Method Not Allowed');
        return;
      }

      sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      const msg = sanitizeHttpErrorMessage(err instanceof Error && err.message ? err.message : String(err));
      sendJson(res, 500, rpcError(null, -32603, `Internal HTTP transport error: ${msg}`));
    }
  });

  const cleanup = () => {
    sharedJobManager.killAll();
    sessions.closeAll();
  };
  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', cleanup);

  return server;
}
