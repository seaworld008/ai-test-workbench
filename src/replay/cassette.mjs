// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { validateReplayUpstreamHostEntry } from '../core/config.mjs';
import { loadAitestConfig, sha256Hex, verifyGovernanceLockInQaDir } from '../kernel/gate-kernel.mjs';

/**
 * @typedef {{
 *   event?: string;
 *   id?: string;
 *   data: string;
 *   delayMs?: number;
 * }} CassetteSseFrame
 *
 * @typedef {{
 *   method: string;
 *   path: string;
 *   requestShapeHash?: string | null;
 *   status: number;
 *   headers?: Record<string, string>;
 *   body?: unknown;
 *   sseFrames?: CassetteSseFrame[] | null;
 * }} UpstreamCassetteEntry
 *
 * @typedef {{
 *   schemaVersion: 1;
 *   upstreamHost: string;
 *   recordedAt?: string;
 *   entries: UpstreamCassetteEntry[];
 * }} UpstreamCassette
 */

/**
 * Computes a deterministic request-shape SHA-256 hash (`sha256:<hex>`) from HTTP method, path, and normalized body.
 * @param {string} method
 * @param {string} reqPath
 * @param {unknown} [body]
 * @returns {string}
 */
export function computeRequestShapeHash(method, reqPath, body = null) {
  let bodyCanonical = '';
  if (typeof body === 'string' && body.trim()) {
    try {
      const parsed = JSON.parse(body);
      bodyCanonical = JSON.stringify(sortKeysDeep(parsed));
    } catch {
      bodyCanonical = body.trim();
    }
  } else if (body && typeof body === 'object') {
    bodyCanonical = JSON.stringify(sortKeysDeep(body));
  }
  const raw = `${String(method || 'GET').toUpperCase()} ${String(reqPath || '/')} ${bodyCanonical}`;
  return `sha256:${crypto.createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}

/** @param {any} val @returns {any} */
function sortKeysDeep(val) {
  if (Array.isArray(val)) return val.map(sortKeysDeep);
  if (val && typeof val === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(val).sort()) out[k] = sortKeysDeep(val[k]);
    return out;
  }
  return val;
}

/** @param {string} p */
function realPathSafe(p) {
  const abs = path.resolve(p);
  try {
    return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Fail-closed loader for governance-locked external upstream replay cassettes (`WU-C`).
 * Enforces:
 * 1. Cassette lives strictly under `<qaDir>/fixtures/upstream-cassettes/`.
 * 2. `.aitest/governance.lock` passes `verifyGovernanceLockInQaDir` AND explicitly hashes this cassette file.
 * 3. `cassette.upstreamHost` is a valid non-loopback external host present in `aitest.config.json#replayAllowedUpstreamHosts`.
 *
 * @param {string} qaDir
 * @param {string} cassetteRelPath
 * @param {{ requireT1Mac?: boolean, trustContext?: any }} [options]
 */
export function loadVerifiedUpstreamCassette(qaDir, cassetteRelPath, options = {}) {
  /** @param {string[]} errors */
  const block = (errors) => ({
    ok: false,
    outcome: /** @type {const} */ ('blocked'),
    exitCode: 2,
    cassette: /** @type {UpstreamCassette | null} */ (null),
    relPath: '',
    digest: null,
    trustTier: /** @type {'T0' | 'T1'} */ ('T0'),
    errors,
  });

  const realQa = realPathSafe(qaDir);
  const cassettesRoot = path.join(realQa, 'fixtures', 'upstream-cassettes');
  const resolved = path.isAbsolute(cassetteRelPath)
    ? realPathSafe(cassetteRelPath)
    : realPathSafe(path.resolve(realQa, cassetteRelPath));
  const relFromQa = path.relative(realQa, resolved).replace(/\\/g, '/');

  if (
    !relFromQa ||
    relFromQa.startsWith('..') ||
    !relFromQa.startsWith('fixtures/upstream-cassettes/') ||
    !relFromQa.endsWith('.json')
  ) {
    return block([
      `[Upstream Cassette Blocked] Cassette path "${cassetteRelPath}" must be a .json file inside fixtures/upstream-cassettes/.`,
    ]);
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return block([`[Upstream Cassette Blocked] Cassette file not found: ${relFromQa}`]);
  }

  const cfg = loadAitestConfig(realQa);
  if (cfg._configError) {
    return block([`[Upstream Cassette Blocked] Invalid aitest.config.json: ${cfg._configError}`]);
  }

  const govRes = verifyGovernanceLockInQaDir(realQa, {
    requireT1Mac: Boolean(options.requireT1Mac),
    trustContext: options.trustContext,
  });
  if (!govRes.ok) {
    return block([
      `[Upstream Cassette Blocked] Governance lock verification failed for "${relFromQa}".`,
      ...govRes.errors,
    ]);
  }

  const lockObj = JSON.parse(fs.readFileSync(govRes.lockPath, 'utf8'));
  const rawText = fs.readFileSync(resolved, 'utf8');
  const actualDigest = `sha256:${sha256Hex(rawText.replace(/\r\n/g, '\n'))}`;
  const lockedDigest = lockObj?.files?.[relFromQa];
  if (!lockedDigest || lockedDigest !== actualDigest) {
    return block([
      `[Upstream Cassette Blocked] Cassette "${relFromQa}" is not sealed or hash-mismatched in .aitest/governance.lock (human governance approve required).`,
    ]);
  }

  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return block([`[Upstream Cassette Blocked] Corrupted JSON in "${relFromQa}": ${err instanceof Error ? err.message : String(err)}`]);
  }

  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) {
    return block([`[Upstream Cassette Blocked] Invalid cassette schema in "${relFromQa}" (requires schemaVersion=1 and entries[]).`]);
  }

  const hostCheck = validateReplayUpstreamHostEntry(parsed.upstreamHost);
  if (!hostCheck.ok) {
    return block([`[Upstream Cassette Blocked] Invalid cassette upstreamHost: ${hostCheck.error}.`]);
  }

  const allowedHosts = Array.isArray(cfg.replayAllowedUpstreamHosts) ? cfg.replayAllowedUpstreamHosts : [];
  if (!allowedHosts.includes(hostCheck.normalized)) {
    return block([
      `[Upstream Cassette Blocked] Cassette upstreamHost "${hostCheck.normalized}" is not allowlisted in aitest.config.json#replayAllowedUpstreamHosts (${allowedHosts.join(', ') || 'empty'}).`,
    ]);
  }

  return {
    ok: true,
    outcome: /** @type {const} */ ('pass'),
    exitCode: 0,
    cassette: /** @type {UpstreamCassette} */ ({ ...parsed, upstreamHost: hostCheck.normalized }),
    relPath: relFromQa,
    digest: actualDigest,
    trustTier: govRes.trustTier,
    errors: /** @type {string[]} */ ([]),
  };
}

