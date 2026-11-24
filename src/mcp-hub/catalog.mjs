// @ts-check
import { WORKBENCH_VERSION } from '../core/version.mjs';

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

export function getMcpPresetsSummary() {
  return {
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
}
