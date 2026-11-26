// @ts-check
import fs from 'node:fs';
import path from 'node:path';

const MAX_CAPTURED_ENDPOINTS = 60;
const MAX_ARRAY_ITEMS_TO_SAMPLE = 50;
const MAX_UNION_SAMPLES = 200;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const UNICODE_ESCAPE_RE = /\\u[0-9a-fA-F]{4}/;

/** @param {Record<string, any> | null | undefined} schema */
function isEmptySchema(schema) {
  return !schema || (typeof schema === 'object' && Object.keys(schema).length === 0);
}

/** @param {Record<string, any>} s */
function cloneSchema(s) {
  return JSON.parse(JSON.stringify(s));
}

/** @param {Record<string, any>} s */
function unwrapVariants(s) {
  if (Array.isArray(s.oneOf)) return s.oneOf.map(cloneSchema);
  const copy = cloneSchema(s);
  delete copy.nullable;
  return [copy];
}

/**
 * Merges two inferred JSON Schema drafts into a lossless union schema:
 * - Empty `{}` merges cleanly with non-empty schemas (preserving array `items` when merging empty & non-empty arrays).
 * - `integer` + `number` widens to `number`.
 * - `null` + `T` marks `nullable: true` on `T`.
 * - `object` + `object` unions properties and takes the strict intersection of non-null `required` keys.
 * - Heterogeneous types emit a deduplicated `oneOf` union.
 * @param {Record<string, any> | null | undefined} a
 * @param {Record<string, any> | null | undefined} b
 * @returns {Record<string, any>}
 */
export function mergeInferredSchemas(a, b) {
  if (isEmptySchema(a)) return isEmptySchema(b) ? {} : cloneSchema(/** @type {Record<string, any>} */ (b));
  if (isEmptySchema(b)) return cloneSchema(/** @type {Record<string, any>} */ (a));

  const sa = /** @type {Record<string, any>} */ (a);
  const sb = /** @type {Record<string, any>} */ (b);

  if (sa.type === 'null' && sb.type === 'null') return { type: 'null' };
  if (sa.type === 'null') return { ...cloneSchema(sb), nullable: true };
  if (sb.type === 'null') return { ...cloneSchema(sa), nullable: true };

  const nullable = Boolean(sa.nullable || sb.nullable);
  const withNullable = (/** @type {Record<string, any>} */ out) => (nullable ? { ...out, nullable: true } : out);

  if (sa.type && sb.type && !sa.oneOf && !sb.oneOf) {
    if (sa.type === sb.type) {
      if (sa.type === 'array') {
        return withNullable({ type: 'array', items: mergeInferredSchemas(sa.items || {}, sb.items || {}) });
      }
      if (sa.type === 'object') {
        const propsA = sa.properties || {};
        const propsB = sb.properties || {};
        const reqA = new Set(Array.isArray(sa.required) ? sa.required : []);
        const reqB = new Set(Array.isArray(sb.required) ? sb.required : []);
        /** @type {Record<string, any>} */
        const properties = {};
        const keys = [...new Set([...Object.keys(propsA), ...Object.keys(propsB)])].slice(0, 60);
        for (const k of keys) {
          if (k in propsA && k in propsB) properties[k] = mergeInferredSchemas(propsA[k], propsB[k]);
          else properties[k] = cloneSchema(k in propsA ? propsA[k] : propsB[k]);
        }
        const required = [...reqA].filter(
          (k) => reqB.has(k) && properties[k] && properties[k].type !== 'null' && !properties[k].nullable
        );
        return withNullable({
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        });
      }
      return withNullable({ type: sa.type });
    }

    if ((sa.type === 'integer' && sb.type === 'number') || (sa.type === 'number' && sb.type === 'integer')) {
      return withNullable({ type: 'number' });
    }
  }

  // Heterogeneous types -> deduplicated `oneOf`
  const merged = [...unwrapVariants(sa)];
  for (const cand of unwrapVariants(sb)) {
    const matchIdx = merged.findIndex((existing) => existing.type && cand.type && existing.type === cand.type);
    if (matchIdx >= 0) {
      merged[matchIdx] = mergeInferredSchemas(merged[matchIdx], cand);
    } else if (!merged.some((existing) => JSON.stringify(existing) === JSON.stringify(cand))) {
      merged.push(cand);
    }
  }
  if (merged.length === 1) return withNullable(merged[0]);
  return withNullable({ oneOf: merged });
}

