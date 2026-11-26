// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';
import {
  auditMcpDescriptorsAndLock,
  auditMcpSafety,
  runMcpDoctorReadOnly,
} from './mcp-hub/auditor.mjs';
import {
  MCP_PILLARS,
  MCP_PRESETS,
  MCP_PROFILES,
  getMcpPresetsSummary,
} from './mcp-hub/catalog.mjs';

export {
  MCP_PILLARS,
  MCP_PRESETS,
  MCP_PROFILES,
  auditMcpDescriptorsAndLock,
  auditMcpSafety,
  getMcpPresetsSummary,
  runMcpDoctorReadOnly,
};

/**
 * @typedef {{
 *   pillar: string,
 *   description: string,
 *   command: string,
 *   args: string[],
 *   pinnedVersion: string,
 *   riskLevel: string,
 *   readonly: boolean,
 *   env?: Record<string, string>,
 *   envTemplate?: Record<string, string>,
 * }} McpPreset
 */

/** @type {Record<string, McpPreset>} */
const PRESETS_BY_NAME = MCP_PRESETS;
/** @type {Record<string, string[]>} */
const PROFILES_BY_NAME = MCP_PROFILES;

/** @param {McpPreset} preset */
function toMcpServerSpec(preset) {
  /** @type {Record<string, any>} */
  const entry = { command: preset.command, args: [...preset.args] };
  if (preset.env && Object.keys(preset.env).length > 0) {
    entry.env = { ...preset.env };
  }
  return entry;
}

