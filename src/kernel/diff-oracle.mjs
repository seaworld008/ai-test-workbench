// @ts-check
import crypto from 'node:crypto';
import { parseSseStreamText } from '../core/stream-sse.mjs';
import { compareJsonBodies, isJsonPathNormalized } from './diff-json.mjs';

/**
 * Authoritative 5-Checkpoint Differential Parity Oracle & Zero-Plaintext Shape Fingerprinter (`ADR-0006`).
 *
 * Core Invariant:
 * - NEVER auto-learns or silently ignores volatile fields by running the baseline twice.
 * - Deterministic normalization applies ONLY to explicitly declared `normalizePaths`.
 */

export const DEFAULT_NORMALIZE_PATHS = Object.freeze([
  'headers.date',
  'headers.etag',
  'headers.x-request-id',
  'headers.traceparent',
]);

const DEFAULT_CHECKED_HEADERS = ['content-type', 'location', 'www-authenticate', 'cache-control', 'vary'];

/**
 * @typedef {{
 *   routePattern?: string; method?: string; path?: string; status?: number;
 *   headers?: Record<string, string>; bodyText?: string; bodyJson?: unknown;
 *   ariaSnapshot?: string | null; pageErrors?: string[]; serverErrors?: string[];
 *   durationMs?: number | null; ttftMs?: number | null; featureCohort?: string[]; isSse?: boolean;
 * }} ParitySample
 *
 * @typedef {{
 *   checkpoint: 'CP1-Status-Headers' | 'CP2-Body-Shape-And-Value' | 'CP3-Stream-Frames' | 'CP4-DOM-ARIA-And-Runtime' | 'CP5-Perf-Ratio';
 *   routePattern: string; pieceOrJsonPath: string; firstDiffByteOffset: number;
 *   baselineByteLen: number; candidateByteLen: number; diffKind: string; featureCohort?: string[];
 * }} ShapeFingerprintInput
 *
 * @typedef {{
 *   fingerprintId: string; checkpoint: string; routePattern: string; pieceOrJsonPath: string;
 *   firstDiffByteOffset: number; baselineByteLen: number; candidateByteLen: number;
 *   diffKind: string; featureCohort: string[];
 * }} ShapeFingerprint
 *
 * @typedef {{
 *   checkpoint: ShapeFingerprintInput['checkpoint']; severity: 'error' | 'warn';
 *   diffKind: string; routePattern: string; pieceOrJsonPath: string;
 *   firstDiffByteOffset: number; baselineByteLen: number; candidateByteLen: number;
 *   baselinePreview: string | null; candidatePreview: string | null;
 *   fingerprint: ShapeFingerprint; message: string;
 * }} ParityMismatch
 */

/**
 * Computes UTF-8 byte lengths and the first differing byte offset between two strings.
 * @param {string} a
 * @param {string} b
 */
export function computeByteDiffMetrics(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  const minLen = Math.min(bufA.length, bufB.length);
  let offset = -1;
  for (let i = 0; i < minLen; i += 1) {
    if (bufA[i] !== bufB[i]) { offset = i; break; }
  }
  if (offset === -1 && bufA.length !== bufB.length) offset = minLen;
  return {
    firstDiffByteOffset: offset === -1 ? 0 : offset,
    baselineByteLen: bufA.length,
    candidateByteLen: bufB.length,
    equal: offset === -1,
  };
}

/**
 * Computes a deterministic zero-plaintext SHA-256 shape fingerprint (`fp_<12hex>`).
 * @param {ShapeFingerprintInput} input
 * @returns {ShapeFingerprint}
 */
