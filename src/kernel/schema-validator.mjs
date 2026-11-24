/**
 * Zero-dependency JSON Schema (Draft-07 / OpenAPI 3.0 & 3.1 subset) contract validator (`P-04`).
 * Shared by `tests/fixtures/base.ts` (`expectApiContract`) and CLI contract verification.
 */

/**
 * @param {string} refStr
 * @param {Record<string, any>} rootDoc
 * @returns {Record<string, any> | null}
 */
function resolveRef(refStr, rootDoc) {
  if (!refStr || typeof refStr !== 'string' || !refStr.startsWith('#/')) return null;
  const parts = refStr
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = rootDoc;
  for (const seg of parts) {
    if (!cur || typeof cur !== 'object' || !(seg in cur)) return null;
    cur = cur[seg];
  }
  return cur;
}

/**
 * @param {unknown} value
 * @param {string} expectedType
 * @returns {boolean}
 */
function matchesJsonType(value, expectedType) {
  switch (expectedType) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true;
  }
}

/**
 * Validates `value` against `schema`, returning `{ ok, errors }`.
 * @param {unknown} value
 * @param {Record<string, any>} schema
 * @param {{ rootDoc?: Record<string, any>, path?: string }} [ctx]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateJsonSchema(value, schema, ctx = {}) {
  const rootDoc = ctx.rootDoc || schema;
  const curPath = ctx.path || '$';
  /** @type {string[]} */
  const errors = [];

  if (!schema || typeof schema !== 'object') {
    return { ok: true, errors };
  }

  if (schema.$ref) {
    const target = resolveRef(schema.$ref, rootDoc);
    if (!target) {
      return { ok: false, errors: [`${curPath}: unresolved schema $ref "${schema.$ref}"`] };
    }
    return validateJsonSchema(value, target, { rootDoc, path: curPath });
  }

  if (schema.nullable === true && value === null) {
    return { ok: true, errors };
  }

  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      const r = validateJsonSchema(value, sub, { rootDoc, path: curPath });
      errors.push(...r.errors);
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const okAny = schema.anyOf.some((sub) => validateJsonSchema(value, sub, { rootDoc, path: curPath }).ok);
    if (!okAny) errors.push(`${curPath}: value did not match anyOf schemas`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((sub) => validateJsonSchema(value, sub, { rootDoc, path: curPath }).ok);
    if (matches.length !== 1) {
      errors.push(`${curPath}: expected exactly 1 oneOf schema match, got ${matches.length}`);
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${curPath}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${curPath}: value ${JSON.stringify(value)} not in enum [${schema.enum.join(', ')}]`);
  }

  if (schema.type) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const typeOk = allowedTypes.some((t) => matchesJsonType(value, t));
    if (!typeOk) {
      errors.push(`${curPath}: expected type ${allowedTypes.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
      return { ok: false, errors };
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${curPath}: string length ${value.length} < minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${curPath}: string length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === 'string') {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push(`${curPath}: string "${value}" does not match pattern /${schema.pattern}/`);
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${curPath}: number ${value} < minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${curPath}: number ${value} > maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${curPath}: array length ${value.length} < minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${curPath}: array length ${value.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, idx) => {
        const sub = validateJsonSchema(item, schema.items, { rootDoc, path: `${curPath}[${idx}]` });
        errors.push(...sub.errors);
      });
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = /** @type {Record<string, unknown>} */ (value);
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in obj) || obj[reqKey] === undefined) {
          errors.push(`${curPath}: missing required property "${reqKey}"`);
        }
      }
    }
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const [k, propSchema] of Object.entries(props)) {
      if (k in obj && obj[k] !== undefined) {
        const sub = validateJsonSchema(obj[k], propSchema, { rootDoc, path: `${curPath}.${k}` });
        errors.push(...sub.errors);
      }
    }
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in props)) {
          errors.push(`${curPath}: unexpected additional property "${k}"`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Extracts response schema for `(routePath, method, statusCode)` from an OpenAPI 3.x document.
 * @param {Record<string, any>} openApiDoc
 * @param {string} routePath
 * @param {string} [method]
 * @param {number} [statusCode]
 */
export function extractOpenApiResponseSchema(openApiDoc, routePath, method = 'get', statusCode = 200) {
  const paths = openApiDoc?.paths || {};
  const pathObj = paths[routePath];
  if (!pathObj) return null;
  const op = pathObj[String(method || 'get').toLowerCase()];
  if (!op?.responses) return null;
  const resp = op.responses[String(statusCode)] || op.responses.default;
  if (!resp) return null;
  const resolvedResp = resp.$ref ? resolveRef(resp.$ref, openApiDoc) : resp;
  const content = resolvedResp?.content || {};
  const jsonMedia = content['application/json'] || Object.values(content)[0];
  return jsonMedia?.schema || null;
}
