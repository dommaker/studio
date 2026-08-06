/**
 * §10.5 角色级 token 视图聚合单测。
 *
 * 用 tmp 目录构造 FileStore（agents/<实例id>/state.json + workunits/index.json）
 * 与 fixture studio-events.jsonl，验证：
 *   - 多实例 → 同一 profile 的归并与 token 求和
 *   - today / rolling7d 窗口
 *   - collab.rootId 树分组（无 rootId 自成一树）
 *   - 空数据 → 全零不抛错
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';

import { getAgentTokenUsage, invalidateTokenUsageCache, aggregateTreeTokens, sumTokensForWorkUnits } from '../token-usage.service.js';
import { TREE_TOKEN_BUDGET } from '../../workunit/delegation-gate.js';

let tmpDir: string;
let eventsFile: string;
let fileStore: FileStore;

const PROFILE_A = 'profile-a';
const PROFILE_B = 'profile-b';
const INSTANCE_1 = 'inst-1';
const INSTANCE_2 = 'inst-2';

function makeWu(id: string, assigneeId: string | null, metadata?: Record<string, unknown>): WorkUnitSnapshot {
  return {
    id,
    parentId: null,
    type: 'feature',
    scope: `wu ${id}`,
    assigneeId,
    status: 'done',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    metadata: metadata ? JSON.stringify(metadata) : null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    claimedAt: null,
    completedAt: null,
  };
}

function writeState(instanceId: string, roleId: string): void {
  const dir = path.join(tmpDir, 'agents', instanceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    id: instanceId,
    roleId,
    sessionId: null,
    status: 'terminated',
    currentWorkUnitId: null,
    startedAt: '2026-07-01T00:00:00.000Z',
    terminatedAt: null,
    lastHeartbeat: null,
    metadata: null,
  }), 'utf-8');
}

function writeIndex(wus: WorkUnitSnapshot[]): void {
  const dir = path.join(tmpDir, 'workunits');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(wus), 'utf-8');
}

function tokenEvent(wuId: string, tokens: { injected: number; execution: number | null }, createdAt: string): string {
  return JSON.stringify({
    type: 'workunit:tokens',
    source: 'agent-loop',
    payload: JSON.stringify({
      workUnitId: wuId,
      injectedTokens: tokens.injected,
      executionTokens: tokens.execution,
      totalTokens: tokens.injected + (tokens.execution ?? 0),
    }),
    createdAt,
  });
}

function writeEvents(lines: string[]): void {
  fs.writeFileSync(eventsFile, lines.length ? lines.join('\n') + '\n' : '', 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-usage-'));
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  fileStore = new FileStore(tmpDir);
  invalidateTokenUsageCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('§10.5 getAgentTokenUsage', () => {
  it('空数据（无事件文件）→ 全零，不抛错', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    writeIndex([]);
    const usage = await getAgentTokenUsage(PROFILE_A, { eventsFile, fileStore });
    expect(usage.totals).toEqual({ injectedTokens: 0, executionTokens: 0, totalTokens: 0 });
    expect(usage.today).toEqual({ injectedTokens: 0, executionTokens: 0, totalTokens: 0 });
    expect(usage.rolling7d).toEqual({ injectedTokens: 0, executionTokens: 0, totalTokens: 0 });
    expect(usage.workUnitCount).toBe(0);
    expect(usage.trees).toEqual({ participated: 0, avgTreeDepth: 0 });
  });

  it('多实例 → 同一 profile 归并求和；他 profile 不计入', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    writeState(INSTANCE_2, PROFILE_A); // 第二个实例同属 profile-a
    writeState('inst-3', PROFILE_B);
    writeIndex([
      makeWu('wu-1', INSTANCE_1),
      makeWu('wu-2', INSTANCE_2),
      makeWu('wu-3', 'inst-3'),
    ]);
    const now = Date.now();
    writeEvents([
      tokenEvent('wu-1', { injected: 100, execution: 900 }, new Date(now).toISOString()),
      tokenEvent('wu-2', { injected: 200, execution: 800 }, new Date(now).toISOString()),
      tokenEvent('wu-3', { injected: 999, execution: 999 }, new Date(now).toISOString()), // profile-b
    ]);

    const usage = await getAgentTokenUsage(PROFILE_A, { eventsFile, fileStore, now });
    expect(usage.totals).toEqual({ injectedTokens: 300, executionTokens: 1700, totalTokens: 2000 });
    expect(usage.today.totalTokens).toBe(2000);
    expect(usage.rolling7d.totalTokens).toBe(2000);
    expect(usage.workUnitCount).toBe(2);
  });

  it('today / rolling7d 窗口：3 天前只进 7d，10 天前只进 totals', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    writeIndex([makeWu('wu-1', INSTANCE_1), makeWu('wu-2', INSTANCE_1), makeWu('wu-3', INSTANCE_1)]);
    const now = Date.now();
    const dayMs = 86_400_000;
    writeEvents([
      tokenEvent('wu-1', { injected: 10, execution: 10 }, new Date(now).toISOString()),
      tokenEvent('wu-2', { injected: 20, execution: 20 }, new Date(now - 3 * dayMs).toISOString()),
      tokenEvent('wu-3', { injected: 40, execution: 40 }, new Date(now - 10 * dayMs).toISOString()),
    ]);

    const usage = await getAgentTokenUsage(PROFILE_A, { eventsFile, fileStore, now });
    expect(usage.totals.totalTokens).toBe(140);
    expect(usage.rolling7d.totalTokens).toBe(60); // 今天 + 3 天前
    expect(usage.today.totalTokens).toBe(20);
    expect(usage.workUnitCount).toBe(3);
  });

  it('executionTokens=null 按 0 计入（不编造），WU 无法归因的事件跳过', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    writeIndex([makeWu('wu-1', INSTANCE_1), makeWu('wu-unclaimed', null)]);
    const now = Date.now();
    writeEvents([
      tokenEvent('wu-1', { injected: 50, execution: null }, new Date(now).toISOString()),
      tokenEvent('wu-unclaimed', { injected: 77, execution: 77 }, new Date(now).toISOString()), // 未 claim
      tokenEvent('wu-ghost', { injected: 88, execution: 88 }, new Date(now).toISOString()),     // 索引中不存在
    ]);

    const usage = await getAgentTokenUsage(PROFILE_A, { eventsFile, fileStore, now });
    expect(usage.totals).toEqual({ injectedTokens: 50, executionTokens: 0, totalTokens: 50 });
    expect(usage.workUnitCount).toBe(1);
  });

  it('未认领指名 WU（assigneeId=profile id）→ 直接按 profile 归因（共享 resolver 双形态口径）', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    await fileStore.createProfile({ id: PROFILE_B, name: 'AgentB', description: null, channels: '[]', provider: 'claude', status: 'active', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' });
    writeIndex([
      makeWu('wu-1', INSTANCE_1),
      makeWu('wu-named', PROFILE_B), // @mention/委派指名未认领：assigneeId 本身是 profile id
    ]);
    const now = Date.now();
    writeEvents([
      tokenEvent('wu-1', { injected: 100, execution: 900 }, new Date(now).toISOString()),
      tokenEvent('wu-named', { injected: 5, execution: 5 }, new Date(now).toISOString()),
    ]);

    const usage = await getAgentTokenUsage(PROFILE_B, { eventsFile, fileStore, now });
    // 修复前（仅实例 map 查找）恒全零；修复后 profile-id 直通归因
    expect(usage.totals.totalTokens).toBe(10);
    expect(usage.workUnitCount).toBe(1);
  });

  it('collab.rootId 树分组：参与的树数 + 平均树深（全量索引口径）', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    writeState('inst-3', PROFILE_B);
    writeIndex([
      makeWu('wu-root', INSTANCE_1, { collab: { rootId: 'tree-1' } }),
      makeWu('wu-child', 'inst-3', { collab: { rootId: 'tree-1' } }), // 他 profile 的子节点，计入树深
      makeWu('wu-solo', INSTANCE_1),                                   // 无 rootId → 自成一树
    ]);
    const now = Date.now();
    writeEvents([
      tokenEvent('wu-root', { injected: 1, execution: 1 }, new Date(now).toISOString()),
      tokenEvent('wu-solo', { injected: 1, execution: 1 }, new Date(now).toISOString()),
    ]);

    const usage = await getAgentTokenUsage(PROFILE_A, { eventsFile, fileStore, now });
    expect(usage.trees.participated).toBe(2);        // tree-1 + wu-solo 自身
    expect(usage.trees.avgTreeDepth).toBe(1.5);      // (2 + 1) / 2
  });

  it('payload 损坏 / 非 workunit:tokens 行跳过，不影响其余聚合', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    writeIndex([makeWu('wu-1', INSTANCE_1)]);
    const now = Date.now();
    writeEvents([
      tokenEvent('wu-1', { injected: 5, execution: 5 }, new Date(now).toISOString()),
      JSON.stringify({ type: 'workunit:tokens', payload: '{broken', createdAt: new Date(now).toISOString() }),
      JSON.stringify({ type: 'knowledge:skill_used', payload: JSON.stringify({ skillName: 'x' }), createdAt: new Date(now).toISOString() }),
    ]);

    const usage = await getAgentTokenUsage(PROFILE_A, { eventsFile, fileStore, now });
    expect(usage.totals.totalTokens).toBe(10);
    expect(usage.workUnitCount).toBe(1);
  });
});

describe('§8.4.3 aggregateTreeTokens', () => {
  it('单节点树：root 有 token 事件 -> 正确聚合', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    await fileStore.createProfile({ id: PROFILE_A, name: 'AgentA', description: null, channels: '[]', provider: 'claude', status: 'active', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' });
    writeIndex([makeWu('wu-root', INSTANCE_1)]);
    writeEvents([
      tokenEvent('wu-root', { injected: 500, execution: 1500 }, new Date().toISOString()),
    ]);

    const report = await aggregateTreeTokens('wu-root', fileStore, { eventsFile });
    expect(report.rootId).toBe('wu-root');
    expect(report.nodes).toHaveLength(1);
    expect(report.nodes[0]).toMatchObject({
      workUnitId: 'wu-root',
      profileName: 'AgentA',
      injectedTokens: 500,
      executionTokens: 1500,
      totalTokens: 2000,
    });
    expect(report.rootTotal).toBe(1500);
    expect(report.budgetRemaining).toBe(TREE_TOKEN_BUDGET - 1500);
  });

  it('多节点树：root + 子孙 WU 聚合', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    writeState(INSTANCE_2, PROFILE_B);
    await fileStore.createProfile({ id: PROFILE_A, name: 'AgentA', description: null, channels: '[]', provider: 'claude', status: 'active', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' });
    await fileStore.createProfile({ id: PROFILE_B, name: 'AgentB', description: null, channels: '[]', provider: 'claude', status: 'active', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' });
    writeIndex([
      makeWu('wu-root', INSTANCE_1, { collab: { rootId: 'wu-root', depth: 0, chain: [PROFILE_A], delegationCount: 0 } }),
      makeWu('wu-child', INSTANCE_2, { collab: { rootId: 'wu-root', depth: 1, chain: [PROFILE_A, PROFILE_B], delegationCount: 0 } }),
    ]);
    writeEvents([
      tokenEvent('wu-root', { injected: 100, execution: 900 }, new Date().toISOString()),
      tokenEvent('wu-child', { injected: 200, execution: 800 }, new Date().toISOString()),
    ]);

    const report = await aggregateTreeTokens('wu-root', fileStore, { eventsFile });
    expect(report.nodes).toHaveLength(2);
    expect(report.rootTotal).toBe(1700); // 900 + 800
    const child = report.nodes.find(n => n.workUnitId === 'wu-child');
    expect(child?.profileName).toBe('AgentB');
  });

  it('未认领指名子 WU（assigneeId=profile id，@mention/委派语义）→ profileName 直接按 profile 归因', async () => {
    writeState(INSTANCE_1, PROFILE_A);
    await fileStore.createProfile({ id: PROFILE_A, name: 'AgentA', description: null, channels: '[]', provider: 'claude', status: 'active', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' });
    await fileStore.createProfile({ id: PROFILE_B, name: 'AgentB', description: null, channels: '[]', provider: 'claude', status: 'active', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z' });
    writeIndex([
      makeWu('wu-root', INSTANCE_1, { collab: { rootId: 'wu-root', depth: 0, chain: [PROFILE_A], delegationCount: 0 } }),
      // 委派的未认领子 WU：assigneeId 是目标 profile id（§1.2-b），没有 state 可查
      makeWu('wu-child', PROFILE_B, { collab: { rootId: 'wu-root', depth: 1, chain: [PROFILE_A, PROFILE_B], delegationCount: 0 } }),
    ]);
    writeEvents([
      tokenEvent('wu-root', { injected: 100, execution: 900 }, new Date().toISOString()),
    ]);

    const report = await aggregateTreeTokens('wu-root', fileStore, { eventsFile });
    const child = report.nodes.find(n => n.workUnitId === 'wu-child');
    // 修复前恒 null（instance 反查 miss）；修复后按 profile id 直接归因
    expect(child?.profileName).toBe('AgentB');
  });

  it('无事件文件 -> 全零，不抛错', async () => {
    writeIndex([makeWu('wu-root', null)]);
    const report = await aggregateTreeTokens('wu-root', fileStore, { eventsFile });
    expect(report.rootTotal).toBe(0);
    expect(report.budgetRemaining).toBe(TREE_TOKEN_BUDGET);
    expect(report.nodes[0].injectedTokens).toBeNull();
    expect(report.nodes[0].executionTokens).toBeNull();
  });
});

describe('sumTokensForWorkUnits（PMO 台账：项目 WU 链路 token 求和）', () => {
  it('按 WU id 集求和 totalTokens；集外 WU / 他类型事件不计入', async () => {
    writeEvents([
      tokenEvent('wu-1', { injected: 100, execution: 900 }, new Date().toISOString()),
      tokenEvent('wu-2', { injected: 200, execution: 800 }, new Date().toISOString()),
      tokenEvent('wu-3', { injected: 999, execution: 999 }, new Date().toISOString()), // 集外
      JSON.stringify({ type: 'knowledge:skill_used', payload: JSON.stringify({ skillName: 'x' }), createdAt: new Date().toISOString() }),
    ]);

    const sum = await sumTokensForWorkUnits(new Set(['wu-1', 'wu-2']), { eventsFile, fileStore });
    expect(sum).toBe(2000); // (100+900) + (200+800)
  });

  it('totalTokens 缺失按 injected+execution 兜底；payload 损坏/撕裂行跳过', async () => {
    writeEvents([
      JSON.stringify({
        type: 'workunit:tokens',
        payload: JSON.stringify({ workUnitId: 'wu-1', injectedTokens: 5, executionTokens: 7 }),
        createdAt: new Date().toISOString(),
      }),
      JSON.stringify({ type: 'workunit:tokens', payload: '{broken', createdAt: new Date().toISOString() }),
      '{torn-line',
    ]);

    expect(await sumTokensForWorkUnits(new Set(['wu-1']), { eventsFile, fileStore })).toBe(12);
  });

  it('事件文件不存在 / 空 id 集 → 0，不抛错', async () => {
    expect(await sumTokensForWorkUnits(new Set(['wu-1']), { eventsFile, fileStore })).toBe(0);
    expect(await sumTokensForWorkUnits(new Set(), { eventsFile, fileStore })).toBe(0);
  });
});
