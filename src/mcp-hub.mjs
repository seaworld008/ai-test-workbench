// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { SCHEMA_VERSIONS, WORKBENCH_VERSION } from './version.mjs';

export const MCP_PILLARS = [
  'orchestrator',
  'browser',
  'observability',
  'database',
  'middleware',
  'performance',
  'api-contract',
];

/**
 * 7-Pillar System MCP Presets with Supply-Chain Version Pinning (`S-06`) and
 * 3-Tier Risk Classification (`riskLevel: 'read' | 'local-write' | 'remote-effect'`, `S-07`).
 */
export const MCP_PRESETS = {
  'ai-test-workbench': {
    pillar: 'orchestrator',
    description: 'AI Test Workbench native MCP Server (stdio/Streamable HTTP/SSE tools, Living Code Map & QA gates)',
    command: 'npx',
    args: [`--package=ai-test-workbench@${WORKBENCH_VERSION}`, 'ai-test-workbench', 'mcp-serve'],
    pinnedVersion: WORKBENCH_VERSION,
    riskLevel: 'local-write',
    readonly: true,
    envTemplate: {},
  },
  'playwright-test': {
    pillar: 'browser',
    description: 'Playwright built-in Test Agents MCP server (Planner / Generator / Healer)',
    command: 'npx',
    args: ['playwright@1.65.1', 'run-test-mcp-server'],
    pinnedVersion: '1.65.1',
    riskLevel: 'local-write',
    readonly: false,
    envTemplate: {},
  },
  'chrome-devtools': {
    pillar: 'browser',
    description: 'Chrome DevTools Protocol live DOM, console, network & performance trace inspection',
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@0.18.0'],
    pinnedVersion: '0.18.0',
    riskLevel: 'local-write',
    readonly: false,
    envTemplate: {},
  },
  grafana: {
    pillar: 'observability',
    description: 'Read-only Grafana dashboards, alerts & correlated Prometheus/Loki datasource queries',
    command: 'uvx',
    args: ['mcp-grafana==0.7.8', '--disable-write'],
    pinnedVersion: '0.7.8',
    riskLevel: 'read',
    readonly: true,
    env: {
      GRAFANA_URL: '${GRAFANA_URL}',
      GRAFANA_SERVICE_ACCOUNT_TOKEN: '${GRAFANA_SERVICE_ACCOUNT_TOKEN}',
    },
    envTemplate: {
      GRAFANA_URL: 'https://grafana.staging.internal',
      GRAFANA_SERVICE_ACCOUNT_TOKEN: 'glsa_replace_with_readonly_viewer_token',
    },
  },
  prometheus: {
    pillar: 'observability',
    description: 'Read-only PromQL metrics queries (latency P95/P99, CPU, DB pool saturation, 5xx rates)',
    command: 'uvx',
    args: ['prometheus-mcp-server==1.4.2'],
    pinnedVersion: '1.4.2',
    riskLevel: 'read',
    readonly: true,
    env: {
      PROMETHEUS_URL: '${PROMETHEUS_URL}',
    },
    envTemplate: {
      PROMETHEUS_URL: 'https://prometheus.staging.internal',
    },
  },
  loki: {
    pillar: 'observability',
    description: 'Read-only LogQL microservice log search correlated by traceId & test time window',
    command: 'uvx',
    args: ['loki-mcp-server==0.3.1'],
    pinnedVersion: '0.3.1',
    riskLevel: 'read',
    readonly: true,
    env: {
      LOKI_URL: '${LOKI_URL}',
    },
    envTemplate: {
      LOKI_URL: 'https://loki.staging.internal',
    },
  },
  sentry: {
    pillar: 'observability',
    description: 'Sentry exception stack traces, breadcrumbs, and frontend/backend issue correlation',
    command: 'npx',
    args: ['-y', '@sentry/mcp-server@0.29.0'],
    pinnedVersion: '0.29.0',
    riskLevel: 'read',
    readonly: true,
    env: {
      SENTRY_ACCESS_TOKEN: '${SENTRY_ACCESS_TOKEN}',
      SENTRY_HOST: '${SENTRY_HOST}',
    },
    envTemplate: {
      SENTRY_HOST: 'https://sentry.staging.internal',
      SENTRY_ACCESS_TOKEN: 'sntrys_replace_with_read_scoped_token',
    },
  },
  'postgres-readonly': {
    pillar: 'database',
    description:
      'PostgreSQL read-only SQL verification via maintained DBHub (--readonly; MUST also enforce read-only DB role)',
    command: 'npx',
    args: ['-y', '@bytebase/dbhub@0.15.0', '--readonly', '--dsn', '${POSTGRES_READONLY_URL}'],
    pinnedVersion: '0.15.0',
    riskLevel: 'read',
    readonly: true,
    envTemplate: {
      POSTGRES_READONLY_URL: 'postgresql://qa_readonly:change_me@staging-db.internal:5432/app_staging',
    },
  },
  'mysql-readonly': {
    pillar: 'database',
    description:
      'MySQL read-only inspection (INSERT/UPDATE/DELETE disabled; MUST also enforce SELECT-only DB user)',
    command: 'npx',
    args: ['-y', '@benborla29/mcp-server-mysql@1.0.41'],
    pinnedVersion: '1.0.41',
    riskLevel: 'read',
    readonly: true,
    env: {
      MYSQL_HOST: '${MYSQL_HOST}',
      MYSQL_PORT: '${MYSQL_PORT}',
      MYSQL_USER: '${MYSQL_READONLY_USER}',
      MYSQL_PASS: '${MYSQL_READONLY_PASS}',
      MYSQL_DB: '${MYSQL_DB}',
      ALLOW_INSERT_OPERATION: 'false',
      ALLOW_UPDATE_OPERATION: 'false',
      ALLOW_DELETE_OPERATION: 'false',
    },
    envTemplate: {
      MYSQL_HOST: 'staging-mysql.internal',
      MYSQL_PORT: '3306',
      MYSQL_READONLY_USER: 'qa_readonly',
      MYSQL_READONLY_PASS: 'change_me',
      MYSQL_DB: 'app_staging',
    },
  },
  'redis-readonly': {
    pillar: 'middleware',
    description: 'Redis read-only cache, session & queue key inspection (--readonly enforced)',
    command: 'uvx',
    args: ['redis-mcp-server==0.3.0', '--readonly'],
    pinnedVersion: '0.3.0',
    riskLevel: 'read',
    readonly: true,
    env: {
      REDIS_URL: '${REDIS_READONLY_URL}',
    },
    envTemplate: {
      REDIS_READONLY_URL: 'redis://:change_me@staging-redis.internal:6379/0',
    },
  },
  k6: {
    pillar: 'performance',
    description: 'Grafana k6 load, stress & soak script execution (remote-effect load generator: staging only)',
    command: 'uvx',
    args: ['mcp-k6==0.4.0'],
    pinnedVersion: '0.4.0',
    riskLevel: 'remote-effect',
    readonly: false,
    envTemplate: {
      K6_PROMETHEUS_RW_SERVER_URL: 'https://prometheus.staging.internal/api/v1/write',
    },
  },
  'openapi-contract': {
    pillar: 'api-contract',
    description: 'OpenAPI / Swagger live schema reader for automated contract drift detection',
    command: 'npx',
    args: ['-y', 'openapi-mcp-server@1.2.0', '${OPENAPI_SPEC_URL}'],
    pinnedVersion: '1.2.0',
    riskLevel: 'read',
    readonly: true,
    envTemplate: {
      OPENAPI_SPEC_URL: 'https://staging-api.internal/v3/api-docs',
    },
  },
};

