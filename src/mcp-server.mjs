// @ts-check
import { WORKBENCH_VERSION } from './version.mjs';
import {
  MCP_SERVER_INFO,
  SUPPORTED_MCP_VERSIONS,
  handleMcpJsonRpcMessage,
} from './mcp/protocol.mjs';
import { DEPRECATED_TOOL_ALIASES, TOOL_REGISTRY, getMcpToolDefinitions } from './mcp/registry.mjs';
import {
  getMcpPromptDefinitions,
  getMcpResourceDefinitions,
  getMcpResourceTemplates,
} from './mcp/resources.mjs';
import {
  getEffectiveAllowedRoots,
  isAllowedHttpOrigin,
  isTargetWithinAllowedRoots,
  parseWorkspaceRoots,
  validateToolPathArgs,
  verifyBearerTokenConstantTime,
} from './mcp/security.mjs';
import { createMcpHttpServer } from './mcp/transport-http.mjs';
import { startStdioMcpServer } from './mcp/transport-stdio.mjs';

/**
 * AI Test Workbench Native Multi-Protocol MCP Server — Public Facade.
 *
 * Refactored from a 2,255-line monolith into cohesive modules under `src/mcp/`:
 * - `registry.mjs`        — Single declarative tool registry + live JSON Schema validation
 * - `security.mjs`        — Root intersection, path traversal guards, constant-time auth & origin checks
 * - `resources.mjs`       — Resources, templates, safe URI decoding & prompts
 * - `protocol.mjs`        — Version-aware JSON-RPC 2.0 dispatcher with error boundaries
 * - `transport-stdio.mjs` — Stdio NDJSON transport with graceful child cleanup
 * - `transport-http.mjs`  — Streamable HTTP (/mcp) + Legacy SSE (/sse) with live SSE streaming
 */

export {
  DEPRECATED_TOOL_ALIASES,
  MCP_SERVER_INFO,
  SUPPORTED_MCP_VERSIONS,
  TOOL_REGISTRY,
  createMcpHttpServer,
  getEffectiveAllowedRoots,
  getMcpPromptDefinitions,
  getMcpResourceDefinitions,
  getMcpResourceTemplates,
  getMcpToolDefinitions,
  handleMcpJsonRpcMessage,
  isAllowedHttpOrigin,
  isTargetWithinAllowedRoots,
  parseWorkspaceRoots,
  startStdioMcpServer,
  validateToolPathArgs,
  verifyBearerTokenConstantTime,
};

/**
 * @param {{
 *   transport?: string,
 *   target?: string,
 *   qaDir?: string,
 *   lang?: string,
 *   workspaceRoots?: string | string[],
 *   host?: string,
 *   port?: number | string,
 *   authToken?: string,
 *   dryRun?: boolean,
 *   force?: boolean,
 *   json?: boolean,
 * }} [options]
 */
export async function runMcpServeCommand(options = {}) {
  const transport = String(options.transport || 'stdio').toLowerCase();
  if (!['stdio', 'http', 'sse'].includes(transport)) {
    console.error(`Invalid --transport "${transport}". Use: stdio | http | sse`);
    return 1;
  }

  // Guard process-level unhandled rejections so a stray async rejection never crashes long-lived MCP servers (`M-04`)
  const onUnhandledRejection = (/** @type {unknown} */ reason) => {
    console.error(
      `[AI Test Workbench MCP Error] Unhandled rejection: ${reason instanceof Error && reason.message ? reason.message : String(reason)}`
    );
  };
  process.on('unhandledRejection', onUnhandledRejection);

  try {
    if (transport === 'stdio') {
      return await startStdioMcpServer({
        defaultTarget: options.target,
        lang: options.lang,
        workspaceRoots: options.workspaceRoots,
      });
    }

    const host = options.host || '127.0.0.1';
    const port = options.port !== undefined ? Number(options.port) : 3847;
    const workspaceRoots = options.workspaceRoots || (options.target ? [options.target] : [process.cwd()]);

    const server = createMcpHttpServer({
      host,
      port,
      authToken: options.authToken,
      defaultTarget: options.target,
      lang: options.lang,
      workspaceRoots,
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(null));
    });

    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    const displayHost = host === '::1' ? '[::1]' : host;
    console.error(
      `[AI Test Workbench MCP v${WORKBENCH_VERSION}] Listening on http://${displayHost}:${actualPort}\n` +
        `  - Streamable HTTP : http://${displayHost}:${actualPort}/mcp\n` +
        `  - Legacy SSE      : http://${displayHost}:${actualPort}/sse\n` +
        `  - Health          : http://${displayHost}:${actualPort}/health`
    );

    return await new Promise((resolve) => {
      let shuttingDown = false;
      const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // Destroy open SSE keepalive connections cleanly so server.close() never hangs (`M-07`)
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        server.close(() => resolve(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
  }
}
