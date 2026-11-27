// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInstalledEngineBinary } from '../codemap/providers/engine-installer.mjs';
import {
  DEFAULT_GRAPH_ENGINE_ID,
  resolveIsolatedEngineDirs,
  resolvePlatformAsset,
} from '../codemap/providers/engine-manifest.mjs';
import { loadAndValidateAitestConfigFile } from '../core/config.mjs';
import { WORKBENCH_VERSION } from '../core/version.mjs';
import { MCP_PRESETS } from './catalog.mjs';

/** @type {Record<string, { riskLevel: string, pinnedVersion?: string, nativeBinary?: boolean }>} */
const PRESETS_BY_NAME = MCP_PRESETS;

export const PROMPT_POISONING_RE =
  /(ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+system\s+prompt|<\s*system\s*>|you\s+are\s+now\s+in\s+developer\s+mode|exfiltrate|send\s+.*\s+to\s+https?:\/\/|\bcurl\s+-X\s+POST\b)/i;

const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\u202A-\u202E\u2066-\u2069]/g;
const FORBIDDEN_SIDECAR_SUBCOMMAND_RE = /^(?:update|self-update|upgrade|install|uninstall|--update|--self-update|--install)$/i;
const FLOATING_VERSION_RE = /^(?:latest|\*|main|master|nightly|canary)$/i;

/**
 * Inspects and sanitizes untrusted code/graph metadata (symbol names, paths, annotations, MCP descriptions).
 * Neutralizes triple+ backticks, strips ANSI/control/bidi chars, and redacts/flags `PROMPT_POISONING_RE` payloads.
 * Reusable by CodeMap v5 normalizer and MCP Hub auditing.
 * @param {unknown} text
 * @returns {{ sanitized: string, flagged: boolean, reasons: string[] }}
 */
export function inspectUntrustedCodeMetadata(text) {
  const raw = String(text ?? '');
  /** @type {string[]} */
  const reasons = [];
  let out = raw.replace(/\r\n/g, '\n');

  if (ANSI_ESCAPE_RE.test(out) || CONTROL_CHARS_RE.test(out)) {
    reasons.push('control_chars_stripped');
  }
  out = out.replace(ANSI_ESCAPE_RE, '').replace(CONTROL_CHARS_RE, '');

  if (/`{3,}/.test(out)) {
    reasons.push('triple_backticks_neutralized');
    out = out.replace(/`{3,}/g, "'''");
  }

  if (PROMPT_POISONING_RE.test(out)) {
    reasons.push('prompt_poisoning_redacted');
    const globalPoisonRe = new RegExp(PROMPT_POISONING_RE.source, 'gi');
    out = out.replace(globalPoisonRe, '[REDACTED_PROMPT_INJECTION]');
  }

  return { sanitized: out, flagged: reasons.length > 0, reasons };
}

/**
 * Sanitizes untrusted code/graph metadata into a safe plain string (neutralizes triple backticks,
 * strips control/ANSI/bidi characters, and redacts prompt-poisoning payloads).
 * @param {unknown} text
 * @returns {string}
 */
export function sanitizeUntrustedCodeMetadata(text) {
  return inspectUntrustedCodeMetadata(text).sanitized;
}

/** @param {unknown} val @returns {string} */
function normalizeSha256Hex(val) {
  if (typeof val !== 'string') return '';
  const hex = val.trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : '';
}

/** @param {string} filePath @returns {string} */
function computeFileSha256Hex(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return '';
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return '';
  }
}

/**
 * @param {string} name
 * @param {Record<string, any>} cfg
 * @returns {boolean}
 */
function isNativeSidecarServer(name, cfg) {
  if (PRESETS_BY_NAME[name]?.nativeBinary) return true;
  if (/codebase-memory-mcp/i.test(name)) return true;
  return /(?:^|[/\\_-])codebase-memory-mcp(?:\.exe)?$/i.test(String(cfg?.command || '').trim());
}

/**
 * Validates native local sidecar binary MCP servers (e.g. `codebase-memory-mcp`) for UI surface,
 * forbidden update/install subcommands, pinned version, and binary SHA-256 / strictChecksum integrity.
 * @param {string} name
 * @param {Record<string, any>} cfg
 * @param {{ codeMapConfig?: import('../core/config-schema.mjs').CodeMapConfig | null, engineManifest?: Record<string, any> | null }} options
 * @param {string[]} issues
 * @param {string[]} warnings
 */
