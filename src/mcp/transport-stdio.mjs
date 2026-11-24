// @ts-check
import path from 'node:path';
import readline from 'node:readline';
import { McpJobManager } from '../jobs.mjs';
import {
  BATCH_CAPABLE_MCP_VERSIONS,
  SUPPORTED_MCP_VERSIONS,
  handleMcpJsonRpcMessage,
  rpcError,
} from './protocol.mjs';
import { parseWorkspaceRoots } from './security.mjs';

/**
 * Hardened Stdio MCP Transport (`M-02`, `M-04`, `M-07`):
 * - Zero global `console.log` hijacking (all tool work runs in isolated child processes).
 * - Fail-closed workspace roots defaulting to `[defaultTarget || process.cwd()]`.
 * - Per-request error isolation so malformed frames never crash the server.
 * - Clean process-tree cleanup (`jobManager.killAll()`) on stdin EOF, SIGINT, or SIGTERM.
 * @param {{ defaultTarget?: string | null, lang?: string | null, workspaceRoots?: string | string[] }} [options]
 * @returns {Promise<number>}
 */
export function startStdioMcpServer(options = {}) {
  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  const sendFrame = (/** @type {unknown} */ obj) => {
    if (obj !== null && obj !== undefined) {
      rawStdoutWrite(JSON.stringify(obj) + '\n');
    }
  };

  const configuredRoots = parseWorkspaceRoots(options.workspaceRoots || '');
  const defaultTarget = options.defaultTarget ? path.resolve(options.defaultTarget) : null;
  const workspaceRoots =
    configuredRoots.length > 0 ? configuredRoots : [defaultTarget || process.cwd()];

  const jobManager = new McpJobManager();
  const ctx = {
    sessionId: 'stdio',
    defaultTarget,
    defaultLang: options.lang || null,
    workspaceRoots,
    clientRoots: /** @type {string[]} */ ([]),
    protocolVersion: SUPPORTED_MCP_VERSIONS[0],
    initialized: false,
    logLevel: 'info',
    jobManager,
    sendNotification: sendFrame,
  };

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      sendFrame(rpcError(null, -32700, 'Parse error'));
      return;
    }

    void (async () => {
      try {
        if (Array.isArray(payload)) {
          if (!BATCH_CAPABLE_MCP_VERSIONS.has(ctx.protocolVersion)) {
            sendFrame(
              rpcError(
                null,
                -32600,
                `JSON-RPC batch requests are not supported in MCP protocolVersion ${ctx.protocolVersion}`
              )
            );
            return;
          }
          if (payload.length === 0) {
            sendFrame(rpcError(null, -32600, 'Empty batch'));
            return;
          }
          const responses = await Promise.all(
            payload.map((item) => handleMcpJsonRpcMessage(item, ctx, { onNotification: sendFrame }))
          );
          const nonNull = responses.filter((r) => r !== null);
          if (nonNull.length > 0) sendFrame(nonNull);
          return;
        }

        const res = await handleMcpJsonRpcMessage(payload, ctx, { onNotification: sendFrame });
        if (res !== null) sendFrame(res);
      } catch (err) {
        sendFrame(
          rpcError(
            payload?.id ?? null,
            -32603,
            `Transport error: ${err instanceof Error && err.message ? err.message : String(err)}`
          )
        );
      }
    })();
  });

  return new Promise((resolve) => {
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      jobManager.killAll();
      rl.close();
      resolve(0);
    };
    rl.on('close', shutdown);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
