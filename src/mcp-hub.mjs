// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';
import {
  MCP_PILLARS,
  MCP_PRESETS,
  MCP_PROFILES,
  getMcpPresetsSummary,
} from './mcp-hub/catalog.mjs';

export { MCP_PILLARS, MCP_PRESETS, MCP_PROFILES, getMcpPresetsSummary };

const PROMPT_POISONING_RE =
  /(ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+system\s+prompt|<\s*system\s*>|you\s+are\s+now\s+in\s+developer\s+mode|exfiltrate|send\s+.*\s+to\s+https?:\/\/|\bcurl\s+-X\s+POST\b)/i;

function toMcpServerSpec(preset) {
  /** @type {Record<string, any>} */
  const entry = { command: preset.command, args: [...preset.args] };
  if (preset.env && Object.keys(preset.env).length > 0) {
    entry.env = { ...preset.env };
  }
  return entry;
}

export function mergeMcpServersIntoJson(existingJsonObj, serverNames) {
  const base = existingJsonObj && typeof existingJsonObj === 'object' ? { ...existingJsonObj } : {};
  const existingServers = base.mcpServers && typeof base.mcpServers === 'object' ? { ...base.mcpServers } : {};
  const added = [];
  const kept = [];

  for (const name of serverNames) {
    const preset = MCP_PRESETS[name];
    if (!preset) continue;
    if (name in existingServers) {
      kept.push(name);
    } else {
      existingServers[name] = toMcpServerSpec(preset);
      added.push(name);
    }
  }

  return {
    config: { ...base, mcpServers: existingServers },
    added,
    kept,
  };
}