function auditNativeSidecarServer(name, cfg, options, issues, warnings) {
  const argsArr = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : [];
  let hasUiDisabled = false;
  let hasUiEnabled = false;
  for (let i = 0; i < argsArr.length; i += 1) {
    const arg = argsArr[i].trim();
    if (/^--?ui=(?:true|1|yes|on)$/i.test(arg)) hasUiEnabled = true;
    else if (/^--?ui=(?:false|0|no|off)$/i.test(arg)) hasUiDisabled = true;
    else if (/^--?ui$/i.test(arg)) {
      if (/^(?:false|0|no|off)$/i.test((argsArr[i + 1] || '').trim())) hasUiDisabled = true;
      else hasUiEnabled = true;
    }
    if (FORBIDDEN_SIDECAR_SUBCOMMAND_RE.test(arg)) {
      issues.push(`[MCP Supply Chain] Native sidecar "${name}" invokes forbidden mutating subcommand "${arg}" in args; binary update/install must never run via MCP.`);
    }
  }
  if (hasUiEnabled) {
    issues.push(`[MCP Native Sidecar Safety] Server "${name}" enables interactive web UI (--ui=true); native graph sidecar must pass "--ui=false".`);
  } else if (!hasUiDisabled) {
    warnings.push(`[MCP Native Sidecar Safety] Server "${name}" should explicitly pass "--ui=false" to disable the embedded HTTP UI.`);
  }

  const extCfg = options.codeMapConfig?.externalEngine || null;
  const manifest = options.engineManifest || null;
  const pinnedVersion = String(cfg.pinnedVersion ?? PRESETS_BY_NAME[name]?.pinnedVersion ?? extCfg?.pinnedVersion ?? manifest?.pinnedVersion ?? '').trim();
  if (!pinnedVersion || FLOATING_VERSION_RE.test(pinnedVersion)) {
    issues.push(`[MCP Supply Chain] Native sidecar "${name}" is missing an exact pinned version (found "${pinnedVersion || 'none'}").`);
  } else if (manifest?.installedVersion && String(manifest.installedVersion).trim() !== pinnedVersion) {
    issues.push(`[MCP Supply Chain] Native sidecar "${name}" installedVersion (${manifest.installedVersion}) does not match pinnedVersion (${pinnedVersion}).`);
  }

  const rawExpectedSha = cfg.binarySha256 ?? extCfg?.binarySha256;
  const expectedSha = normalizeSha256Hex(rawExpectedSha);
  const strictChecksum = Boolean(cfg.strictChecksum || extCfg?.strictChecksum);
  const manifestSha = normalizeSha256Hex(manifest?.binarySha256);
  const candidateBinPath =
    (typeof manifest?.binaryPath === 'string' && manifest.binaryPath.trim()) ||
    (typeof extCfg?.binaryPath === 'string' && extCfg.binaryPath.trim()) ||
    (typeof cfg.command === 'string' && path.isAbsolute(cfg.command) ? cfg.command : '');
  const onDiskSha = candidateBinPath ? computeFileSha256Hex(candidateBinPath) : '';

  if (rawExpectedSha !== undefined && rawExpectedSha !== null && rawExpectedSha !== '' && !expectedSha) {
    issues.push(`[MCP Supply Chain] Native sidecar "${name}" configures malformed binarySha256.`);
  } else if (strictChecksum && !expectedSha) {
    issues.push(`[MCP Supply Chain] Native sidecar "${name}" enables strictChecksum without configuring binarySha256.`);
  } else if (expectedSha) {
    if (onDiskSha && onDiskSha !== expectedSha) {
      issues.push(`[MCP Supply Chain] Native sidecar "${name}" on-disk binary SHA-256 mismatch (${onDiskSha.slice(0, 12)} != ${expectedSha.slice(0, 12)}).`);
    } else if (!onDiskSha && manifestSha && manifestSha !== expectedSha) {
      issues.push(`[MCP Supply Chain] Native sidecar "${name}" manifest binarySha256 mismatch (${manifestSha.slice(0, 12)} != ${expectedSha.slice(0, 12)}).`);
    } else if (!onDiskSha && manifestSha && strictChecksum) {
      issues.push(`[MCP Supply Chain] Native sidecar "${name}" strictChecksum requires an existing verifiable on-disk binary.`);
    } else if (!onDiskSha && !manifestSha) {
      issues.push(`[MCP Supply Chain] Native sidecar "${name}" binary SHA-256 is unverified (no verified binary or .aitest/engine-manifest.json matching binarySha256).`);
    }
  } else if (onDiskSha && manifestSha && onDiskSha !== manifestSha) {
    issues.push(`[MCP Supply Chain] Native sidecar "${name}" on-disk binary SHA-256 drifted from .aitest/engine-manifest.json (${onDiskSha.slice(0, 12)} != ${manifestSha.slice(0, 12)}).`);
  }
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
    const digest = `sha256:${crypto.createHash('sha256').update(JSON.stringify({ command: spec?.command || null, args: spec?.args || [], description: desc })).digest('hex')}`;
    computedHashes[name] = digest;
    if (PROMPT_POISONING_RE.test(desc)) issues.push(`[MCP Prompt-Poisoning Guard] Server/tool "${name}" contains suspicious prompt-injection instructions.`);
    if (lockedHashes && name in lockedHashes && lockedHashes[name] !== digest) {
      issues.push(`[MCP Lock Drift] Server/tool "${name}" descriptor hash drifted from .aitest/mcp.lock (${digest.slice(0, 19)} != ${String(lockedHashes[name]).slice(0, 19)}).`);
    }
  }
  if (lockedHashes) {
    for (const lockedName of Object.keys(lockedHashes)) {
      if (!(lockedName in computedHashes)) issues.push(`[MCP Lock Drift] Locked MCP entry "${lockedName}" was removed without updating .aitest/mcp.lock.`);
    }
  }
  return { ok: issues.length === 0, issues, hashes: computedHashes };
}

