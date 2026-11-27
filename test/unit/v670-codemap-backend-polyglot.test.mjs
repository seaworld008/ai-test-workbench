import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { indexRepositorySource } from '../../src/codemap.mjs';
import { extractBackendAndDbData } from '../../src/codemap/adapters.mjs';
import { compileDbEntityMatchers, correlateDbTablesForRoute } from '../../src/codemap/correlator.mjs';
import {
  extractPythonEndpointsAndEntities,
  maskPythonTripleQuotedStrings,
  normalizePythonRoutePath,
  stripPythonComments,
} from '../../src/codemap/python-extractor.mjs';

test('stripPythonComments and maskPythonTripleQuotedStrings handle strings, comments, and docstrings in O(N)', () => {
  const src = [
    '# app.router.add_get("/dead", dead)',
    'URL = "https://example.local/api#frag" # trailing comment with \'quote',
    'def demo():',
    '    """',
    '    Example docstring: @app.get("/fake-in-doc")',
    '    """',
    '    sql = """',
    '    CREATE TABLE IF NOT EXISTS ai_prompts (id INTEGER PRIMARY KEY)',
    '    """',
    '    return URL',
  ].join('\n');

  const stripped = stripPythonComments(src);
  assert.doesNotMatch(stripped, /\/dead/);
  assert.doesNotMatch(stripped, /trailing comment/);
  assert.match(stripped, /https:\/\/example\.local\/api#frag/);
  assert.match(stripped, /CREATE TABLE IF NOT EXISTS ai_prompts/);

  const masked = maskPythonTripleQuotedStrings(stripped);
  assert.doesNotMatch(masked, /\/fake-in-doc/);
  assert.doesNotMatch(masked, /CREATE TABLE/);
  assert.match(masked, /https:\/\/example\.local\/api#frag/);
  assert.equal(masked.split('\n').length, src.split('\n').length);
});

test('normalizePythonRoutePath normalizes FastAPI, Flask/Werkzeug, aiohttp regex, and Django params', () => {
  assert.equal(normalizePythonRoutePath('/api/v1/users/{user_id:int}?q=1#top'), '/api/v1/users/:user_id');
  assert.equal(normalizePythonRoutePath('/files/{file_path:path}'), '/files/:file_path');
  assert.equal(normalizePythonRoutePath('/items/{item_id:\\d{1,6}}'), '/items/:item_id');
  assert.equal(normalizePythonRoutePath('/alarm/alert/<int:alert_id>/'), '/alarm/alert/:alert_id');
  assert.equal(normalizePythonRoutePath('/docs/<string:slug>/<path:rest>/<id>'), '/docs/:slug/:rest/:id');
  assert.equal(normalizePythonRoutePath('/kind/<any(a, b):mode>'), '/kind/:mode');
  assert.equal(normalizePythonRoutePath('api/orders/(?P<order_id>[0-9]+)/'), '/api/orders/:order_id');
});

test('extractPythonEndpointsAndEntities parses aiohttp imperative, RouteTableDef, and ignores commented/docstring routes', () => {
  const py = `
from aiohttp import web

routes = web.RouteTableDef()

# app.router.add_get('/dead', dead_handler)
# @routes.get('/dead-dec')

def inspect():
    """
    @routes.post('/docstring-route')
    app.router.add_get('/docstring-imperative', fn)
    """
    note = "keep # hash"
    return web.get("dict_key_not_a_route")

@routes.delete('/api/alarms/{alarm_id}')
async def delete_alarm(request):
    return web.json_response({"ok": True})

def setup_routes(app):
    app.router.add_get('/api/hosts', list_hosts) # inline comment
    app.router.add_post('/api/hosts/{host_id:int}', update_host)
    app.router.add_route('*', '/api/proxy/{tail:.*}', proxy_handler)
    app.add_routes([
        web.post('/api/webhook', webhook_handler),
        web.view('/api/metrics', MetricsView),
    ])
`;

  const out = extractPythonEndpointsAndEntities({ relFile: 'alarm_svc/routes.py', text: py });
  const pairs = out.endpoints.map((e) => `${e.method} ${e.path} [${e.framework}]`);

  assert.ok(pairs.includes('GET /api/hosts [python-aiohttp]'));
  assert.ok(pairs.includes('POST /api/hosts/:host_id [python-aiohttp]'));
  assert.ok(pairs.includes('ANY /api/proxy/:tail [python-aiohttp]'));
  assert.ok(pairs.includes('POST /api/webhook [python-aiohttp]'));
  assert.ok(pairs.includes('ANY /api/metrics [python-aiohttp]'));
  assert.ok(pairs.includes('DELETE /api/alarms/:alarm_id [python-aiohttp]'));

  assert.equal(out.endpoints.some((e) => e.path.includes('dead') || e.path.includes('docstring')), false);
});

test('extractPythonEndpointsAndEntities parses FastAPI APIRouter prefixes, api_route methods, and websocket', () => {
  const py = `
from fastapi import APIRouter, Depends, FastAPI

app = FastAPI()
user_router = APIRouter(
    dependencies=[Depends(lambda: True)],
    prefix="/api/v1/users",
)

@user_router.get("/{user_id}")
async def get_user(user_id: int):
    return {"id": user_id}

@user_router.get("")
async def list_users():
    return []

@user_router.websocket("/ws/{room_id}")
async def user_ws(ws):
    pass

@app.api_route("/health", dependencies=[Depends(lambda: None)], methods=["GET", "HEAD"])
async def health():
    return {"ok": True}
`;

  const out = extractPythonEndpointsAndEntities({ relFile: 'ops_master/routers/users.py', text: py });
  const pairs = out.endpoints.map((e) => `${e.method} ${e.path} [${e.framework}]`);

  assert.ok(pairs.includes('GET /api/v1/users/:user_id [python-fastapi]'));
  assert.ok(pairs.includes('GET /api/v1/users [python-fastapi]'));
  assert.ok(pairs.includes('WS /api/v1/users/ws/:room_id [python-fastapi]'));
  assert.ok(pairs.includes('GET /health [python-fastapi]'));
  assert.ok(pairs.includes('HEAD /health [python-fastapi]'));
});

test('extractPythonEndpointsAndEntities parses Flask Blueprint url_prefix and multi-method routes', () => {
  const py = `
from flask import Blueprint

alarm_bp = Blueprint("alarm", __name__, url_prefix="/api/alarm")

@alarm_bp.route("/alert/<int:alert_id>", methods=["POST", "DELETE"])
def manage_alert(alert_id):
    return {}

@alarm_bp.route("/summary")
def summary():
    return {}
`;

  const out = extractPythonEndpointsAndEntities({ relFile: 'alarm_svc/views.py', text: py });
  const pairs = out.endpoints.map((e) => `${e.method} ${e.path} [${e.framework}]`);

  assert.ok(pairs.includes('POST /api/alarm/alert/:alert_id [python-flask]'));
  assert.ok(pairs.includes('DELETE /api/alarm/alert/:alert_id [python-flask]'));
  assert.ok(pairs.includes('ANY /api/alarm/summary [python-flask]'));
});

test('extractPythonEndpointsAndEntities parses Starlette Mount blocks, Route, WebSocketRoute without false positives', () => {
  const py = `
from starlette.routing import Mount, Route, WebSocketRoute

routes = [
    Mount(
        "/ai",
        routes=[
            Route("/chat", chat_endpoint, methods=["POST"]),
            Mount("/v2", routes=[Route("/stream/{session_id}", stream_endpoint, methods=["GET", "POST"])]),
            WebSocketRoute("/ws", ws_endpoint),
        ],
    ),
    Route("/healthz", health_endpoint),
]
`;

  const out = extractPythonEndpointsAndEntities({ relFile: 'ai_hub/routing.py', text: py });
  const pairs = out.endpoints.map((e) => `${e.method} ${e.path} [${e.framework}]`);

  assert.ok(pairs.includes('POST /ai/chat [python-starlette]'));
  assert.ok(pairs.includes('GET /ai/v2/stream/:session_id [python-starlette]'));
  assert.ok(pairs.includes('POST /ai/v2/stream/:session_id [python-starlette]'));
  assert.ok(pairs.includes('WS /ai/ws [python-starlette]'));
  assert.ok(pairs.includes('ANY /healthz [python-starlette]'));
  assert.equal(out.endpoints.some((e) => e.path === '/chat' || e.path === '/ws'), false);

  const unrelated = extractPythonEndpointsAndEntities({
    relFile: 'ai_hub/other.py',
    text: 'record = Route(name="not-starlette", target=1)\n',
  });
  assert.equal(unrelated.endpoints.length, 0);
});

test('extractPythonEndpointsAndEntities parses Django urls.py and skips admin/', () => {
  const py = `
from django.contrib import admin
from django.urls import include, path, re_path
from . import views

urlpatterns = [
    path("admin/", admin.site.urls),
    path("", include("alarm_svc.urls")),
    path("api/orders/<int:order_id>/", views.order_detail),
    path("api/admin/audit-logs/", views.audit_logs),
    re_path(r"^api/nodes/(?P<node_slug>[a-z0-9-]+)/$", views.node_detail),
]
`;

  const out = extractPythonEndpointsAndEntities({ relFile: 'ops_master/urls.py', text: py });
  const pairs = out.endpoints.map((e) => `${e.method} ${e.path} [${e.framework}]`);

  assert.ok(pairs.includes('ANY /api/orders/:order_id [python-django]'));
  assert.ok(pairs.includes('ANY /api/admin/audit-logs [python-django]'));
  assert.ok(pairs.includes('ANY /api/nodes/:node_slug [python-django]'));
  assert.equal(out.endpoints.some((e) => e.path === '/admin' || e.path === '/'), false);
});

test('Python ORM/DDL entities and Node .cjs / app.all / TypeORM @Entity variants extract cleanly', () => {
  const pyModels = `
class HostRecord(Base):
    __tablename__ = "ops_hosts"

class AlarmLog(models.Model):
    class Meta:
        db_table = "alarm_logs"

# CREATE TABLE IF NOT EXISTS commented_out_tbl (id INT)
DDL = """
CREATE TABLE IF NOT EXISTS ai_sessions (
    id INTEGER PRIMARY KEY
)
"""
`;
  const pyRes = extractBackendAndDbData('ops_master/models.py', pyModels);
  assert.deepEqual(
    pyRes.entities.map((e) => `${e.table}:${e.source}`),
    ['ops_hosts:sqlalchemy', 'alarm_logs:django-orm', 'ai_sessions:python-sql']
  );

  const cjsSrc = `
const router = require('express').Router();
router.get('/api/ops/ping', (_req, res) => res.send('ok'));
app.all('/api/ops/gateway/*', proxy);
`;
  const cjsRes = extractBackendAndDbData('ops_master/server.cjs', cjsSrc);
  assert.deepEqual(
    cjsRes.endpoints.map((e) => `${e.method} ${e.path}`),
    ['GET /api/ops/ping', 'ANY /api/ops/gateway/*']
  );

  const typeormSrc = `
@Entity()
@Index(['name'])
export class AlarmRule {
  id!: number;
}

@Entity({ name: 'users' })
class UserModel {}

@Entity('ops_clusters')
export class OpsCluster {}
`;
  const ormRes = extractBackendAndDbData('ops_master/entities.ts', typeormSrc);
  assert.deepEqual(
    ormRes.entities.map((e) => `${e.table}:${e.source}`),
    ['alarm_rule:typeorm', 'users:typeorm', 'ops_clusters:typeorm']
  );
});

test('indexRepositorySource integrates Python polyglot and Node .cjs/TypeORM adapters end-to-end', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-polyglot-'));
  try {
    fs.mkdirSync(path.join(repoDir, 'ai_hub'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'ops_master'), { recursive: true });

    fs.writeFileSync(
      path.join(repoDir, 'ai_hub', 'app.py'),
      `from fastapi import APIRouter
hub_router = APIRouter(prefix="/api/hub")
@hub_router.post("/infer/{model_id}")
async def infer(model_id: str): pass
`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, 'ops_master', 'gateway.js'),
      `app.all('/api/ops/health', (req, res) => res.end('ok'));\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, 'ops_master', 'model.ts'),
      `@Entity()\nexport class AlertPolicy {}\n`,
      'utf8'
    );

    const idx = indexRepositorySource(repoDir);
    assert.ok(idx.backendEndpoints.some((e) => e.method === 'POST' && e.path === '/api/hub/infer/:model_id' && e.framework === 'python-fastapi'));
    assert.ok(idx.backendEndpoints.some((e) => e.method === 'ANY' && e.path === '/api/ops/health' && e.framework === 'express/fastify'));
    assert.ok(idx.dbEntities.some((d) => d.table === 'alert_policy' && d.source === 'typeorm'));

    // Also verify .cjs directly via backend-adapters (extractBackendAndDbData)
    const cjsDirect = extractBackendAndDbData(
      'ops_master/gateway.cjs',
      `app.all('/api/ops/legacy', (req, res) => res.end('ok'));\n`
    );
    assert.ok(cjsDirect.endpoints.some((e) => e.method === 'ANY' && e.path === '/api/ops/legacy' && e.framework === 'express/fastify'));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('SQL CREATE TABLE DDL extractor strips schema prefixes and rejects prose/reserved-keyword noise', () => {
  const ddl = `
    CREATE TABLE "public"."users" (id int);
    CREATE TABLE public."orders" (id int);
    CREATE TEMP TABLE tmp_items AS SELECT 1;
    CREATE TABLE IF (id int);
    CREATE TABLE x (id int);
    -- prose noise:
    -- create table if missing
    -- create table x for test
  `;
  const sqlRes = extractBackendAndDbData('migrations/001_init.sql', ddl);
  assert.deepEqual(
    sqlRes.entities.map((e) => e.table),
    ['users', 'orders', 'tmp_items']
  );

  const proseSqlRes = extractBackendAndDbData('migrations/notes.sql', 'create table if missing\ncreate table x for test\n');
  assert.equal(proseSqlRes.entities.length, 0);

  const pyDdl = `
    MIGRATION = """
    CREATE TABLE "public"."users" (id int);
    CREATE TABLE public."orders" (id int);
    CREATE TEMP TABLE tmp_items AS SELECT 1;
    """
    DOC = "create table if missing; create table x for test"
  `;
  const pyRes = extractBackendAndDbData('ops_master/migrations.py', pyDdl);
  assert.deepEqual(
    pyRes.entities.map((e) => e.table),
    ['users', 'orders', 'tmp_items']
  );

  const pyProseOnly = extractBackendAndDbData('ops_master/docs.py', 'note = "create table if missing"\nnote2 = "create table x for test"\n');
  assert.equal(pyProseOnly.entities.length, 0);
});

test('O(1) indexed correlateDbTablesForRoute preserves exact parity with unindexed matcher scan', () => {
  const dbEntities = [
    { table: 'UserOrder', file: 'src/entities/UserOrder.java' },
    { table: 'public.audit_log', file: 'src/entities/AuditLog.java' },
    { table: 'user', file: 'src/entities/User.java' },
    { table: 'ops_cluster', file: 'src/entities/OpsCluster.java' },
    { table: 'alert_rules', file: 'src/entities/AlertRule.java' },
  ];
  const backendFileTexts = {
    'src/ctrl/OrderController.java': 'return repo.query(userOrder, public.audit_log, user);',
    'src/ctrl/OpsClusterController.java': 'return ok();',
  };
  const compiled = compileDbEntityMatchers(dbEntities);
  const manualUnindexed = compiled.map((m) => ({ ...m }));

  const cases = [
    { route: '/orders', linkedApis: ['/api/v1/userorder'], linkedBackendFiles: ['src/ctrl/OrderController.java'] },
    { route: '/clusters', linkedApis: ['/api/ops/status'], linkedBackendFiles: ['src/ctrl/OpsClusterController.java'] },
    { route: '/alert_rule', linkedApis: [], linkedBackendFiles: ['src/entities/User.java'] },
  ];

  for (const entry of cases) {
    const fast = correlateDbTablesForRoute(entry, dbEntities, backendFileTexts, compiled).sort();
    const fallback = correlateDbTablesForRoute(entry, dbEntities, backendFileTexts, manualUnindexed).sort();
    assert.deepEqual(fast, fallback);
  }
  assert.deepEqual(
    correlateDbTablesForRoute(cases[0], dbEntities, backendFileTexts, compiled).sort(),
    ['UserOrder', 'public.audit_log']
  );
  assert.deepEqual(
    correlateDbTablesForRoute(cases[1], dbEntities, backendFileTexts, compiled).sort(),
    ['ops_cluster']
  );
  assert.deepEqual(
    correlateDbTablesForRoute(cases[2], dbEntities, backendFileTexts, compiled).sort(),
    ['alert_rules', 'user']
  );
});
