/**
 * OpenAPI 生成探针（tsx 子进程侧，由 openapi.test.ts spawn 执行；不是测试，不被 vitest 收集）。
 *
 * 与 route-registry-auth.probe.ts 同管线（生产 bootstrap 同款模块解析）。断言：
 * 1. discover 全量：每条 defineRoute 路由都进了 doc.paths；
 * 2. response-map 防漂移：映射键 ⊆ 实际端点；
 * 3. 结构合法：openapi 3.0.3 / 逐端点参数、请求体、响应壳、鉴权语义；
 * 4. 协议面排除：discord/deploy/SSE/MCP 消息面不进 paths；
 * 5. /api/docs 挂载冒烟：express app registerRoutes 后实际 HTTP 命中 JSON + UI 页。
 * 任一断言失败 → exit 1（消息带定位）。
 */
import express from 'express';
import { buildRouteTable } from '../../route-registry.js';
import { discoverRoutes, toOpenAPIPath } from '../discover.js';
import { buildOpenApiDocument } from '../build.js';
import { RESPONSE_MAP } from '../response-map.js';
import { mountApiDocs } from '../index.js';

function fail(label: string, detail: string): never {
  console.error(`[openapi] FAIL ${label}: ${detail}`);
  process.exit(1);
}

/** doc.paths 上取的 operation（宽松声明，只到断言需要的深度） */
interface OpShape {
  parameters?: Array<{ name: string; in: string }>;
  requestBody?: { content: { 'application/json': { schema: { required?: string[] } } } };
  responses: Record<string, { content?: { 'application/json': { schema: JsonSchema } } }>;
  security?: unknown;
}
interface JsonSchema {
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

async function main(): Promise<void> {
  const table = await buildRouteTable();
  const { routes, skipped } = discoverRoutes(table);
  const doc = buildOpenApiDocument(routes, skipped);

  // ── 结构 ──
  if (doc.openapi !== '3.0.3') fail('结构', `openapi 版本字段异常: ${doc.openapi}`);
  if (!doc.info || !doc.paths || !doc.components) fail('结构', 'info/paths/components 缺失');
  if (routes.length < 200) fail('discover', `端点数异常偏少: ${routes.length}`);

  // ── 全量覆盖：每条 defineRoute 路由都进 paths ──
  for (const r of routes) {
    const p = toOpenAPIPath(r.path);
    const op = (doc.paths[p] as Record<string, unknown> | undefined)?.[r.method];
    if (!op) fail('覆盖', `${r.method.toUpperCase()} ${r.path} 未进 doc.paths`);
  }

  // ── response-map 防漂移：映射键 ⊆ 实际端点 ──
  const routeKeys = new Set(routes.map(r => `${r.method.toUpperCase()} ${r.path}`));
  for (const key of Object.keys(RESPONSE_MAP)) {
    if (!routeKeys.has(key)) fail('response-map', `映射键无对应路由: ${key}`);
  }

  // ── 逐端点抽查 ──
  const getOp = (method: string, path: string): OpShape => {
    const op = (doc.paths[toOpenAPIPath(path)] as Record<string, OpShape> | undefined)?.[method];
    if (!op) fail('抽查', `${method.toUpperCase()} ${path} 缺失`);
    return op;
  };

  // GET /api/v1/workunits：query 参数 + 分页响应壳（response-map 生效）+ open 无 security
  {
    const op = getOp('get', '/api/v1/workunits');
    for (const q of ['page', 'limit', 'status']) {
      if (!op.parameters?.some(p => p.name === q && p.in === 'query')) fail('workunits 列表', `缺 query 参数 ${q}`);
    }
    const schema = op.responses['200'].content?.['application/json'].schema;
    if (!schema?.properties?.data?.items?.properties?.id) fail('workunits 列表', '分页响应壳未映射到 WorkUnit 形状');
    if (op.security) fail('workunits 列表', 'open 端点不应有 security');
  }

  // POST /api/v1/workunits：body 校验形状 + authNotGuest 语义（security + 401 + 403）
  {
    const op = getOp('post', '/api/v1/workunits');
    if (!op.requestBody?.content?.['application/json']?.schema?.required?.includes('scope')) {
      fail('workunits 创建', 'requestBody 缺 required scope');
    }
    if (!op.security) fail('workunits 创建', 'authNotGuest 端点应有 security');
    if (!op.responses['401'] || !op.responses['403']) fail('workunits 创建', 'authNotGuest 应有 401+403 响应');
  }

  // admin 端点：GET /api/v1/monitoring/stats → 401+403
  {
    const op = getOp('get', '/api/v1/monitoring/stats');
    if (!op.responses['401'] || !op.responses['403']) fail('monitoring/stats', 'admin 端点应有 401+403');
  }

  // localhost 端点：GET /api/knowledge/sync-status → 403、无 bearer security
  {
    const op = getOp('get', '/api/knowledge/sync-status');
    if (!op.responses['403']) fail('knowledge sync-status', 'localhost 端点应有 403');
    if (op.security) fail('knowledge sync-status', 'localhost 端点不应有 bearer security');
  }

  // 204：DELETE /api/v1/workunits/:id 无响应体
  {
    const op = getOp('delete', '/api/v1/workunits/:id');
    if (!op.responses['204'] || op.responses['204'].content) fail('workunits 删除', '204 应无响应体');
  }

  // 嵌套挂载：harness 子路由与 mcp /admin 已解析
  getOp('get', '/api/v1/harness/traces');
  getOp('get', '/api/v1/mcp/admin/tools');
  getOp('post', '/api/knowledge/upsert');

  // ── 协议面排除 ──
  for (const p of Object.keys(doc.paths)) {
    if (p.startsWith('/api/v1/discord') || p.startsWith('/api/v1/deploy')) fail('协议面', `${p} 不应进文档`);
    if (p === '/api/v1/events/stream' || p === '/api/v1/mcp' || p.startsWith('/api/v1/mcp/sse') || p.startsWith('/api/v1/mcp/messages') || p.startsWith('/api/v1/mcp/external')) {
      fail('协议面', `${p} 不应进文档`);
    }
  }
  // skipped 清单如实输出在 x-studio-undocumented
  const undocumented = doc['x-studio-undocumented'] as Array<{ path: string }>;
  if (!undocumented.some(s => s.path === '/api/v1/events/stream')) fail('undocumented', 'SSE 应列在 x-studio-undocumented');

  // ── JSON 稳定（无循环引用/undefined 键）──
  const roundTrip = JSON.parse(JSON.stringify(doc)) as { openapi: string };
  if (roundTrip.openapi !== '3.0.3') fail('JSON', 'round-trip 失败');

  // ── 挂载冒烟：express app + registerRoutes 同款装配，实际 HTTP 命中 ──
  {
    const app = express();
    app.use(express.json());
    for (const entry of table) {
      if (entry.middleware?.length) app.use(entry.path, ...entry.middleware, entry.router);
      else app.use(entry.path, entry.router);
    }
    mountApiDocs(app, table);
    const server = await new Promise<import('http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/docs`);
      if (res.status !== 200) fail('挂载', `/api/docs 状态码 ${res.status}`);
      const body = await res.json() as { openapi?: string; paths?: Record<string, unknown> };
      if (body.openapi !== '3.0.3' || !body.paths || Object.keys(body.paths).length < 100) {
        fail('挂载', '/api/docs 返回体不是合法 OpenAPI');
      }
      const ui = await fetch(`http://127.0.0.1:${port}/api/docs/ui`);
      if (ui.status !== 200 || !(await ui.text()).includes('swagger-ui')) {
        fail('挂载', '/api/docs/ui 未返回 Swagger UI 页');
      }
    } finally {
      server.close();
    }
  }

  console.log(`[openapi] OK: ${routes.length} 端点全量进文档，response-map 映射 ${Object.keys(RESPONSE_MAP).length} 键无漂移，/api/docs 冒烟通过`);
  process.exit(0);
}

void main();