/**
 * Starts a deterministic local loopback HTTP/SSE stub server replaying a verified external upstream cassette
 * identically to both Baseline and Candidate targets (zero real upstream LLM calls, zero double-billing).
 * @param {UpstreamCassette} cassette
 * @param {{ host?: string, port?: number }} [options]
 */
export async function startCassetteReplayServer(cassette, options = {}) {
  const entries = Array.isArray(cassette?.entries) ? cassette.entries : [];
  let hitCount = 0;

  const server = http.createServer((req, res) => {
    const chunks = /** @type {Buffer[]} */ ([]);
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', async () => {
      const method = String(req.method || 'GET').toUpperCase();
      const rawUrl = String(req.url || '/');
      const reqPath = rawUrl.split('?')[0] || '/';
      const bodyStr = Buffer.concat(chunks).toString('utf8');
      const shapeHash = computeRequestShapeHash(method, reqPath, bodyStr);

      const matched =
        entries.find(
          (e) =>
            String(e.method || 'GET').toUpperCase() === method &&
            String(e.path || '/') === reqPath &&
            e.requestShapeHash &&
            e.requestShapeHash === shapeHash
        ) ||
        entries.find(
          (e) =>
            String(e.method || 'GET').toUpperCase() === method &&
            String(e.path || '/') === reqPath &&
            !e.requestShapeHash
        ) ||
        entries.find(
          (e) => String(e.method || 'GET').toUpperCase() === method && String(e.path || '/') === reqPath
        );

      if (!matched) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Cassette entry not found', method, path: reqPath, requestShapeHash: shapeHash }));
        return;
      }

      hitCount += 1;
      const status = typeof matched.status === 'number' ? matched.status : 200;
      const headers = { ...(matched.headers || {}) };

      if (Array.isArray(matched.sseFrames)) {
        const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
        if (!hasCt) headers['Content-Type'] = 'text/event-stream; charset=utf-8';
        headers['Cache-Control'] = 'no-cache';
        res.writeHead(status, headers);
        for (const frame of matched.sseFrames) {
          if (typeof frame.delayMs === 'number' && frame.delayMs > 0) {
            await new Promise((r) => setTimeout(r, frame.delayMs));
          }
          let chunk = '';
          if (frame.event) chunk += `event: ${frame.event}\n`;
          if (frame.id) chunk += `id: ${frame.id}\n`;
          for (const dLine of String(frame.data ?? '').split(/\r?\n/)) {
            chunk += `data: ${dLine}\n`;
          }
          chunk += '\n';
          res.write(chunk);
        }
        res.end();
        return;
      }

      const bodyOut =
        typeof matched.body === 'string'
          ? matched.body
          : matched.body !== undefined && matched.body !== null
            ? JSON.stringify(matched.body)
            : '';
      const hasCt = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
      if (!hasCt) headers['Content-Type'] = 'application/json; charset=utf-8';
      res.writeHead(status, headers);
      res.end(bodyOut);
    });
  });

  const bindHost = options.host || '127.0.0.1';
  const bindPort = options.port ?? 0;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(bindPort, bindHost, () => resolve(null));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : bindPort;
  return {
    server,
    port,
    baseUrl: `http://${bindHost}:${port}`,
    getHitCount: () => hitCount,
    close: () => new Promise((resolve) => server.close(() => resolve(null))),
  };
}
