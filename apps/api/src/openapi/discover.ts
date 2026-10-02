/**
 * openapi/discover.ts — 路由发现：从 route-registry 路由表 + Express Router 栈
 * 还原「方法 + 完整路径 + defineRoute schema + 鉴权姿态」，作为 OpenAPI 文档的端点源。
 *
 * 只收 defineRoute 路由（handler 带 ROUTE_SCHEMA_META）——协议面（discord/deploy/lark/
 * dingtalk 回调、SSE、MCP 消息面）是原始 handler，自然落在 skipped 里，不进文档。
 * 非 defineRoute 路由记入 skipped（x-studio-undocumented 输出），覆盖缺口如实可见。
 */

import type { Router } from 'express';
import { ROUTE_SCHEMA_META, type RouteSchemaMeta } from '../core/http.js';
import { describeEntryAuth, type AuthPosture, type RouteEntry } from '../route-registry.js';

export interface DiscoveredRoute {
  /** 小写方法：get/post/put/patch/delete */
  method: string;
  /** 完整路径（Express 风格 :id 参数） */
  path: string;
  /** defineRoute 元数据（请求 schema + 成功状态码） */
  meta: RouteSchemaMeta;
  /** 鉴权姿态（registry entry 声明） */
  auth: AuthPosture;
  /** 挂载点（entry.path，分 tag 用） */
  mountPath: string;
  entryComment?: string;
}

export interface SkippedRoute {
  method: string;
  path: string;
  mountPath: string;
  entryComment?: string;
  reason: 'no-define-route' | 'unparsed-mount';
}

/** Express 5.2 Router.stack 的 layer 形状（内部结构，宽松声明；5.2 起无 layer.regexp，挂载匹配在 matchers 闭包内） */
interface ExpressLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: unknown }>;
  };
  handle?: { stack?: ExpressLayer[] };
  matchers?: Array<(input: string) => false | { path: string; params: Record<string, unknown> }>;
}

interface RouterLike {
  stack: ExpressLayer[];
}

/**
 * 静态嵌套挂载的路径提示表（Express 5.2 layer 不保留挂载路径字符串，只能探测不可还原）。
 * 签名 = 子路由首个 route 的路径。漂移防护：openapi 测试断言端点集合，签名失效（子路由
 * 首路由变了）→ 该挂载回退 unparsed-mount → 端点集合变化 → 测试红。
 */
const NESTED_MOUNT_HINTS: Array<{ mountPath: string; sub: string; signature: string }> = [
  { mountPath: '/api/v1/mcp', sub: '/admin', signature: '/tools' }, // mcp/routes.ts: router.use('/admin', requireAuth(), requireAdmin(), adminRoutes)
];

function firstRoutePath(router: RouterLike): string | undefined {
  return router.stack.find(l => l.route)?.route?.path;
}

function joinPath(prefix: string, path: string): string {
  if (path === '/') return prefix || '/';
  return `${prefix}${path}`;
}

/**
 * 嵌套 router 挂载点判别：
 * - 根挂载（router.use(sub)，仓内 harness/knowledge 全部实例）：matcher 仅精确命中 '/' → 前缀不变；
 * - 静态路径挂载：查 NESTED_MOUNT_HINTS（签名匹配）；
 * - 其余（含参数/通配挂载）：null，调用方记 skipped，不猜。
 */
export function probeNestedMount(layer: ExpressLayer, subRouter: RouterLike, mountPath: string): string | null {
  const matcher = layer.matchers?.[0];
  if (matcher && matcher('/') !== false && matcher('/studio-openapi-probe-nonexistent') === false) {
    return '/';
  }
  const signature = firstRoutePath(subRouter);
  const hint = NESTED_MOUNT_HINTS.find(h => h.mountPath === mountPath && h.signature === signature);
  return hint?.sub ?? null;
}

function metaOf(layer: NonNullable<ExpressLayer['route']>): RouteSchemaMeta | undefined {
  for (const { handle } of layer.stack) {
    const meta = (handle as Record<symbol, RouteSchemaMeta | undefined>)?.[ROUTE_SCHEMA_META];
    if (meta) return meta;
  }
  return undefined;
}

function walk(
  router: RouterLike,
  prefix: string,
  entry: RouteEntry,
  out: DiscoveredRoute[],
  skipped: SkippedRoute[],
): void {
  for (const layer of router.stack) {
    if (layer.route) {
      const path = joinPath(prefix, layer.route.path);
      const meta = metaOf(layer.route);
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        if (meta) {
          out.push({
            method,
            path,
            meta,
            auth: describeEntryAuth(entry),
            mountPath: entry.path,
            entryComment: entry.comment,
          });
        } else {
          skipped.push({ method, path, mountPath: entry.path, entryComment: entry.comment, reason: 'no-define-route' });
        }
      }
    } else if (layer.handle?.stack) {
      // 嵌套子路由（根挂载：harness 八子路由 / knowledge 五子路由；路径挂载：mcp /admin 走 hint 表）
      const subRouter = layer.handle as RouterLike;
      const sub = probeNestedMount(layer, subRouter, entry.path);
      if (sub === null) {
        skipped.push({ method: '*', path: `${prefix}/<nested>`, mountPath: entry.path, entryComment: entry.comment, reason: 'unparsed-mount' });
      } else {
        walk(subRouter, joinPath(prefix, sub), entry, out, skipped);
      }
    }
  }
}

export interface DiscoveryResult {
  routes: DiscoveredRoute[];
  skipped: SkippedRoute[];
}

/** 从路由表发现全部 defineRoute 端点（非 defineRoute 路由入 skipped）。 */
export function discoverRoutes(table: RouteEntry[]): DiscoveryResult {
  const routes: DiscoveredRoute[] = [];
  const skipped: SkippedRoute[] = [];
  for (const entry of table) {
    walk(entry.router as unknown as RouterLike, entry.path, entry, routes, skipped);
  }
  return { routes, skipped };
}

/** Express 风格路径参数 → OpenAPI 风格（/wu/:id → /wu/{id}） */
export function toOpenAPIPath(path: string): string {
  return path.replace(/:([^/]+)/g, '{$1}');
}
