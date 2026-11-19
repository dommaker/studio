/**
 * route-registry 鉴权姿态探针（tsx 子进程侧，P2-e 声明式统一；#695 派生式改造）
 *
 * 由 route-registry-auth.test.ts spawn 执行（本文件不是测试，不被 vitest 收集）。
 * 探针在 tsx 进程内跑 buildRouteTable()——与生产 bootstrap 同一模块管线
 * （vitest 进程内直跑会把 node_modules 链路外置成原生 ESM，踩目录导入解析差异，
 * 故探针落 tsx 子进程保生产保真）。
 *
 * 派生式断言（#695）：不再逐模块手写 case——逐 entry 用 route-registry 的
 * describeEntryAuth 派生姿态声明，再功能验证该 entry 的 middleware 行为与姿态一致：
 * - open：无 entry 级 middleware；
 * - auth（requireAuth）：恰 1 个 middleware，无 token → 401；
 * - authNotGuest：恰 2 个，第一无 token → 401，第二对 Operator 放行；
 * - admin：恰 2 个，第一无 token → 401，第二对 legacy 身份 → 403；
 * - localhost：恰 1 个，非回环来源 → 403，回环放行。
 * 有 middleware 却派生不出姿态（describeEntryAuth 兜底 open）= 绕过姿态声明数组 → fail。
 * 注册顺序约束不在此断言（buildRouteTable 内 assertRouteOrder 启动断言 +
 * route-registry-order.test.ts 已覆盖）。任一断言失败 → exit 1（消息带 entry 标签）。
 */
import type { RequestHandler } from 'express';
import { buildRouteTable, describeEntryAuth, type AuthPosture, type RouteEntry } from '../route-registry.js';

process.env.STUDIO_AUTH = 'on';

async function main(): Promise<void> {
const table = await buildRouteTable();

function mockRes() {
  const res: Record<string, unknown> = {};
  res.status = (...args: unknown[]) => { res.statusCode = args[0]; return res; };
  res.json = () => res;
  return res as { statusCode?: number } & Record<string, unknown>;
}

async function runMw(mw: RequestHandler, req: Record<string, unknown>): Promise<{ statusCode?: number; passed: boolean }> {
  const res = mockRes();
  let passed = false;
  await mw(req as never, res as never, () => { passed = true; });
  return { statusCode: res.statusCode, passed };
}

function fail(label: string, detail: string): never {
  console.error(`[route-registry-auth] FAIL ${label}: ${detail}`);
  process.exit(1);
}

const UNAUTHENTICATED = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
const OPERATOR = {
  headers: {},
  user: { id: 'u1', role: 'Admin', actorType: 'Operator', name: 'M' },
  session: { userId: 'u1' },
};
const LEGACY_MEMBER = {
  headers: {},
  user: { id: 'u2', role: 'Member', name: 'Legacy' },
  session: { userId: 'u2' },
};

async function expectPosture(entry: RouteEntry, posture: AuthPosture, label: string): Promise<void> {
  const mw = entry.middleware ?? [];
  if (posture === 'open') {
    if (mw.length !== 0) fail(label, `open entry 不应有 entry 级 middleware（实 ${mw.length} 个）`);
    return;
  }
  if (posture === 'localhost') {
    if (mw.length !== 1) fail(label, `localhost entry 应恰 1 个 middleware（实 ${mw.length} 个）`);
    const remote = await runMw(mw[0], { headers: {}, socket: { remoteAddress: '10.0.0.1' } });
    if (remote.passed || remote.statusCode !== 403) fail(label, 'localhost 姿态对非回环来源未 403');
    const local = await runMw(mw[0], UNAUTHENTICATED);
    if (!local.passed) fail(label, 'localhost 姿态对回环来源应放行');
    return;
  }
  if (posture === 'auth') {
    if (mw.length !== 1) fail(label, `auth entry 应恰 1 个 middleware（实 ${mw.length} 个）`);
    const r = await runMw(mw[0], UNAUTHENTICATED);
    if (r.statusCode !== 401 || r.passed) fail(label, '第一 middleware 不是 requireAuth 行为（无 token 未 401）');
    return;
  }
  if (mw.length !== 2) fail(label, `${posture} entry 应恰 2 个 middleware（实 ${mw.length} 个）`);
  const r1 = await runMw(mw[0], UNAUTHENTICATED);
  if (r1.statusCode !== 401 || r1.passed) fail(label, '第一 middleware 不是 requireAuth 行为（无 token 未 401）');
  const r2 = await runMw(mw[1], posture === 'authNotGuest' ? OPERATOR : LEGACY_MEMBER);
  if (posture === 'authNotGuest') {
    if (!r2.passed) fail(label, '第二 middleware 应为 requireNotGuest（Operator 应放行）');
  } else {
    if (r2.passed || r2.statusCode !== 403) fail(label, '第二 middleware 应为 requireAdmin（legacy 身份应 403）');
  }
}

// 逐 entry 派生姿态并功能验证——全表覆盖，新增/改动路由无需同步改本探针
for (const [i, entry] of table.entries()) {
  const label = `${entry.path}#${i}`;
  const posture = describeEntryAuth(entry);
  if ((entry.middleware?.length ?? 0) > 0 && posture === 'open') {
    fail(label, 'entry 挂了 middleware 却不在姿态声明数组（AUTH/AUTH_NOT_GUEST/ADMIN/LOCALHOST）内——绕过姿态声明');
  }
  await expectPosture(entry, posture, label);
}

console.log(`[route-registry-auth] OK: ${table.length} 个 entry 鉴权姿态全部符合声明（派生式功能探针）`);
process.exit(0);
}

void main();
