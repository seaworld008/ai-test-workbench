// @ts-check
import fs from 'node:fs';
import path from 'node:path';

const MAX_CAPTURED_ENDPOINTS = 60;

/**
 * Infers a compact JSON Schema draft object from a runtime JSON sample value (`WU-04`).
 * @param {unknown} val
 * @param {number} [depth]
 * @returns {Record<string, any>}
 */
export function inferJsonSchemaFromSample(val, depth = 0) {
  if (val === null) return { type: 'null' };
  if (Array.isArray(val)) {
    if (val.length === 0 || depth >= 4) return { type: 'array', items: {} };
    return { type: 'array', items: inferJsonSchemaFromSample(val[0], depth + 1) };
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
 * Builds `qa/knowledge/api-schemas.json` + actionable boundary/RBAC/empty-state test suggestions
 * from captured 2xx JSON exploration payloads.
 * @param {string} qaDir
 * @param {Array<{ method: string, pathname: string, status: number, sample: unknown }>} captures
 * @param {Record<string, any>} [topology]
 */
export function writeInferredApiSchemas(qaDir, captures = [], topology = {}) {
  const byEndpoint = new Map();
  for (const cap of captures.slice(0, MAX_CAPTURED_ENDPOINTS)) {
    const key = `${String(cap.method || 'GET').toUpperCase()} ${cap.pathname || '/'}`;
    if (!byEndpoint.has(key)) {
      const schema = inferJsonSchemaFromSample(cap.sample);
      const isListEndpoint =
        schema.type === 'array' ||
        Boolean(schema.properties?.items || schema.properties?.data?.type === 'array' || schema.properties?.list);
      const testSuggestions = ['contract-schema'];
      if (isListEndpoint) testSuggestions.push('empty-state', 'pagination-boundary');
      if (/\/(?:admin|users|orders|account|profile|settings)\b/i.test(cap.pathname || '')) {
        testSuggestions.push('rbac-401-403');
      }
      byEndpoint.set(key, {
        endpoint: key,
        method: String(cap.method || 'GET').toUpperCase(),
        pathname: cap.pathname || '/',
        sampleStatus: cap.status || 200,
        responseSchema: schema,
        testSuggestions,
      });
    }
  }

  for (const p of topology.pages || []) {
    if (Array.isArray(p.mutationButtons) && p.mutationButtons.length > 0) {
      // Suggest 409 duplicate / 422 validation checks for discovered mutation forms/buttons
      const firstEp = (p.apisObserved || [])[0];
      if (firstEp) {
        const key = `POST ${firstEp}`;
        if (!byEndpoint.has(key)) {
          byEndpoint.set(key, {
            endpoint: key,
            method: 'POST',
            pathname: firstEp,
            sampleStatus: 201,
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
