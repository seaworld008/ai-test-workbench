// @ts-check
import { validateJsonSchema } from '../kernel/schema-validator.mjs';
import { DISCOVERY_TOOLS } from './tools/discovery.mjs';
import { makeOutputSchema } from './tools/shared.mjs';
import { DEPRECATED_TOOL_ALIASES, STATEFUL_TOOLS } from './tools/stateful.mjs';
import { VERIFICATION_TOOLS } from './tools/verification.mjs';

/**
 * Single Declarative MCP Tool Registry (`v6.4` preview, 17 canonical tools + 8 deprecated aliases).
 *
 * Composed from cohesive domain tool lists (`tools/discovery.mjs`, `tools/verification.mjs`,
 * `tools/parity-tool.mjs`, `tools/stateful.mjs`) where each tool owns its schema, annotations,
 * CLI argument builder, optional in-memory `execute` hook, and recommended next actions.
 */

/** @type {import('./tools/shared.mjs').ToolRegistryEntry[]} */
export const TOOL_REGISTRY = [...DISCOVERY_TOOLS, ...VERIFICATION_TOOLS, ...STATEFUL_TOOLS];

/** @type {Map<string, import('./tools/shared.mjs').ToolRegistryEntry>} */
export const TOOL_BY_NAME = new Map(TOOL_REGISTRY.map((entry) => [entry.name, entry]));

export { DEPRECATED_TOOL_ALIASES };

/**
 * Resolves a `tools/call` request name against canonical tools AND v6.x deprecated v5 aliases.
 * @param {string} name
 * @param {Record<string, any>} rawArgs
 */
export function resolveToolCall(name, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
  const direct = TOOL_BY_NAME.get(name);
  if (direct) {
    return {
      found: true,
      toolEntry: direct,
      canonicalName: direct.name,
      calledName: name,
      effectiveArgs: args,
      deprecation: null,
    };
  }

  const alias = DEPRECATED_TOOL_ALIASES[name];
  if (alias) {
    const targetEntry = TOOL_BY_NAME.get(alias.targetTool);
    if (!targetEntry) return { found: false };
    /** @type {Record<string, any>} */
    const effectiveArgs = {
      ...args,
      ...(alias.fixedArgs || {}),
      ...(alias.fixedAction ? { action: alias.fixedAction } : {}),
    };
    return {
      found: true,
      toolEntry: targetEntry,
      canonicalName: targetEntry.name,
      calledName: name,
      effectiveArgs,
      deprecation: {
        deprecatedTool: alias.deprecatedTool,
        replacement: alias.replacement || `${alias.targetTool}(action="${alias.fixedAction}")`,
        deprecatedSince: alias.deprecatedSince,
        removeIn: alias.removeIn,
      },
    };
  }

  return { found: false };
}

/**
 * Generates MCP `tools/list` definitions directly from the canonical 17-tool registry.
 * Omits `outputSchema` when explicitly negotiating legacy `2024-11-05` (`M-10`).
 * @param {string} [protocolVersion]
 */
export function getMcpToolDefinitions(protocolVersion = '2025-11-25') {
  const includeOutputSchema = protocolVersion !== '2024-11-05';
  return TOOL_REGISTRY.map((entry) => {
    /** @type {Record<string, any>} */
    const def = {
      name: entry.name,
      title: entry.title,
      description: entry.description,
      annotations: entry.annotations,
      inputSchema: entry.inputSchema,
    };
    if (includeOutputSchema) {
      def.outputSchema = makeOutputSchema(entry.dataProps || {});
    }
    return def;
  });
}

/**
 * Validates tool arguments against the tool's declared JSON Schema and optional extra cross-field checks (`M-08`).
 * Allows `target` to be supplied via `ctx.defaultTarget` before checking required fields.
 * @param {import('./tools/shared.mjs').ToolRegistryEntry} toolEntry
 * @param {Record<string, any>} args
 * @param {string | null} defaultTarget
 */
export function validateToolArguments(toolEntry, args, defaultTarget) {
  const effectiveArgs = { ...args };
  if (!effectiveArgs.target && defaultTarget && toolEntry.inputSchema?.properties?.target) {
    effectiveArgs.target = defaultTarget;
  }
  const baseCheck = validateJsonSchema(effectiveArgs, toolEntry.inputSchema);
  const errors = [...(baseCheck.errors || [])];
  if (typeof toolEntry.validateExtra === 'function') {
    errors.push(...toolEntry.validateExtra(effectiveArgs));
  }
  return { ok: errors.length === 0, errors };
}