/**
 * Audits `.mcp.json` and `.codex/config.toml` for write flags, `@latest` unpinned tags, archived packages,
 * native sidecar guardrails (`--ui=false`, SHA-256, update/install bans), hardcoded secrets, and `.aitest/mcp.lock` drift.
 * @param {{ mcpServers?: Record<string, Record<string, any>> } | null | undefined} mcpJsonObj
 * @param {string} [codexTomlText]
 * @param {{
 *   lockedHashes?: Record<string, string> | null,
 *   codeMapConfig?: import('../core/config-schema.mjs').CodeMapConfig | null,
 *   engineManifest?: Record<string, any> | null,
 * }} [options]
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

    if (/@latest\b/i.test(argsStr) || /:latest(?:\s|$)/i.test(argsStr)) issues.push(`[MCP Supply Chain] Server "${name}" uses floating "@latest"/":latest" tag; pin an exact semver version.`);
    if (/@modelcontextprotocol\/server-postgres\b/i.test(argsStr)) warnings.push(`[MCP Supply Chain] Server "${name}" references archived @modelcontextprotocol/server-postgres; migrate to @bytebase/dbhub --readonly and enforce a read-only PostgreSQL role.`);
    if (/grafana/i.test(name) && !argsStr.includes('--disable-write')) issues.push(`[MCP Safety] Server "${name}" in .mcp.json must include "--disable-write" flag for staging safety.`);
    if (/redis/i.test(name) && !argsStr.includes('--readonly')) warnings.push(`[MCP Safety] Server "${name}" should pass "--readonly" to prevent accidental cache flush/mutation.`);
    if (/gitlab/i.test(name) && String(env.GITLAB_READ_ONLY_MODE || '').toLowerCase() === 'false') {
      issues.push(`[MCP Safety] Server "${name}" sets GITLAB_READ_ONLY_MODE=false; mutating GitLab MCP tools are blocked.`);
    } else if (/gitlab/i.test(name) && String(env.GITLAB_READ_ONLY_MODE || '').toLowerCase() !== 'true') {
      warnings.push(`[MCP Safety] Server "${name}" should set GITLAB_READ_ONLY_MODE=true for read-only safety.`);
    }
    if (/skywalking|victorialogs/i.test(name) && /(?:^|\s)--(?:allow-)?write\b/i.test(argsStr)) issues.push(`[MCP Safety] Server "${name}" enables write flags on observability MCP.`);
    for (const opFlag of ['ALLOW_INSERT_OPERATION', 'ALLOW_UPDATE_OPERATION', 'ALLOW_DELETE_OPERATION']) {
      if (String(env[opFlag] || '').toLowerCase() === 'true') issues.push(`[MCP Safety] Server "${name}" sets ${opFlag}=true in .mcp.json; mutating DB MCP tools are blocked.`);
    }
    for (const [k, v] of Object.entries(env)) {
      if (/(TOKEN|PASS|SECRET|KEY)/i.test(k) && v && !String(v).startsWith('${')) issues.push(`[MCP Secret Hygiene] Server "${name}" hardcodes credential in .mcp.json env.${k}; use "\${${k}}" placeholder instead.`);
    }
    if (/postgres(?:ql)?:\/\/[^:${]+:[^:@$]+@/i.test(argsStr) || /mysql:\/\/[^:${]+:[^:@$]+@/i.test(argsStr)) {
      issues.push(`[MCP Secret Hygiene] Server "${name}" embeds a plaintext DB password in .mcp.json args; use "\${...}" env placeholder.`);
    }
    if (cfg.description && PROMPT_POISONING_RE.test(String(cfg.description))) issues.push(`[MCP Prompt-Poisoning Guard] Server "${name}" description contains prompt-injection pattern.`);
    if (isNativeSidecarServer(name, cfg)) auditNativeSidecarServer(name, cfg, options, issues, warnings);
  }

  if (codexTomlText) {
    if (/ALLOW_(?:INSERT|UPDATE|DELETE)_OPERATION\s*=\s*["']true["']/i.test(codexTomlText)) issues.push('[MCP Safety] .codex/config.toml enables ALLOW_INSERT/UPDATE/DELETE_OPERATION=true.');
    if (/\[mcp_servers\.[^\]]*grafana[^\]]*\][\s\S]{0,200}?args\s*=\s*\[(?![^\]]*--disable-write)/i.test(codexTomlText)) issues.push('[MCP Safety] Grafana MCP entry in .codex/config.toml is missing "--disable-write".');
    if (/@latest\b/i.test(codexTomlText) || /:latest(?:["'\s]|$)/i.test(codexTomlText)) issues.push('[MCP Supply Chain] .codex/config.toml uses floating "@latest"/":latest" tag.');
    for (const block of codexTomlText.match(/\[mcp_servers\.[^\]]*codebase-memory-mcp[^\]]*\][\s\S]*?(?=\n\[|$)/gi) || []) {
      if (/["']--?ui(?:=(?:true|1|yes|on))?["']/i.test(block)) issues.push('[MCP Native Sidecar Safety] codebase-memory-mcp entry in .codex/config.toml enables --ui; must pass "--ui=false".');
      if (/args\s*=\s*\[[^\]]*["'](?:update|self-update|upgrade|install|uninstall)["']/i.test(block)) issues.push('[MCP Supply Chain] codebase-memory-mcp entry in .codex/config.toml contains forbidden update/install subcommand.');
    }
  }
  const lockCheck = auditMcpDescriptorsAndLock(servers, options.lockedHashes || null);
  issues.push(...lockCheck.issues);
  return { ok: issues.length === 0, issues, warnings, checkedServers, riskByServer, descriptorHashes: lockCheck.hashes };
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
    try { mcpObj = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8')); }
    catch (err) {
      return {
        ok: false, exitCode: 1, outcome: /** @type {const} */ ('fail'),
        error: `Malformed JSON in ${mcpJsonPath}: ${err instanceof Error ? err.message : String(err)}`,
        audit: null, mcpLockPath: fs.existsSync(mcpLockPath) ? mcpLockPath : null,
      };
    }
  }
  const tomlText = fs.existsSync(codexTomlPath) ? fs.readFileSync(codexTomlPath, 'utf8') : '';
  let lockedHashes = null;
  if (!options.ignoreLock && fs.existsSync(mcpLockPath)) {
    try { lockedHashes = JSON.parse(fs.readFileSync(mcpLockPath, 'utf8')).hashes || null; } catch { lockedHashes = null; }
  }
  const cfgRes = loadAndValidateAitestConfigFile(qaDir);
  const engineManifestPath = path.join(qaDir, '.aitest', 'engine-manifest.json');
  /** @type {Record<string, any> | null} */
  let engineManifest = null;
  /** @type {string | null} */
  let manifestParseError = null;
  if (fs.existsSync(engineManifestPath)) {
    try { engineManifest = JSON.parse(fs.readFileSync(engineManifestPath, 'utf8')); }
    catch (err) { manifestParseError = `[MCP Supply Chain] Malformed JSON in .aitest/engine-manifest.json: ${err instanceof Error ? err.message : String(err)}`; }
  }
  const audit = auditMcpSafety(mcpObj, tomlText, { lockedHashes, codeMapConfig: cfgRes.config.codeMap || null, engineManifest });
  if (manifestParseError) { audit.issues.push(manifestParseError); audit.ok = false; }
  return {
    ok: audit.ok, exitCode: audit.ok ? 0 : 2, outcome: /** @type {'pass' | 'blocked'} */ (audit.ok ? 'pass' : 'blocked'),
    error: null, audit, mcpLockPath: fs.existsSync(mcpLockPath) ? mcpLockPath : null,
    engineManifestPath: fs.existsSync(engineManifestPath) ? engineManifestPath : null,
  };
}