/**
 * Infers a compact JSON Schema draft object from a runtime JSON sample value.
 * Inspects up to the first 50 array elements (merging heterogeneous item shapes) rather than only `val[0]`.
 * @param {unknown} val
 * @param {number} [depth]
 * @returns {Record<string, any>}
 */
export function inferJsonSchemaFromSample(val, depth = 0) {
  if (val === null) return { type: 'null' };
  if (Array.isArray(val)) {
    if (val.length === 0 || depth >= 4) return { type: 'array', items: {} };
    /** @type {Record<string, any>} */
    let itemSchema = {};
    for (const elem of val.slice(0, MAX_ARRAY_ITEMS_TO_SAMPLE)) {
      itemSchema = mergeInferredSchemas(itemSchema, inferJsonSchemaFromSample(elem, depth + 1));
    }
    return { type: 'array', items: itemSchema };
  }
  if (typeof val === 'object') {
    /** @type {Record<string, any>} */
    const properties = {};
    const required = [];
    for (const [k, v] of Object.entries(val).slice(0, 40)) {
      properties[k] = depth >= 4 ? {} : inferJsonSchemaFromSample(v, depth + 1);
      if (v !== undefined && v !== null) required.push(k);
    }
    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }
  if (typeof val === 'number') return { type: Number.isInteger(val) ? 'integer' : 'number' };
  if (typeof val === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

/**
 * Detects Unicode/Emoji/escape encoding traits across sample payloads to trigger encoding-parity checks.
 * @param {unknown} sample
 * @param {string} [rawText]
 * @returns {string[]}
 */
export function detectEncodingTraits(sample, rawText = '') {
  /** @type {Set<string>} */
  const traits = new Set();
  if (rawText && UNICODE_ESCAPE_RE.test(rawText)) traits.add('unicode-escape');
  if (rawText && EMOJI_RE.test(rawText)) traits.add('emoji-utf8');
  if (rawText && /[^\x00-\x7F]/.test(rawText)) traits.add('non-ascii-utf8');

  let visited = 0;
  /** @param {unknown} v @param {number} depth */
  const scan = (v, depth) => {
    if (depth > 5 || visited > 200 || v === null || v === undefined) return;
    visited += 1;
    if (typeof v === 'string') {
      if (EMOJI_RE.test(v)) traits.add('emoji-utf8');
      if (/[^\x00-\x7F]/.test(v)) traits.add('non-ascii-utf8');
      if (UNICODE_ESCAPE_RE.test(v)) traits.add('unicode-escape');
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v.slice(0, MAX_ARRAY_ITEMS_TO_SAMPLE)) scan(item, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const val of Object.values(v).slice(0, 40)) scan(val, depth + 1);
    }
  };
  scan(sample, 0);
  return [...traits].sort();
}

/**
 * Infers a unified multi-sample JSON Schema and encoding trait set across all samples of an endpoint.
 * @param {unknown[]} samples
 * @param {{ rawTexts?: string[] }} [options]
 * @returns {{ schema: Record<string, any>, sampleCount: number, encodingTraits: string[] }}
 */
export function inferUnionSchemaFromSamples(samples = [], options = {}) {
  const list = Array.isArray(samples) ? samples.slice(0, MAX_UNION_SAMPLES) : [];
  /** @type {Record<string, any>} */
  let schema = {};
  /** @type {Set<string>} */
  const traits = new Set();

  for (let i = 0; i < list.length; i += 1) {
    const sample = list[i];
    schema = mergeInferredSchemas(schema, inferJsonSchemaFromSample(sample));
    const raw = Array.isArray(options.rawTexts) ? options.rawTexts[i] || '' : '';
    for (const tr of detectEncodingTraits(sample, raw)) traits.add(tr);
  }

  return {
    schema,
    sampleCount: list.length,
    encodingTraits: [...traits].sort(),
  };
}

/**
 * Builds `qa/knowledge/api-schemas.json` + actionable boundary/RBAC/empty-state/encoding-parity test suggestions
 * from all captured 2xx JSON exploration payloads grouped by endpoint (`METHOD /pathname`).
 * @param {string} qaDir
 * @param {Array<{ method: string, pathname: string, status: number, sample: unknown, rawText?: string }>} captures
 * @param {Record<string, any>} [topology]
 */
export function writeInferredApiSchemas(qaDir, captures = [], topology = {}) {
  /** @type {Map<string, { method: string, pathname: string, status: number, samples: unknown[], rawTexts: string[] }>} */
  const grouped = new Map();
  for (const cap of captures || []) {
    const method = String(cap.method || 'GET').toUpperCase();
    const pathname = cap.pathname || '/';
    const key = `${method} ${pathname}`;
    if (!grouped.has(key)) {
      if (grouped.size >= MAX_CAPTURED_ENDPOINTS) continue;
      grouped.set(key, { method, pathname, status: cap.status || 200, samples: [], rawTexts: [] });
    }
    const bucket = grouped.get(key);
    if (bucket && bucket.samples.length < MAX_UNION_SAMPLES) {
      bucket.samples.push(cap.sample);
      bucket.rawTexts.push(String(cap.rawText || ''));
    }
  }

  const byEndpoint = new Map();
  for (const [key, bucket] of grouped.entries()) {
    const union = inferUnionSchemaFromSamples(bucket.samples, { rawTexts: bucket.rawTexts });
    const schema = union.schema;
    const isListEndpoint =
      schema.type === 'array' ||
      Boolean(schema.properties?.items || schema.properties?.data?.type === 'array' || schema.properties?.list);
    const testSuggestions = ['contract-schema'];
    if (isListEndpoint) testSuggestions.push('empty-state', 'pagination-boundary');
    if (/\/(?:admin|users|orders|account|profile|settings)\b/i.test(bucket.pathname)) {
      testSuggestions.push('rbac-401-403');
    }
    if (union.encodingTraits.length > 0) {
      testSuggestions.push('unicode-emoji-parity');
    }
    byEndpoint.set(key, {
      endpoint: key,
      method: bucket.method,
      pathname: bucket.pathname,
      sampleStatus: bucket.status,
      sampleCount: union.sampleCount,
      encodingTraits: union.encodingTraits,
      responseSchema: schema,
      testSuggestions,
    });
  }

  for (const p of topology.pages || []) {
    if (Array.isArray(p.mutationButtons) && p.mutationButtons.length > 0) {
      const firstEp = (p.apisObserved || [])[0];
      if (firstEp) {
        const key = `POST ${firstEp}`;
        if (!byEndpoint.has(key)) {
          byEndpoint.set(key, {
            endpoint: key,
            method: 'POST',
            pathname: firstEp,
            sampleStatus: 201,
            sampleCount: 0,
            encodingTraits: [],
            responseSchema: { type: 'object' },
            testSuggestions: ['crud-happy-path', 'validation-400-422', 'idempotency-409'],
          });
        }
      }
    }
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    endpoints: [...byEndpoint.values()],
  };
  const knowledgeDir = path.join(qaDir, 'knowledge');
  fs.mkdirSync(knowledgeDir, { recursive: true });
  const outPath = path.join(knowledgeDir, 'api-schemas.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { outPath, count: payload.endpoints.length, endpoints: payload.endpoints };
}
