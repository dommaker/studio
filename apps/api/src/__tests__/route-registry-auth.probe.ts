/**
 * route-registry 鉴权姿态探针（tsx 子进程侧，P2-e 声明式统一）
 *
 * 由 route-registry-auth.test.ts spawn 执行（本文件不是测试，不被 vitest 收集）。
 * 探针在 tsx 进程内跑 buildRouteTable()——与生产 bootstrap 同一模块管线
 * （vitest 进程内直跑会把 node_modules 链路外置成原生 ESM，踩目录导入解析差异，
 * 故探针落 tsx 子进程保生产保真）。逐 entry 功能探针：
 * - open：无 entry 级 middleware；
 * - auth（requireAuth）：STUDIO_AUTH=on 无 token → 401；
 * - authNotGuest：第二 middleware 对 Member 用户放行；
 * - admin：第二 middleware 对 Member 用户 403。
 * 任一断言失败 → exit 1（消息带 entry 标签）。
 */
import type { RequestHandler } from 'express';
import { buildRouteTable, type RouteEntry } from '../route-registry.js';

process.env.STUDIO_AUTH = 'on';

async function main(): Promise<void> {
const table = await buildRouteTable();

function entriesOf(path: string): RouteEntry[] {
  return table.filter(e => e.path === path);
}

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

type Posture = 'open' | 'auth' | 'authNotGuest' | 'admin';

async function expectPosture(entry: RouteEntry | undefined, posture: Posture, label: string): Promise<void> {
  if (!entry) fail(label, 'entry 缺失');
  const mw = entry.middleware ?? [];
  if (posture === 'open') {
    if (mw.length !== 0) fail(label, `open entry 不应有 entry 级 middleware（实 ${mw.length} 个）`);
    return;
  }
  if (posture === 'auth') {
    if (mw.length !== 1) fail(label, `auth entry 应恰 1 个 middleware（实 ${mw.length} 个）`);
    const r = await runMw(mw[0], { headers: {}, socket: { remoteAddress: '127.0.0.1' } });
    if (r.statusCode !== 401 || r.passed) fail(label, '第一 middleware 不是 requireAuth 行为（无 token 未 401）');
    return;
  }
  if (mw.length !== 2) fail(label, `${posture} entry 应恰 2 个 middleware（实 ${mw.length} 个）`);
  const r1 = await runMw(mw[0], { headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  if (r1.statusCode !== 401 || r1.passed) fail(label, '第一 middleware 不是 requireAuth 行为（无 token 未 401）');
  const r2 = await runMw(mw[1], {
    headers: {},
    user: { id: 'u1', role: 'Member', name: 'M' },
    session: { userId: 'u1' },
  });
  if (posture === 'authNotGuest') {
    if (!r2.passed) fail(label, '第二 middleware 应为 requireNotGuest（Member 应放行）');
  } else {
    if (r2.passed || r2.statusCode !== 403) fail(label, '第二 middleware 应为 requireAdmin（Member 应 403）');
  }
}

// ── 读/写拆分模块：open 无 middleware + write 挂 authNotGuest（+ admin 档） ──
const splitCases: Array<{ path: string; adminToo?: boolean }> = [
  { path: '/api/v1/workunits' },
  { path: '/api/v1/requirements' },
  { path: '/api/v1/agent-profiles' },
  { path: '/api/v1/pmo', adminToo: true },
  { path: '/api/v1/agent-instances', adminToo: true },
];
for (const c of splitCases) {
  const entries = entriesOf(c.path);
  const expected = c.adminToo ? 3 : 2;
  if (entries.length !== expected) fail(c.path, `应有 ${expected} 个 entry（实 ${entries.length} 个）`);
  await expectPosture(entries[0], 'open', `${c.path}[open]`);
  await expectPosture(entries[1], 'authNotGuest', `${c.path}[write]`);
  if (c.adminToo) await expectPosture(entries[2], 'admin', `${c.path}[admin]`);
}

// ── legacy agents：token-usage 前置 + open/write/admin 三档 ──
{
  const entries = entriesOf('/api/v1/agents');
  if (entries.length !== 4) fail('/api/v1/agents', `应有 4 个 entry（实 ${entries.length} 个）`);
  await expectPosture(entries[0], 'open', 'agents[token-usage]');
  await expectPosture(entries[1], 'open', 'agents[open]');
  await expectPosture(entries[2], 'authNotGuest', 'agents[write]');
  await expectPosture(entries[3], 'admin', 'agents[admin]');
}

// ── skills 三组：demotion 先于 skills，write 均挂 authNotGuest ──
{
  const demotion = entriesOf('/api/v1/skills/demotion-proposals');
  if (demotion.length !== 2) fail('demotion-proposals', `应有 2 个 entry（实 ${demotion.length} 个）`);
  await expectPosture(demotion[0], 'open', 'demotion[open]');
  await expectPosture(demotion[1], 'authNotGuest', 'demotion[write]');
  const skills = entriesOf('/api/v1/skills');
  if (skills.length !== 2) fail('/api/v1/skills', `应有 2 个 entry（实 ${skills.length} 个）`);
  await expectPosture(skills[0], 'open', 'skills[open]');
  await expectPosture(skills[1], 'authNotGuest', 'skills[write]');
  const proposals = entriesOf('/api/v1/skills/proposals');
  if (proposals.length !== 2) fail('/api/v1/skills/proposals', `应有 2 个 entry（实 ${proposals.length} 个）`);
  await expectPosture(proposals[0], 'open', 'proposals[open]');
  await expectPosture(proposals[1], 'authNotGuest', 'proposals[write]');
  if (table.indexOf(demotion[0]) >= table.indexOf(skills[0])) {
    fail('skills 顺序', 'demotion open 必须先于 skills open 挂载');
  }
}

// ── channels：attachment（无 entry middleware，鉴权留路由内）→ read 挂 auth → write 挂 authNotGuest ──
{
  const entries = entriesOf('/api/v1/channels');
  if (entries.length !== 3) fail('/api/v1/channels', `应有 3 个 entry（实 ${entries.length} 个）`);
  await expectPosture(entries[0], 'open', 'channels[attachment]');
  await expectPosture(entries[1], 'auth', 'channels[read]');
  await expectPosture(entries[2], 'authNotGuest', 'channels[write]');
}

// ── 整路由统一姿态模块 ──
await expectPosture(entriesOf('/api/v1/notifications')[0], 'authNotGuest', 'notifications');
await expectPosture(entriesOf('/api/v1/action-center')[0], 'authNotGuest', 'action-center');
await expectPosture(entriesOf('/api/v1/workspaces')[0], 'admin', 'workspaces');

// ── registry 已挂 auth 的模块保持单 middleware ──
{
  const events = entriesOf('/api/v1/events');
  if (events.length !== 3) fail('/api/v1/events', `应有 3 个 entry（实 ${events.length} 个）`);
  await expectPosture(events[0], 'open', 'events[sse]');
  await expectPosture(events[1], 'auth', 'events[open]');
  await expectPosture(events[2], 'authNotGuest', 'events[write]');
  await expectPosture(entriesOf('/api/v1/knowledge')[0], 'auth', 'knowledge');
  await expectPosture(entriesOf('/api/v1/knowledge-service')[0], 'auth', 'knowledge-service');
  {
    const rp = entriesOf('/api/v1/review-proposals');
    if (rp.length !== 2) fail('/api/v1/review-proposals', `应有 2 个 entry（实 ${rp.length} 个）`);
    await expectPosture(rp[0], 'auth', 'review-proposals[open]');
    await expectPosture(rp[1], 'authNotGuest', 'review-proposals[write]');
  }
  {
    const specs = entriesOf('/api/v1/specs');
    if (specs.length !== 2) fail('/api/v1/specs', `应有 2 个 entry（实 ${specs.length} 个）`);
    await expectPosture(specs[0], 'auth', 'specs[open]');
    await expectPosture(specs[1], 'authNotGuest', 'specs[write]');
  }
  await expectPosture(entriesOf('/api/v1/transcripts')[0], 'auth', 'transcripts');
}

// ── 混合粒度模块不上移：无 entry 级 middleware ──
await expectPosture(entriesOf('/api/v1/auth')[0], 'open', 'auth（混合粒度，鉴权留路由内）');
await expectPosture(entriesOf('/api/v1/mcp')[0], 'open', 'mcp（三态混合，鉴权留路由内）');
await expectPosture(entriesOf('/api/v1/executions')[0], 'open', 'executions（LEGACY 混合，鉴权留路由内）');

console.log('[route-registry-auth] OK: 全部 entry 鉴权姿态符合 P2-e 声明式契约');
process.exit(0);
}

void main();
