// @ts-check
import { convertBracketSegment, normalizeRoutePath } from './route-matcher.mjs';
import { extractMybatisXmlEntities, extractSpringEndpointsAndEntities } from './spring-extractor.mjs';

/**
 * @typedef {{ method: string, path: string, file: string, framework: string, packageName?: string, packagePrefixes?: string[], aliasedPaths?: string[] }} BackendEndpoint
 * @typedef {{ table: string, file: string, source: string, namespace?: string }} DbEntity
 * @typedef {{ relFile: string, packageName: string, className: string, fqcn: string, imports: string[], superTypes: string[], fieldTypes: string[], isController: boolean, isService: boolean, isMapper: boolean, isEntity: boolean }} JavaFileMeta
 * @typedef {{ file: string, namespace: string, tables: string[] }} MybatisMapperMeta
 * @typedef {{ relFile: string, ext: string, text: string }} BackendAdapterContext
 * @typedef {{ endpoints?: BackendEndpoint[], entities?: DbEntity[], javaMeta?: JavaFileMeta | null, mybatisMapper?: MybatisMapperMeta | null }} BackendAdapterResult
 * @typedef {{ id: string, description?: string, extract: (ctx: BackendAdapterContext) => BackendAdapterResult | null | undefined }} BackendCodeMapAdapter
 */