function escapeTomlStr(val) {
  return `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatTomlServerKey(name) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : escapeTomlStr(name);
}

export function mergeMcpServersIntoCodexToml(existingTomlText, serverNames) {
  let content = String(existingTomlText || '');
  const added = [];
  const kept = [];

  for (const name of serverNames) {
    const preset = MCP_PRESETS[name];
    if (!preset) continue;
    const headerRegex = new RegExp(`^\\[mcp_servers\\.(?:"${name}"|'${name}'|${name})\\]`, 'm');
    if (headerRegex.test(content)) {
      kept.push(name);
      continue;
    }

    const key = formatTomlServerKey(name);
    const argsList = preset.args.map(escapeTomlStr).join(', ');
    const lines = [
      '',
      `# [AI Test Workbench] ${preset.pillar} (risk=${preset.riskLevel}): ${preset.description}`,
      `[mcp_servers.${key}]`,
      `command = ${escapeTomlStr(preset.command)}`,
      `args = [${argsList}]`,
    ];
    if (preset.env && Object.keys(preset.env).length > 0) {
      lines.push(`[mcp_servers.${key}.env]`);
      for (const [envKey, envVal] of Object.entries(preset.env)) {
        lines.push(`${envKey} = ${escapeTomlStr(envVal)}`);
      }
    }
    content = `${content.trimEnd()}\n${lines.join('\n')}\n`;
    added.push(name);
  }

  return { content, added, kept };
}

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
    riskByServer[name] = MCP_PRESETS[name]?.riskLevel || 'unknown';

    if (/@latest\b/i.test(argsStr)) {
      issues.push(`[MCP Supply Chain] Server "${name}" uses floating "@latest" tag; pin an exact semver version.`);
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
    if (/@latest\b/i.test(codexTomlText)) {
      issues.push('[MCP Supply Chain] .codex/config.toml uses floating "@latest" tag.');
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

function buildMcpEnvTemplate(serverNames) {
  const lines = [
    '# Optional Read-Only Full-Link System MCP Credentials (NEVER commit real secrets to Git)',
    '# Copy needed entries into your shell environment or untracked .env before invoking Grafana/DB/Sentry MCPs.',
    '# Database Security Note: Always enforce read-only permissions at the PostgreSQL/MySQL database role level!',
    '',
  ];
  const seen = new Set();
  for (const name of serverNames) {
    const preset = MCP_PRESETS[name];
    if (!preset?.envTemplate) continue;
    for (const [k, v] of Object.entries(preset.envTemplate)) {
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(`# ${name} (${preset.pillar} · risk=${preset.riskLevel})`);
      lines.push(`${k}=${v}`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function runMcpCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const action = (options.action || 'presets').toLowerCase();

  if (action === 'presets') {
    const summary = getMcpPresetsSummary();
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    console.log(
      lang === 'zh'
        ? '\n=== AI Test Workbench 7 大支柱全链路系统 MCP 预设清单 (已锁版本 & 风险分级) ==='
        : '\n=== AI Test Workbench 7-Pillar Full-Link MCP Presets (Pinned & Risk-Graded) ==='
    );
    for (const [name, p] of Object.entries(MCP_PRESETS)) {
      console.log(`  [${p.pillar.padEnd(13)} | ${p.riskLevel.padEnd(13)}] ${name.padEnd(18)} — ${p.description}`);
    }
    console.log(`\nProfiles: ${Object.keys(MCP_PROFILES).join(', ')}`);
    return 0;
  }

  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
    return 1;
  }

  const mcpJsonPath = path.join(qaDir, '.mcp.json');
  const codexTomlPath = path.join(qaDir, '.codex', 'config.toml');
  const mcpLockPath = path.join(qaDir, '.aitest', 'mcp.lock');

  if (action === 'doctor') {
    const mcpObj = fs.existsSync(mcpJsonPath) ? JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) : { mcpServers: {} };
    const tomlText = fs.existsSync(codexTomlPath) ? fs.readFileSync(codexTomlPath, 'utf8') : '';
    let lockedHashes = null;
    if (!options.lock && fs.existsSync(mcpLockPath)) {
      try {
        lockedHashes = JSON.parse(fs.readFileSync(mcpLockPath, 'utf8')).hashes || null;
      } catch {
        lockedHashes = null;
      }
    }

    const audit = auditMcpSafety(mcpObj, tomlText, { lockedHashes });

    if (options.lock && audit.ok) {
      fs.mkdirSync(path.dirname(mcpLockPath), { recursive: true });
      fs.writeFileSync(
        mcpLockPath,
        JSON.stringify(
          {
            schemaVersion: SCHEMA_VERSIONS.mcpLock,
            lockedAt: new Date().toISOString(),
            hashes: audit.descriptorHashes,
          },
          null,
          2
        ) + '\n',
        'utf8'
      );
    }

    if (options.json) {
      console.log(JSON.stringify({ ...audit, mcpLockPath: fs.existsSync(mcpLockPath) ? mcpLockPath : null }, null, 2));
    } else {
      console.log(
        lang === 'zh'
          ? `\n[MCP Doctor] 已审计 ${audit.checkedServers.length} 个 MCP 服务配置 (.mcp.json + .codex/config.toml)`
          : `\n[MCP Doctor] Audited ${audit.checkedServers.length} MCP server(s) in .mcp.json + .codex/config.toml`
      );
      for (const w of audit.warnings) console.warn(`  [WARN] ${w}`);
      for (const iss of audit.issues) console.error(`  [FAIL] ${iss}`);
      if (audit.ok) console.log('  [OK] All MCP configurations enforce supply-chain, read-only & secret hygiene guardrails.');
    }
    return audit.ok ? 0 : 2;
  }

  if (action === 'add') {
    let selected = [];
    if (options.servers) {
      selected = String(options.servers)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      const profileName = (options.profile || 'full-link').toLowerCase();
      if (!MCP_PROFILES[profileName]) {
        console.error(`Unknown MCP profile "${profileName}". Valid: ${Object.keys(MCP_PROFILES).join(', ')}`);
        return 1;
      }
      selected = MCP_PROFILES[profileName];
    }

    const unknown = selected.filter((s) => !MCP_PRESETS[s]);
    if (unknown.length > 0) {
      console.error(`Unknown MCP preset(s): ${unknown.join(', ')}. Valid: ${Object.keys(MCP_PRESETS).join(', ')}`);
      return 1;
    }

    const curJson = fs.existsSync(mcpJsonPath) ? JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')) : {};
    const jsonMerge = mergeMcpServersIntoJson(curJson, selected);
    const curToml = fs.existsSync(codexTomlPath) ? fs.readFileSync(codexTomlPath, 'utf8') : '';
    const tomlMerge = mergeMcpServersIntoCodexToml(curToml, selected);
    const envExamplePath = path.join(qaDir, '.env.mcp.example');

    if (!options.dryRun) {
      fs.writeFileSync(mcpJsonPath, JSON.stringify(jsonMerge.config, null, 2) + '\n', 'utf8');
      fs.mkdirSync(path.dirname(codexTomlPath), { recursive: true });
      fs.writeFileSync(codexTomlPath, tomlMerge.content, 'utf8');
      fs.writeFileSync(envExamplePath, buildMcpEnvTemplate(selected), 'utf8');
    }

    if (options.json) {
      console.log(JSON.stringify({ mcpJsonPath, codexTomlPath, envExamplePath, added: jsonMerge.added, kept: jsonMerge.kept }, null, 2));
    } else {
      console.log(
        lang === 'zh'
          ? `\n[MCP Hub] 已配置 ${selected.length} 项全链路系统 MCP (新增 ${jsonMerge.added.length} / 保留 ${jsonMerge.kept.length})`
          : `\n[MCP Hub] Configured ${selected.length} full-link system MCP(s) (added ${jsonMerge.added.length}, kept ${jsonMerge.kept.length})`
      );
      console.log(`  .mcp.json        : ${mcpJsonPath}`);
      console.log(`  .codex/config    : ${codexTomlPath}`);
      console.log(`  .env.mcp.example : ${envExamplePath}`);
    }
    return 0;
  }

  console.error(`Unknown mcp action "${action}". Use: presets | add | doctor | serve`);
  return 1;
}
