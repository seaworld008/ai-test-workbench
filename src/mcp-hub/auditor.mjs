// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MCP_PRESETS } from './catalog.mjs';

/** @type {Record<string, { riskLevel: string }>} */
const PRESETS_BY_NAME = MCP_PRESETS;

const PROMPT_POISONING_RE =
  /(ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+system\s+prompt|<\s*system\s*>|you\s+are\s+now\s+in\s+developer\s+mode|exfiltrate|send\s+.*\s+to\s+https?:\/\/|\bcurl\s+-X\s+POST\b)/i;

/**
 * Scans MCP tool/server metadata for prompt-poisoning payloads and verifies SHA-256 lockfile integrity (`R1-6`).
 * @param {Record<string, { description?: string, command?: string, args?: string[] }>} serverOrToolSpecs
 * @param {Record<string, string> | null} [lockedHashes]
 */
export function auditMcpDescriptorsAndLock(serverOrToolSpecs, lockedHashes = null) {
  const issues = [];
  /** @type {Record<string, string>} */
  const computedHashes = {};

  for (const [name, spec] of Object.entries(serverOrToolSpecs || {})) {
    const desc = String(spec?.description || '');
    const normalized = JSON.stringify({
      command: spec?.command || null,
      args: spec?.args || [],
      description: desc,
    });
    const digest = `sha256:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
    computedHashes[name] = digest;

    if (PROMPT_POISONING_RE.test(desc)) {
      issues.push(`[MCP Prompt-Poisoning Guard] Server/tool "${name}" contains suspicious prompt-injection instructions.`);
    }
    if (lockedHashes && name in lockedHashes && lockedHashes[name] !== digest) {
      issues.push(
        `[MCP Lock Drift] Server/tool "${name}" descriptor hash drifted from .aitest/mcp.lock (${digest.slice(0, 19)} != ${String(lockedHashes[name]).slice(0, 19)}).`
      );
    }
  }

  if (lockedHashes) {
    for (const lockedName of Object.keys(lockedHashes)) {
      if (!(lockedName in computedHashes)) {
        issues.push(`[MCP Lock Drift] Locked MCP entry "${lockedName}" was removed without updating .aitest/mcp.lock.`);
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    hashes: computedHashes,
  };
}

/**
 * Audits `.mcp.json` and `.codex/config.toml` for write flags, `@latest` unpinned tags, archived packages,
 * hardcoded secrets, and `.aitest/mcp.lock` drift.
 * @param {{ mcpServers?: Record<string, Record<string, any>> } | null | undefined} mcpJsonObj
 * @param {string} [codexTomlText]
 * @param {{ lockedHashes?: Record<string, string> | null }} [options]
 */
export function auditMcpSafety(mcpJsonObj, codexTomlText = '', options = {}) {
  const issues = [];
  const warnings = [];
  const checkedServers = [];
  /** @type {Record<string, string>} */
  const riskByServer = {};

  const servers = mcpJsonObj?.mcpServers || {};
  for (const [name, cfg] of Object.entries(servers)) {
    checkedServers.push(name);
    const argsStr = Array.isArray(cfg.args) ? cfg.args.join(' ') : '';
    const env = cfg.env || {};
    riskByServer[name] = PRESETS_BY_NAME[name]?.riskLevel || 'unknown';

    if (/@latest\b/i.test(argsStr) || /:latest(?:\s|$)/i.test(argsStr)) {
      issues.push(`[MCP Supply Chain] Server "${name}" uses floating "@latest"/":latest" tag; pin an exact semver version.`);
    }
    if (/@modelcontextprotocol\/server-postgres\b/i.test(argsStr)) {
      warnings.push(
        `[MCP Supply Chain] Server "${name}" references archived @modelcontextprotocol/server-postgres; migrate to @bytebase/dbhub --readonly and enforce a read-only PostgreSQL role.`
      );
    }
    if (/grafana/i.test(name) && !argsStr.includes('--disable-write')) {
      issues.push(`[MCP Safety] Server "${name}" in .mcp.json must include "--disable-write" flag for staging safety.`);
    }
    if (/redis/i.test(name) && !argsStr.includes('--readonly')) {
      warnings.push(`[MCP Safety] Server "${name}" should pass "--readonly" to prevent accidental cache flush/mutation.`);
    }

    for (const opFlag of ['ALLOW_INSERT_OPERATION', 'ALLOW_UPDATE_OPERATION', 'ALLOW_DELETE_OPERATION']) {
      if (String(env[opFlag] || '').toLowerCase() === 'true') {
        issues.push(`[MCP Safety] Server "${name}" sets ${opFlag}=true in .mcp.json; mutating DB MCP tools are blocked.`);
      }
    }

    for (const [k, v] of Object.entries(env)) {
      if (/(TOKEN|PASS|SECRET|KEY)/i.test(k) && v && !String(v).startsWith('${')) {
        issues.push(`[MCP Secret Hygiene] Server "${name}" hardcodes credential in .mcp.json env.${k}; use "\${${k}}" placeholder instead.`);
      }
    }

    if (/postgres(?:ql)?:\/\/[^:${]+:[^:@$]+@/i.test(argsStr) || /mysql:\/\/[^:${]+:[^:@$]+@/i.test(argsStr)) {
      issues.push(`[MCP Secret Hygiene] Server "${name}" embeds a plaintext DB password in .mcp.json args; use "\${...}" env placeholder.`);
    }

    if (cfg.description && PROMPT_POISONING_RE.test(String(cfg.description))) {
      issues.push(`[MCP Prompt-Poisoning Guard] Server "${name}" description contains prompt-injection pattern.`);
    }
  }

  if (codexTomlText) {
    if (/ALLOW_(?:INSERT|UPDATE|DELETE)_OPERATION\s*=\s*["']true["']/i.test(codexTomlText)) {
      issues.push('[MCP Safety] .codex/config.toml enables ALLOW_INSERT/UPDATE/DELETE_OPERATION=true.');
    }
    if (/\[mcp_servers\.[^\]]*grafana[^\]]*\][\s\S]{0,200}?args\s*=\s*\[(?![^\]]*--disable-write)/i.test(codexTomlText)) {
      issues.push('[MCP Safety] Grafana MCP entry in .codex/config.toml is missing "--disable-write".');
    }
    if (/@latest\b/i.test(codexTomlText) || /:latest(?:["'\s]|$)/i.test(codexTomlText)) {
      issues.push('[MCP Supply Chain] .codex/config.toml uses floating "@latest"/":latest" tag.');
    }
  }

  const lockCheck = auditMcpDescriptorsAndLock(servers, options.lockedHashes || null);
  issues.push(...lockCheck.issues);

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    checkedServers,
    riskByServer,
    descriptorHashes: lockCheck.hashes,
  };
}

/**
 * Pure read-only MCP Hub doctor evaluation for `<qaDir>`.
 * Handles malformed `.mcp.json` gracefully by returning a structured `fail` (`exitCode: 1`) result.
 * @param {string} qaDir
 * @param {{ ignoreLock?: boolean }} [options]
 */
export function runMcpDoctorReadOnly(qaDir, options = {}) {
  const mcpJsonPath = path.join(qaDir, '.mcp.json');
  const codexTomlPath = path.join(qaDir, '.codex', 'config.toml');
  const mcpLockPath = path.join(qaDir, '.aitest', 'mcp.lock');

  let mcpObj = { mcpServers: {} };
  if (fs.existsSync(mcpJsonPath)) {
    try {
      mcpObj = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    } catch (err) {
      return {
        ok: false,
        exitCode: 1,
        outcome: /** @type {const} */ ('fail'),
        error: `Malformed JSON in ${mcpJsonPath}: ${err instanceof Error ? err.message : String(err)}`,
        audit: null,
        mcpLockPath: fs.existsSync(mcpLockPath) ? mcpLockPath : null,
      };
    }
  }

  const tomlText = fs.existsSync(codexTomlPath) ? fs.readFileSync(codexTomlPath, 'utf8') : '';
  let lockedHashes = null;
  if (!options.ignoreLock && fs.existsSync(mcpLockPath)) {
    try {
      lockedHashes = JSON.parse(fs.readFileSync(mcpLockPath, 'utf8')).hashes || null;
    } catch {
      lockedHashes = null;
    }
  }

  const audit = auditMcpSafety(mcpObj, tomlText, { lockedHashes });
  return {
    ok: audit.ok,
    exitCode: audit.ok ? 0 : 2,
    outcome: /** @type {'pass' | 'blocked'} */ (audit.ok ? 'pass' : 'blocked'),
    error: null,
    audit,
    mcpLockPath: fs.existsSync(mcpLockPath) ? mcpLockPath : null,
  };
}
