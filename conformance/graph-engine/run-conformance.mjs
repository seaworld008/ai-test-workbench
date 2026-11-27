#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCbmGraphProvider } from '../../src/codemap/providers/cbm-adapter.mjs';
import { createCbmClient } from '../../src/codemap/providers/cbm-client.mjs';
import {
  computeFileSha256,
  probeEngineHealth,
  resolveInstalledEngineBinary,
  verifyBinaryChecksum,
} from '../../src/codemap/providers/engine-installer.mjs';
import {
  DEFAULT_GRAPH_ENGINE_ID,
  PINNED_CBM_VERSION,
  hardenWindowsOwnerOnlyDir,
  validateRuntimeDirSafety,
} from '../../src/codemap/providers/engine-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const BACKEND_FIXTURE = path.join(FIXTURES_DIR, '后端-spring-cloud');
const FRONTEND_FIXTURE = path.join(FIXTURES_DIR, '前端-vue-admin');

/**
 * Runs the upstream pinned graph-engine conformance suite against the golden multi-repo
 * Chinese-path Vue + Spring + Feign + MyBatis fixture.
 * @param {{
 *   binaryPath?: string;
 *   strictSha256?: string;
 *   allowSkipMissing?: boolean;
 *   runProcessImpl?: any;
 *   clientFactory?: typeof createCbmClient;
 * }} [options]
 */