/**
 * @param {{
 *   engineMode: string, presetVersion: string, qaInitialized: boolean, qaDir: string | null,
 *   target?: string | null, globalResolved: { found: boolean, binaryPath: string, source: string },
 *   expectedSha: string, platformAsset?: ReturnType<typeof resolvePlatformAsset> | null,
 *   configuredExternalEngine?: Record<string, any> | null, mcpServerConfigured?: boolean, uiDisabled?: boolean,
 *   manifestPresent?: boolean, manifestError?: string | null, manifest?: Record<string, any> | null,
 *   checksumVerified?: boolean | null, humanCliHint: string,
 *   governanceLockCoverage?: { mcpLockPresent: boolean, mcpLockSealed: boolean, engineManifestPresent: boolean, engineManifestSealed: boolean },
 * }} opts
 */
function buildGraphEngineStatusReport(opts) {
  const globalBinaryInstalled = Boolean(opts.globalResolved.found);
  const globalBinaryPath = opts.globalResolved.binaryPath;
  const globalBinarySha256 = globalBinaryInstalled ? computeFileSha256Hex(globalBinaryPath) || null : null;
  const globalChecksumVerified = opts.expectedSha && globalBinarySha256 ? globalBinarySha256 === opts.expectedSha : null;
  return {
    installPolicy: 'human-cli-only', engineMode: opts.engineMode, presetVersion: opts.presetVersion,
    qaInitialized: opts.qaInitialized, qaDir: opts.qaDir,
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    globalBinaryInstalled, globalBinaryPath, globalBinarySource: opts.globalResolved.source,
    globalBinarySha256, globalChecksumVerified,
    ...(opts.platformAsset !== undefined ? {
      platformSupported: Boolean(opts.platformAsset),
      platformAsset: opts.platformAsset
        ? { platformKey: opts.platformAsset.platformKey, asset: opts.platformAsset.asset, archiveSha256: opts.platformAsset.sha256, version: opts.platformAsset.version }
        : null,
    } : {}),
    configuredExternalEngine: opts.configuredExternalEngine || null,
    mcpServerConfigured: Boolean(opts.mcpServerConfigured), uiDisabled: Boolean(opts.uiDisabled),
    manifestPresent: Boolean(opts.manifestPresent), manifestError: opts.manifestError ?? null,
    manifest: opts.manifest || null, checksumVerified: opts.checksumVerified ?? null,
    governanceLockCoverage: opts.governanceLockCoverage || { mcpLockPresent: false, mcpLockSealed: false, engineManifestPresent: false, engineManifestSealed: false },
    humanCliHint: opts.humanCliHint,
  };
}