export const MCP_PROFILES = {
  minimal: ['ai-test-workbench', 'playwright-test', 'chrome-devtools'],
  observability: ['ai-test-workbench', 'playwright-test', 'grafana', 'prometheus', 'loki', 'sentry'],
  'data-verify': ['ai-test-workbench', 'playwright-test', 'postgres-readonly', 'mysql-readonly', 'redis-readonly'],
  perf: ['ai-test-workbench', 'playwright-test', 'chrome-devtools', 'prometheus', 'k6'],
  'full-link': Object.keys(MCP_PRESETS),
};

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

  if (action === 'serve') {
    const { runMcpServeCommand } = await import('./mcp-server.mjs');
    return await runMcpServeCommand(options);
  }

  if (action === 'presets') {
    const summary = {
      pillars: MCP_PILLARS,
      profiles: MCP_PROFILES,
      presets: Object.fromEntries(
        Object.entries(MCP_PRESETS).map(([k, v]) => [
          k,
          {
            pillar: v.pillar,
            riskLevel: v.riskLevel,
            pinnedVersion: v.pinnedVersion,
            readonly: v.readonly,
            command: v.command,
            args: v.args,
            description: v.description,
          },
        ])
      ),
    };
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

  console.error(`Unknown mcp action "${action}". Use: presets | add | doctor`);
  return 1;
}