export async function runGraphEngineConformance(options = {}) {
  const resolved = resolveInstalledEngineBinary(DEFAULT_GRAPH_ENGINE_ID, {
    binaryPath: options.binaryPath,
  });

  if (!resolved.found) {
    return {
      ok: Boolean(options.allowSkipMissing),
      skipped: Boolean(options.allowSkipMissing),
      reason: `Binary not found (checked ${resolved.binaryPath}). Pass --binary <path> or set AITEST_CBM_BIN.`,
      checks: [],
    };
  }

  const binaryPath = resolved.binaryPath;
  const binarySha256 = computeFileSha256(binaryPath);
  const isLiveWin = process.platform === 'win32' && !options.clientFactory;
  let shortBase = '';
  let ownsShortBase = false;
  if (isLiveWin) {
    const dataDir = String(process.env.AITEST_DATA_DIR || '').trim();
    const candidate = dataDir
      ? path.win32.join(dataDir, `cf-${process.pid}`)
      : `${String(process.env.SystemDrive || 'C:').trim().replace(/\\+$/, '') || 'C:'}\\aitw-cf-${process.pid}`;
    try {
      hardenWindowsOwnerOnlyDir(candidate);
      shortBase = candidate;
      ownsShortBase = true;
    } catch {
      shortBase = '';
    }
  }
  if (!shortBase) {
    shortBase = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-cf-'));
    ownsShortBase = true;
  }
  const runtimeDir = path.join(shortBase, 'rt');
  const cacheDir = path.join(shortBase, 'cbm');
  if (isLiveWin) {
    hardenWindowsOwnerOnlyDir(runtimeDir);
    hardenWindowsOwnerOnlyDir(cacheDir);
  } else {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  /** @type {Array<{ name: string, ok: boolean, detail: string }>} */
  const checks = [];
  const record = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {string} */ detail) => {
    checks.push({ name, ok, detail });
  };

  try {
    // 1. Runtime & cache directory safety
    const rtSafety = validateRuntimeDirSafety(runtimeDir);
    const cacheSafety = validateRuntimeDirSafety(cacheDir);
    record(
      'runtime-dir-safety',
      rtSafety.safe && cacheSafety.safe,
      rtSafety.safe && cacheSafety.safe
        ? `rt=${runtimeDir}, cache=${cacheDir}`
        : [...rtSafety.issues, ...cacheSafety.issues].join('; ')
    );

    // 2. Binary checksum & health probe
    if (options.strictSha256) {
      const ck = verifyBinaryChecksum(binaryPath, options.strictSha256);
      record('binary-sha256', ck.ok, ck.ok ? `verified ${binarySha256}` : ck.reason || 'mismatch');
    } else {
      record('binary-sha256', /^[0-9a-f]{64}$/.test(binarySha256), `computed ${binarySha256}`);
    }

    const health = await probeEngineHealth(DEFAULT_GRAPH_ENGINE_ID, {
      binaryPath,
      runtimeDir,
      cacheDir,
      strictChecksum: false,
      runProcessImpl: options.runProcessImpl,
    });
    record(
      'engine-version-probe',
      health.ok && Boolean(health.installedVersion),
      health.ok
        ? `version=${health.installedVersion} (pinned=${PINNED_CBM_VERSION})`
        : health.reason || 'probe failed'
    );

    // 3. Offline --ui=false incremental indexing (2 passes on Chinese-path backend + frontend fixture)
    const makeClient = options.clientFactory || createCbmClient;
    const client = makeClient({ binaryPath, runtimeDir, cacheDir });
    const pass1 = await client.indexRepository(BACKEND_FIXTURE, { mode: 'moderate' });
    const pass2 = await client.indexRepository(BACKEND_FIXTURE, { mode: 'moderate' });
    record(
      'incremental-index-cjk-path',
      pass1.ok && pass2.ok,
      pass1.ok && pass2.ok
        ? `2 incremental passes succeeded on ${path.basename(BACKEND_FIXTURE)}`
        : `pass1=${pass1.error || 'ok'}, pass2=${pass2.error || 'ok'}`
    );

    // 4. check_index_coverage telemetry
    const projectName =
      (pass2.data && typeof pass2.data === 'object' && (pass2.data.project || pass2.data.name)) ||
      path.basename(BACKEND_FIXTURE);
    const covRes = await client.checkIndexCoverage(String(projectName), { diagnostics: 'full' });
    record(
      'check-index-coverage',
      covRes.ok,
      covRes.ok ? `coverage payload received for "${projectName}"` : covRes.error || 'coverage failed'
    );

    // 5. Full provider syncRepos (2 consecutive runs -> Java chain fidelity + byte-identical determinism)
    const provider = createCbmGraphProvider();
    const repoSpecs = [
      { path: BACKEND_FIXTURE, label: '后端-spring-cloud' },
      { path: FRONTEND_FIXTURE, label: '前端-vue-admin' },
    ];
    const providerCtx = {
      binaryPath,
      runtimeDir,
      cacheDir,
      strictChecksum: false,
      runProcessImpl: options.runProcessImpl,
      clientFactory: options.clientFactory,
    };

    const snap1 = await provider.syncRepos(repoSpecs, providerCtx);
    const snap2 = await provider.syncRepos(repoSpecs, providerCtx);

    const isEnriched = snap1.meta.mode === 'enriched' && snap2.meta.mode === 'enriched';
    record(
      'normalized-snapshot-enriched',
      isEnriched,
      isEnriched
        ? `symbols=${snap1.symbols.length}, edges=${snap1.callEdges.length}, chains=${snap1.controllerChains.length}`
        : `degraded: ${snap1.meta.degradedReason || snap2.meta.degradedReason || 'unknown'}`
    );

    const hasOrderChain = snap1.controllerChains.some(
      (c) =>
        /OrderController\.java$/i.test(c.controllerFile) &&
        c.controllerMethod === 'createOrder' &&
        (c.serviceMethods.some((s) => /OrderService/i.test(s)) ||
          c.mapperMethods.some((m) => /OrderMapper/i.test(m)))
    );
    record(
      'java-controller-service-mapper-chain',
      hasOrderChain,
      hasOrderChain
        ? `resolved OrderController.createOrder chain (${JSON.stringify(snap1.controllerChains[0])})`
        : `missing OrderController.createOrder chain in ${snap1.controllerChains.length} chains`
    );

    const deterministic = JSON.stringify(snap1) === JSON.stringify(snap2);
    record(
      'deterministic-snapshot-json',
      deterministic,
      deterministic ? '2 consecutive NormalizedGraphSnapshot payloads are byte-identical' : 'snapshot output drifted between runs'
    );

    const ok = checks.every((c) => c.ok);
    return {
      ok,
      skipped: false,
      binaryPath,
      binarySha256,
      version: health.installedVersion,
      checks,
      snapshotSummary: {
        mode: snap1.meta.mode,
        symbols: snap1.symbols.length,
        callEdges: snap1.callEdges.length,
        controllerChains: snap1.controllerChains.length,
        filesIndexed: Object.keys(snap1.fileSymbols).length,
      },
    };
  } finally {
    if (ownsShortBase) {
      try {
        fs.rmSync(shortBase, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
      } catch {
        // Ignore transient Windows daemon lock handles during temp directory cleanup.
      }
    }
  }
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ binaryPath?: string, strictSha256?: string, allowSkipMissing: boolean, json: boolean }} */
  const parsed = { allowSkipMissing: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--binary' && argv[i + 1]) {
      parsed.binaryPath = argv[++i];
    } else if (arg === '--strict-sha256' && argv[i + 1]) {
      parsed.strictSha256 = argv[++i];
    } else if (arg === '--allow-skip-missing') {
      parsed.allowSkipMissing = true;
    } else if (arg === '--json') {
      parsed.json = true;
    }
  }
  return parsed;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const cliOpts = parseArgs(process.argv.slice(2));
  const result = await runGraphEngineConformance(cliOpts);
  if (cliOpts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[Graph Engine Conformance] ok=${result.ok}${result.skipped ? ' (skipped)' : ''}`);
    for (const c of result.checks || []) {
      console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
    }
    if (result.reason) console.log(`  Note: ${result.reason}`);
  }
  process.exit(result.ok ? 0 : 1);
}