/**
 * Pure read-only inspection of external graph engine configuration, `.aitest/engine-manifest.json`,
 * `.aitest/mcp.lock`, and governance lock coverage. Binary installation intentionally remains human-CLI-only.
 * @param {string} qaDir
 */
export function inspectGraphEngineStatus(qaDir) {
  const codeMapCfg = loadAndValidateAitestConfigFile(qaDir).config.codeMap || null;
  const manifestPath = path.join(qaDir, '.aitest', 'engine-manifest.json');
  const mcpLockPath = path.join(qaDir, '.aitest', 'mcp.lock');
  const govLockPath = path.join(qaDir, '.aitest', 'governance.lock');
  const mcpJsonPath = path.join(qaDir, '.mcp.json');
  /** @param {string} p @returns {{ data: Record<string, any> | null, error: string | null }} */
  const readJsonSafe = (p) => {
    if (!fs.existsSync(p)) return { data: null, error: null };
    try { return { data: JSON.parse(fs.readFileSync(p, 'utf8')), error: null }; }
    catch (err) { return { data: null, error: err instanceof Error ? err.message : String(err) }; }
  };
  const { data: manifest, error: manifestError } = readJsonSafe(manifestPath);
  const lockedFiles = readJsonSafe(govLockPath).data?.files || {};
  const mcpEntry = readJsonSafe(mcpJsonPath).data?.mcpServers?.['codebase-memory-mcp'];
  const mcpConfigured = Boolean(mcpEntry && typeof mcpEntry === 'object');
  const uiDisabled = Boolean(mcpConfigured && Array.isArray(mcpEntry.args) && mcpEntry.args.some((/** @type {unknown} */ a) => /^--ui=(?:false|0|off|no)$/i.test(String(a))));
  const binPath = typeof manifest?.binaryPath === 'string' ? manifest.binaryPath : codeMapCfg?.externalEngine?.binaryPath || null;
  const expectedSha = normalizeSha256Hex(codeMapCfg?.externalEngine?.binarySha256 || manifest?.binarySha256 || '');
  const onDiskSha = binPath ? computeFileSha256Hex(binPath) : '';
  const presetVersion = MCP_PRESETS['codebase-memory-mcp'].pinnedVersion;
  const globalResolved = resolveInstalledEngineBinary(DEFAULT_GRAPH_ENGINE_ID, {
    qaDir, pinnedVersion: codeMapCfg?.externalEngine?.pinnedVersion || presetVersion,
    binaryPath: codeMapCfg?.externalEngine?.binaryPath, binarySha256: codeMapCfg?.externalEngine?.binarySha256,
  });
  return buildGraphEngineStatusReport({
    engineMode: codeMapCfg?.engine || 'auto', presetVersion, qaInitialized: true, qaDir,
    globalResolved, expectedSha, configuredExternalEngine: codeMapCfg?.externalEngine || null,
    mcpServerConfigured: mcpConfigured, uiDisabled, manifestPresent: fs.existsSync(manifestPath), manifestError,
    manifest: manifest ? {
      engine: manifest.engine || 'codebase-memory-mcp', targetVersion: manifest.pinnedVersion || null,
      installedVersion: manifest.installedVersion || null, binarySha256: manifest.binarySha256 || null,
      binaryPath: manifest.binaryPath || null, platform: manifest.platform || null, installedAt: manifest.installedAt || null,
    } : null,
    checksumVerified: expectedSha && onDiskSha ? onDiskSha === expectedSha : null,
    governanceLockCoverage: {
      mcpLockPresent: fs.existsSync(mcpLockPath), mcpLockSealed: '.aitest/mcp.lock' in lockedFiles,
      engineManifestPresent: fs.existsSync(manifestPath), engineManifestSealed: '.aitest/engine-manifest.json' in lockedFiles,
    },
    humanCliHint: `npx ai-test-workbench@${WORKBENCH_VERSION} mcp install-engine --target <repo> (then run "governance approve")`,
  });
}