export function computeShapeFingerprint(input) {
  const featureCohort = [...new Set((input.featureCohort || []).map((t) => String(t).trim()).filter(Boolean))].sort();
  const normalized = {
    checkpoint: String(input.checkpoint || 'CP2-Body-Shape-And-Value'),
    routePattern: String(input.routePattern || 'UNKNOWN'),
    pieceOrJsonPath: String(input.pieceOrJsonPath || '$'),
    firstDiffByteOffset: Math.max(0, Number(input.firstDiffByteOffset || 0)),
    baselineByteLen: Math.max(0, Number(input.baselineByteLen || 0)),
    candidateByteLen: Math.max(0, Number(input.candidateByteLen || 0)),
    diffKind: String(input.diffKind || 'value-mismatch'),
    featureCohort,
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex').slice(0, 12);
  return { fingerprintId: `fp_${digest}`, ...normalized };
}

/** @param {Record<string, string> | undefined} hdrs */
function normalizeHeadersMap(hdrs) {
  /** @type {Record<string, string>} */ const out = {};
  for (const [k, v] of Object.entries(hdrs || {})) out[String(k).toLowerCase()] = String(v ?? '').trim();
  return out;
}

/** @param {string} ct */
function normalizeContentType(ct) {
  return String(ct || '').toLowerCase().split(';').map((p) => p.trim()).filter(Boolean).join('; ');
}

/**
 * Compares Baseline vs Candidate samples across all 5 checkpoints (`CP1..CP5`) with deterministic
 * explicit-path normalization and zero-plaintext shape fingerprinting (`shape-only` privacy mode).
 * @param {ParitySample} baselineSample
 * @param {ParitySample} candidateSample
 * @param {{
 *   normalizePaths?: string[]; includeDefaultNormalizePaths?: boolean; strictByteEscape?: boolean;
 *   maxLatencyRatio?: number | null; maxTtftRatio?: number | null; privacyMode?: 'redacted' | 'shape-only';
 *   checkedHeaders?: string[]; routePattern?: string; featureCohort?: string[];
 * }} [options]
 */
export function compareParityCheckpoints(baselineSample, candidateSample, options = {}) {
  const privacyMode = options.privacyMode === 'shape-only' ? 'shape-only' : 'redacted';
  const strictByteEscape = Boolean(options.strictByteEscape);
  const routePattern =
    options.routePattern ||
    baselineSample.routePattern ||
    candidateSample.routePattern ||
    `${String(baselineSample.method || candidateSample.method || 'GET').toUpperCase()} ${baselineSample.path || candidateSample.path || '/'}`;
  const featureCohort = [
    ...new Set([...(options.featureCohort || []), ...(baselineSample.featureCohort || []), ...(candidateSample.featureCohort || [])]),
  ].sort();

  const allNormalizePaths = [
    ...(options.includeDefaultNormalizePaths === false ? [] : DEFAULT_NORMALIZE_PATHS),
    ...(options.normalizePaths || []),
  ];
  const ignoredHeaders = new Set(
    allNormalizePaths.filter((p) => p.toLowerCase().startsWith('headers.')).map((p) => p.slice('headers.'.length).toLowerCase())
  );
  const ignoredJsonPaths = allNormalizePaths.filter((p) => p.startsWith('$'));

  /** @type {ParityMismatch[]} */ const mismatches = [];
  /** @type {ParityMismatch[]} */ const perfWarnings = [];

  /**
   * @param {ShapeFingerprintInput['checkpoint']} checkpoint
   * @param {'error' | 'warn'} severity
   * @param {string} diffKind
   * @param {string} pieceOrJsonPath
   * @param {string} baseStr
   * @param {string} candStr
   */
  const recordDiff = (checkpoint, severity, diffKind, pieceOrJsonPath, baseStr, candStr) => {
    const metrics = computeByteDiffMetrics(baseStr, candStr);
    const fingerprint = computeShapeFingerprint({
      checkpoint,
      routePattern,
      pieceOrJsonPath,
      firstDiffByteOffset: metrics.firstDiffByteOffset,
      baselineByteLen: metrics.baselineByteLen,
      candidateByteLen: metrics.candidateByteLen,
      diffKind,
      featureCohort,
    });
    const isShapeOnly = privacyMode === 'shape-only';
    const entry = {
      checkpoint,
      severity,
      diffKind,
      routePattern,
      pieceOrJsonPath,
      firstDiffByteOffset: metrics.firstDiffByteOffset,
      baselineByteLen: metrics.baselineByteLen,
      candidateByteLen: metrics.candidateByteLen,
      baselinePreview: isShapeOnly ? null : String(baseStr).slice(0, 160),
      candidatePreview: isShapeOnly ? null : String(candStr).slice(0, 160),
      fingerprint,
      message: `[${checkpoint}][${diffKind}] ${routePattern} @ ${pieceOrJsonPath} (firstDiffByte=${metrics.firstDiffByteOffset}, bytes=${metrics.baselineByteLen} vs ${metrics.candidateByteLen}, fp=${fingerprint.fingerprintId})`,
    };
    if (severity === 'warn') perfWarnings.push(entry);
    else mismatches.push(entry);
  };

  // --- CP1-Status-Headers ---
  const baseHeaders = normalizeHeadersMap(baselineSample.headers);
  const candHeaders = normalizeHeadersMap(candidateSample.headers);
  if (baselineSample.status !== undefined && candidateSample.status !== undefined && baselineSample.status !== candidateSample.status) {
    recordDiff('CP1-Status-Headers', 'error', 'status-mismatch', 'status', String(baselineSample.status), String(candidateSample.status));
  }
  const headerKeys = [...new Set([...DEFAULT_CHECKED_HEADERS, ...(options.checkedHeaders || []).map((h) => h.toLowerCase())])];
  for (const hk of headerKeys) {
    if (ignoredHeaders.has(hk)) continue;
    const bv = hk === 'content-type' ? normalizeContentType(baseHeaders[hk] || '') : baseHeaders[hk] || '';
    const cv = hk === 'content-type' ? normalizeContentType(candHeaders[hk] || '') : candHeaders[hk] || '';
    if (bv !== cv) recordDiff('CP1-Status-Headers', 'error', 'header-mismatch', `headers.${hk}`, bv, cv);
  }

  // --- CP2-Body-Shape-And-Value vs CP3-Stream-Frames ---
  const isSse =
    Boolean(baselineSample.isSse || candidateSample.isSse) ||
    /text\/event-stream/i.test(baseHeaders['content-type'] || '') ||
    /text\/event-stream/i.test(candHeaders['content-type'] || '');
  const baseBodyText = baselineSample.bodyText !== undefined ? String(baselineSample.bodyText) : baselineSample.bodyJson !== undefined ? JSON.stringify(baselineSample.bodyJson) : '';
  const candBodyText = candidateSample.bodyText !== undefined ? String(candidateSample.bodyText) : candidateSample.bodyJson !== undefined ? JSON.stringify(candidateSample.bodyJson) : '';

  if (isSse) {
    const baseSse = parseSseStreamText(baseBodyText);
    const candSse = parseSseStreamText(candBodyText);
    if (baseSse.cleanTermination !== candSse.cleanTermination) {
      recordDiff('CP3-Stream-Frames', 'error', 'stream-termination-mismatch', 'stream.cleanTermination', String(baseSse.cleanTermination), String(candSse.cleanTermination));
    }
    if (baseSse.envelopeErrors.length !== candSse.envelopeErrors.length) {
      recordDiff('CP3-Stream-Frames', 'error', 'stream-envelope-error-mismatch', 'stream.envelopeErrors', String(baseSse.envelopeErrors.length), String(candSse.envelopeErrors.length));
    }
    const maxEv = Math.max(baseSse.frames.length, candSse.frames.length);
    for (let i = 0; i < maxEv; i += 1) {
      const be = baseSse.frames[i]?.event ?? '<eof>';
      const ce = candSse.frames[i]?.event ?? '<eof>';
      if (be !== ce) {
        recordDiff('CP3-Stream-Frames', 'error', 'stream-event-sequence-mismatch', `frames[${i}].event`, be, ce);
        break;
      }
    }
    if (baseSse.text !== candSse.text) recordDiff('CP3-Stream-Frames', 'error', 'stream-text-mismatch', 'stream.text', baseSse.text, candSse.text);
    if (baseSse.thinking !== candSse.thinking) recordDiff('CP3-Stream-Frames', 'error', 'stream-thinking-mismatch', 'stream.thinking', baseSse.thinking, candSse.thinking);
    const baseTcJson = JSON.stringify(baseSse.toolCalls.map((t) => ({ name: t.name, input: t.input })));
    const candTcJson = JSON.stringify(candSse.toolCalls.map((t) => ({ name: t.name, input: t.input })));
    if (baseTcJson !== candTcJson) {
      recordDiff('CP3-Stream-Frames', 'error', 'stream-toolcalls-mismatch', 'stream.toolCalls', baseTcJson, candTcJson);
    } else if (strictByteEscape) {
      const baseTcRaw = baseSse.toolCalls.map((t) => t.inputJson).join('|');
      const candTcRaw = candSse.toolCalls.map((t) => t.inputJson).join('|');
      if (baseTcRaw !== candTcRaw) recordDiff('CP3-Stream-Frames', 'error', 'byte-escape-mismatch', 'stream.toolCalls.inputJson', baseTcRaw, candTcRaw);
    }
    if (JSON.stringify(baseSse.usage) !== JSON.stringify(candSse.usage) && !isJsonPathNormalized('$.usage', ignoredJsonPaths)) {
      recordDiff('CP3-Stream-Frames', 'error', 'stream-usage-mismatch', 'stream.usage', JSON.stringify(baseSse.usage), JSON.stringify(candSse.usage));
    }
  } else if (baseBodyText !== '' || candBodyText !== '') {
    compareJsonBodies(baseBodyText, candBodyText, {
      ignoredJsonPaths,
      strictByteEscape,
      onDiff: (diffKind, pieceOrJsonPath, baseStr, candStr) =>
        recordDiff('CP2-Body-Shape-And-Value', 'error', diffKind, pieceOrJsonPath, baseStr, candStr),
    });
  }

  // --- CP4-DOM-ARIA-And-Runtime ---
  if (baselineSample.ariaSnapshot != null || candidateSample.ariaSnapshot != null) {
    const baseAria = String(baselineSample.ariaSnapshot || '').replace(/\r\n/g, '\n').trim();
    const candAria = String(candidateSample.ariaSnapshot || '').replace(/\r\n/g, '\n').trim();
    if (baseAria !== candAria) {
      const bLines = baseAria.split('\n');
      const cLines = candAria.split('\n');
      let diffLine = 0;
      for (let i = 0; i < Math.max(bLines.length, cLines.length); i += 1) {
        if ((bLines[i] ?? '') !== (cLines[i] ?? '')) { diffLine = i; break; }
      }
      recordDiff('CP4-DOM-ARIA-And-Runtime', 'error', 'aria-snapshot-mismatch', `aria.line[${diffLine + 1}]`, bLines[diffLine] ?? '', cLines[diffLine] ?? '');
    }
  }
  const basePageErrs = baselineSample.pageErrors || [];
  const candPageErrs = candidateSample.pageErrors || [];
  if (candPageErrs.length > basePageErrs.length) {
    recordDiff('CP4-DOM-ARIA-And-Runtime', 'error', 'candidate-page-error', 'runtime.pageErrors', String(basePageErrs.length), String(candPageErrs.length));
  }
  const baseSrvErrs = baselineSample.serverErrors || [];
  const candSrvErrs = candidateSample.serverErrors || [];
  if (candSrvErrs.length > baseSrvErrs.length) {
    recordDiff('CP4-DOM-ARIA-And-Runtime', 'error', 'candidate-server-error', 'runtime.serverErrors', String(baseSrvErrs.length), String(candSrvErrs.length));
  }

  // --- CP5-Perf-Ratio ---
  const baseDur = typeof baselineSample.durationMs === 'number' && Number.isFinite(baselineSample.durationMs) ? baselineSample.durationMs : null;
  const candDur = typeof candidateSample.durationMs === 'number' && Number.isFinite(candidateSample.durationMs) ? candidateSample.durationMs : null;
  const baseTtft = typeof baselineSample.ttftMs === 'number' && Number.isFinite(baselineSample.ttftMs) ? baselineSample.ttftMs : null;
  const candTtft = typeof candidateSample.ttftMs === 'number' && Number.isFinite(candidateSample.ttftMs) ? candidateSample.ttftMs : null;
  const durationRatio = baseDur !== null && baseDur > 0 && candDur !== null ? Number((candDur / baseDur).toFixed(3)) : null;
  const ttftRatio = baseTtft !== null && baseTtft > 0 && candTtft !== null ? Number((candTtft / baseTtft).toFixed(3)) : null;
  if (options.maxLatencyRatio != null && durationRatio !== null && durationRatio > options.maxLatencyRatio) {
    recordDiff('CP5-Perf-Ratio', 'warn', 'latency-ratio-exceeded', 'perf.durationRatio', String(baseDur), String(candDur));
  }
  if (options.maxTtftRatio != null && ttftRatio !== null && ttftRatio > options.maxTtftRatio) {
    recordDiff('CP5-Perf-Ratio', 'warn', 'ttft-ratio-exceeded', 'perf.ttftRatio', String(baseTtft), String(candTtft));
  }

  const hasCp = (/** @type {string} */ cp) => mismatches.some((m) => m.checkpoint === cp);
  const checkpoints = {
    CP1: hasCp('CP1-Status-Headers') ? 'fail' : 'pass',
    CP2: isSse ? 'skipped' : hasCp('CP2-Body-Shape-And-Value') ? 'fail' : 'pass',
    CP3: isSse ? (hasCp('CP3-Stream-Frames') ? 'fail' : 'pass') : 'skipped',
    CP4: baselineSample.ariaSnapshot == null && candidateSample.ariaSnapshot == null && candPageErrs.length === 0 && candSrvErrs.length === 0 ? 'skipped' : hasCp('CP4-DOM-ARIA-And-Runtime') ? 'fail' : 'pass',
    CP5: perfWarnings.length > 0 ? 'warn' : durationRatio !== null || ttftRatio !== null ? 'pass' : 'skipped',
  };

  const primaryMismatch = mismatches[0] || null;
  return {
    ok: mismatches.length === 0,
    matched: mismatches.length === 0,
    privacyMode,
    checkpoints,
    mismatches,
    perfWarnings,
    primaryMismatch,
    fingerprint: primaryMismatch ? primaryMismatch.fingerprint : null,
    perf: { baselineDurationMs: baseDur, candidateDurationMs: candDur, durationRatio, baselineTtftMs: baseTtft, candidateTtftMs: candTtft, ttftRatio },
  };
}