/** @param {Record<string, any> | null | undefined} existingJsonObj @param {string[]} serverNames */
export function mergeMcpServersIntoJson(existingJsonObj, serverNames) {
  const base = existingJsonObj && typeof existingJsonObj === 'object' ? { ...existingJsonObj } : {};
  const existingServers = base.mcpServers && typeof base.mcpServers === 'object' ? { ...base.mcpServers } : {};
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const kept = [];

  for (const name of serverNames) {
    const preset = PRESETS_BY_NAME[name];
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

/** @param {unknown} val */
function escapeTomlStr(val) {
  return `"${String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** @param {string} name */
function formatTomlServerKey(name) {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : escapeTomlStr(name);
}

/** @param {string | null | undefined} existingTomlText @param {string[]} serverNames */
export function mergeMcpServersIntoCodexToml(existingTomlText, serverNames) {
  let content = String(existingTomlText || '');
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const kept = [];

  for (const name of serverNames) {
    const preset = PRESETS_BY_NAME[name];
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

/** @param {string[]} serverNames */
function buildMcpEnvTemplate(serverNames) {
  const lines = [
    '# Optional Read-Only Full-Link System MCP Credentials (NEVER commit real secrets to Git)',
    '# Copy needed entries into your shell environment or untracked .env before invoking Grafana/DB/Sentry MCPs.',
    '# Database Security Note: Always enforce read-only permissions at the PostgreSQL/MySQL database role level!',
    '',
  ];
  const seen = new Set();
  for (const name of serverNames) {
    const preset = PRESETS_BY_NAME[name];
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

/**
 * @param {{
 *   lang?: string,
 *   action?: string,
 *   json?: boolean,
 *   target?: string,
 *   qaDir?: string,
 *   lock?: boolean,
 *   servers?: string,
 *   profile?: string,
 *   dryRun?: boolean,
 *   force?: boolean,
 * }} [options]
 */
export async function runMcpCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const action = (options.action || 'presets').toLowerCase();
  const asJson = Boolean(options.json);

  /** @param {number} exitCode @param {string} msg */
  const failMcp = (exitCode, msg) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'mcp',
        outcome: exitCode === 64 ? 'usage' : exitCode === 2 ? 'blocked' : 'fail',
        ok: false,
        exitCode,
        blockerKind: exitCode === 64 ? 'USAGE_ERROR' : null,
        summary: msg,
        data: { action, error: msg },
      }),
      { asJson }
    );
  };

  if (action === 'presets') {
    const summary = getMcpPresetsSummary();
    if (!asJson) {
      console.log(
        lang === 'zh'
          ? '\n=== AI Test Workbench 7 大支柱全链路系统 MCP 预设清单 (已锁版本 & 风险分级) ==='
          : '\n=== AI Test Workbench 7-Pillar Full-Link MCP Presets (Pinned & Risk-Graded) ==='
      );
      for (const [name, p] of Object.entries(MCP_PRESETS)) {
        console.log(`  [${p.pillar.padEnd(13)} | ${p.riskLevel.padEnd(13)}] ${name.padEnd(18)} — ${p.description}`);
      }
      console.log(`\nProfiles: ${Object.keys(MCP_PROFILES).join(', ')}`);
    }
    return emitCommandResult(
      buildCommandResult({
        tool: 'mcp',
        outcome: 'pass',
        ok: true,
        exitCode: 0,
        summary: `Listed ${Object.keys(MCP_PRESETS).length} pinned MCP presets`,
        data: summary,
      }),
      { asJson }
    );
  }

  if (!options.target) {
    return failMcp(64, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    return failMcp(1, lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
  }

  const mcpJsonPath = path.join(qaDir, '.mcp.json');
  const codexTomlPath = path.join(qaDir, '.codex', 'config.toml');
  const mcpLockPath = path.join(qaDir, '.aitest', 'mcp.lock');

  if (action === 'doctor') {
    const doctorRes = runMcpDoctorReadOnly(qaDir, { ignoreLock: Boolean(options.lock) });
    if (doctorRes.error || !doctorRes.audit) {
      return failMcp(1, doctorRes.error || 'Failed to parse .mcp.json');
    }
    const audit = doctorRes.audit;

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

    const exitCode = audit.ok ? 0 : 2;
    if (!options.json) {
      console.log(
        lang === 'zh'
          ? `\n[MCP Doctor] 已审计 ${audit.checkedServers.length} 个 MCP 服务配置 (.mcp.json + .codex/config.toml)`
          : `\n[MCP Doctor] Audited ${audit.checkedServers.length} MCP server(s) in .mcp.json + .codex/config.toml`
      );
      for (const w of audit.warnings) console.warn(`  [WARN] ${w}`);
      for (const iss of audit.issues) console.error(`  [FAIL] ${iss}`);
      if (audit.ok) console.log('  [OK] All MCP configurations enforce supply-chain, read-only & secret hygiene guardrails.');
    }
    return emitCommandResult(
      buildCommandResult({
        tool: 'mcp',
        outcome: audit.ok ? 'pass' : 'blocked',
        ok: audit.ok,
        exitCode,
        summary: audit.ok
          ? `MCP doctor audited ${audit.checkedServers.length} server(s): OK`
          : audit.issues[0] || `MCP doctor blocked (${audit.issues.length} issue(s))`,
        data: { ...audit, mcpLockPath: fs.existsSync(mcpLockPath) ? mcpLockPath : null },
      }),
      { asJson: Boolean(options.json) }
    );
  }

  if (action === 'add') {
    /** @type {string[]} */
    let selected = [];
    if (options.servers) {
      selected = String(options.servers)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      const profileName = (options.profile || 'full-link').toLowerCase();
      if (!PROFILES_BY_NAME[profileName]) {
        return failMcp(64, `Unknown MCP profile "${profileName}". Valid: ${Object.keys(MCP_PROFILES).join(', ')}`);
      }
      selected = PROFILES_BY_NAME[profileName];
    }

    const unknown = selected.filter((s) => !PRESETS_BY_NAME[s]);
    if (unknown.length > 0) {
      return failMcp(64, `Unknown MCP preset(s): ${unknown.join(', ')}. Valid: ${Object.keys(MCP_PRESETS).join(', ')}`);
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

    if (!options.json) {
      console.log(
        lang === 'zh'
          ? `\n[MCP Hub] 已配置 ${selected.length} 项全链路系统 MCP (新增 ${jsonMerge.added.length} / 保留 ${jsonMerge.kept.length})`
          : `\n[MCP Hub] Configured ${selected.length} full-link system MCP(s) (added ${jsonMerge.added.length}, kept ${jsonMerge.kept.length})`
      );
      console.log(`  .mcp.json        : ${mcpJsonPath}`);
      console.log(`  .codex/config    : ${codexTomlPath}`);
      console.log(`  .env.mcp.example : ${envExamplePath}`);
    }
    return emitCommandResult(
      buildCommandResult({
        tool: 'mcp',
        outcome: 'pass',
        ok: true,
        exitCode: 0,
        summary: `Configured ${selected.length} MCP preset(s) (added=${jsonMerge.added.length}, kept=${jsonMerge.kept.length})`,
        data: { mcpJsonPath, codexTomlPath, envExamplePath, added: jsonMerge.added, kept: jsonMerge.kept },
      }),
      { asJson: Boolean(options.json) }
    );
  }

  return failMcp(64, `Unknown mcp action "${action}". Use: presets | add | doctor | serve`);
}