/**
 * Pure read-only global inspection of the pinned sidecar graph engine binary when no
 * initialized `qa/` workspace is present (or `--target` is omitted).
 * @param {{ target?: string, engine?: string, expectedBinarySha256?: string, env?: NodeJS.ProcessEnv, binBaseDir?: string }} [options]
 */
export function inspectGlobalGraphEngineStatus(options = {}) {
  const engineId = String(options.engine || DEFAULT_GRAPH_ENGINE_ID).trim() || DEFAULT_GRAPH_ENGINE_ID;
  const presetVersion = (PRESETS_BY_NAME[engineId] || MCP_PRESETS['codebase-memory-mcp'])?.pinnedVersion || '0.12.1';
  const dirs = resolveIsolatedEngineDirs(engineId, presetVersion, { env: options.env, binBaseDir: options.binBaseDir });
  const resolved = resolveInstalledEngineBinary(engineId, { pinnedVersion: presetVersion, env: options.env, binBaseDir: options.binBaseDir });
  return buildGraphEngineStatusReport({
    engineMode: 'auto', presetVersion, qaInitialized: false, qaDir: null,
    target: options.target ? path.resolve(options.target) : null,
    globalResolved: { ...resolved, binaryPath: resolved.binaryPath || dirs.binaryPath },
    expectedSha: normalizeSha256Hex(options.expectedBinarySha256 || ''),
    platformAsset: resolvePlatformAsset(engineId),
    humanCliHint: `npx ai-test-workbench@${WORKBENCH_VERSION} mcp install-engine`,
  });
}