/** @type {BackendCodeMapAdapter[]} */
export const BUILTIN_BACKEND_ADAPTERS = [
  {
    id: 'meta-framework-api',
    description: 'Next.js App API routes & SvelteKit +server endpoints',
    extract({ relFile }) {
      /** @type {BackendEndpoint[]} */
      const endpoints = [];
      const nextApi = relFile.match(/^(?:src\/)?app\/(api\/.+)\/route\.[jt]sx?$/i);
      if (nextApi) {
        const converted = nextApi[1].split('/').map(convertBracketSegment).join('/');
        endpoints.push({ method: 'ANY', path: normalizeRoutePath(`/${converted}`), file: relFile, framework: 'nextjs-api' });
      }
      const skApi = relFile.match(/^(?:src\/)?routes\/(api(?:\/.*)?)\/\+server\.[jt]s$/i);
      if (skApi) {
        const converted = skApi[1]
          .split('/')
          .filter((s) => s && !s.startsWith('('))
          .map(convertBracketSegment)
          .join('/');
        endpoints.push({ method: 'ANY', path: normalizeRoutePath(`/${converted}`), file: relFile, framework: 'sveltekit-api' });
      }
      return { endpoints };
    },
  },
  {
    id: 'spring',
    description: 'Java/Kotlin Spring MVC mappings (class header/body split, @FeignClient skip) & JPA/MyBatis entities',
    extract({ relFile, ext, text }) {
      return extractSpringEndpointsAndEntities(relFile, ext, text);
    },
  },
  {
    id: 'mybatis-xml',
    description: 'MyBatis *Mapper.xml namespace & SQL table entity extractor',
    extract({ relFile, ext, text }) {
      const out = extractMybatisXmlEntities(relFile, ext, text);
      if (!out) return null;
      return { entities: out.entities, mybatisMapper: out.mapper };
    },
  },
  {
    id: 'node-backend',
    description: 'Express/Fastify/Hono, raw Node HTTP, NestJS & TypeORM @Entity',
    extract({ relFile, ext, text }) {
      if (ext !== '.ts' && ext !== '.js' && ext !== '.mjs') return null;
      /** @type {BackendEndpoint[]} */
      const endpoints = [];
      /** @type {DbEntity[]} */
      const entities = [];
      const ctrlMatch = text.match(/@Controller\s*\(\s*['"]([^'"]*)['"]/);
      const ctrlPrefix = ctrlMatch ? `/${ctrlMatch[1].replace(/^\/|\/$/g, '')}` : '';
      for (const m of text.matchAll(/\b(?:app|router|api)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
        endpoints.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'express/fastify' });
      }
      for (const m of text.matchAll(/\bpathname\s*===\s*['"`](\/[^'"`]+)['"`]/g)) {
        if (m[1].startsWith('/api/')) {
          endpoints.push({ method: 'ANY', path: normalizeRoutePath(m[1]), file: relFile, framework: 'node-http' });
        }
      }
      for (const m of text.matchAll(/@(Get|Post|Put|Delete|Patch)\s*\(\s*['"]([^'"]*)['"]/g)) {
        endpoints.push({
          method: m[1].toUpperCase(),
          path: normalizeRoutePath(`${ctrlPrefix}/${m[2].replace(/^\//, '')}`),
          file: relFile,
          framework: 'nestjs',
        });
      }
      for (const m of text.matchAll(/@Entity\s*\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
        entities.push({ table: m[1], file: relFile, source: 'typeorm' });
      }
      return { endpoints, entities };
    },
  },
  {
    id: 'drizzle-orm',
    description: 'Drizzle ORM pgTable / mysqlTable / sqliteTable schema definitions',
    extract({ relFile, ext, text }) {
      if (ext !== '.ts' && ext !== '.js' && ext !== '.mjs') return null;
      /** @type {DbEntity[]} */
      const entities = [];
      for (const m of text.matchAll(/\b(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
        entities.push({ table: m[1], file: relFile, source: 'drizzle' });
      }
      return { entities };
    },
  },
  {
    id: 'python',
    description: 'Python FastAPI / Flask / Blueprint route decorators',
    extract({ relFile, ext, text }) {
      if (ext !== '.py') return null;
      /** @type {BackendEndpoint[]} */
      const endpoints = [];
      for (const m of text.matchAll(/@(?:app|router|bp)\.(get|post|put|delete|patch|route)\s*\(\s*['"]([^'"]+)['"]/g)) {
        const cleanPath = normalizeRoutePath(m[2]).replace(/\{([^}]+)\}/g, ':$1');
        endpoints.push({ method: m[1] === 'route' ? 'ANY' : m[1].toUpperCase(), path: cleanPath, file: relFile, framework: 'python' });
      }
      return { endpoints };
    },
  },
  {
    id: 'go',
    description: 'Go Gin/Echo/Chi route calls & net/http HandleFunc (incl. Go 1.22 method prefixes)',
    extract({ relFile, ext, text }) {
      if (ext !== '.go') return null;
      /** @type {BackendEndpoint[]} */
      const endpoints = [];
      for (const m of text.matchAll(/\b(?:r|router|e|g|api|v\d+|mux)\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["']([^"']+)["']/g)) {
        endpoints.push({
          method: m[1].toUpperCase(),
          path: normalizeRoutePath(m[2]).replace(/\{([^}]+)\}/g, ':$1'),
          file: relFile,
          framework: 'go',
        });
      }
      for (const m of text.matchAll(/\b(?:http|mux)\.HandleFunc\s*\(\s*["']([^"']+)["']/g)) {
        const raw = m[1].trim();
        const pref = raw.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)$/i);
        const method = pref ? pref[1].toUpperCase() : 'ANY';
        const routePart = pref ? pref[2] : raw;
        endpoints.push({
          method,
          path: normalizeRoutePath(routePart).replace(/\{([^}]+)\}/g, ':$1'),
          file: relFile,
          framework: 'go-http',
        });
      }
      return { endpoints };
    },
  },
  {
    id: 'php',
    description: 'PHP Laravel / ThinkPHP Route::get|post|put|delete|any',
    extract({ relFile, ext, text }) {
      if (ext !== '.php') return null;
      /** @type {BackendEndpoint[]} */
      const endpoints = [];
      for (const m of text.matchAll(/Route::(get|post|put|delete|any)\s*\(\s*['"]([^'"]+)['"]/g)) {
        endpoints.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'php' });
      }
      return { endpoints };
    },
  },
  {
    id: 'prisma',
    description: 'Prisma schema model declarations',
    extract({ relFile, ext, text }) {
      if (ext !== '.prisma') return null;
      /** @type {DbEntity[]} */
      const entities = [];
      for (const m of text.matchAll(/^\s*model\s+([A-Za-z0-9_]+)\s*\{/gm)) {
        entities.push({ table: m[1], file: relFile, source: 'prisma' });
      }
      return { entities };
    },
  },
  {
    id: 'sql',
    description: 'SQL CREATE TABLE DDL declarations',
    extract({ relFile, ext, text }) {
      if (ext !== '.sql') return null;
      /** @type {DbEntity[]} */
      const entities = [];
      for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_.]+)[`"']?/gi)) {
        entities.push({ table: m[1], file: relFile, source: 'sql' });
      }
      return { entities };
    },
  },
];
