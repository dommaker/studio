/**
 * #443（spec #441 情境引导 02）：频道建议推导骨架 + 只读状态说明端到端。
 *
 * 推导模块测试范式照抄 waiting-input / dispatch-reconciliation：tmpdir 真实 FileStore +
 * 真实 WorkUnitService，零 mock（推导本票不发声，无 wu-messenger 出口可间谍）。
 * 核心断言 = 不变量：出「等待自动评审」只读说明 ⟺ 自动化在途前置条件成立
 * （子单租约活 / 成员 loop 在线 / 派单在飞宽限内）；无接管、超宽限断链、事实缺失 → 不出。
 *
 * 路由测试：STUDIO_DATA_DIR / STUDIO_HOME 指向临时目录后才动态 import channel.routes
 * （模块级 FileStore 在 import 时固化数据根，同 current-pmo.test.ts 先例）。
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../../workunit/workunit.service.js';
import { ReviewDispatcher } from '../../agents/loop/review-dispatcher.js';
import {
  deriveChannelSuggestions,
  SUGGESTION_TIMING,
  type ChannelSuggestion,
} from '../suggestions.js';

// #444 契约测试会真跑 dispatchReviewNow（自评兜底路径发频道系统消息）——
// 按范式仅对发声出口（wu-messenger）做 importOriginal 间谍包装
vi.mock('../../workunit/wu-messenger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workunit/wu-messenger.js')>()),
  postWuSystemMessage: vi.fn().mockResolvedValue(undefined),
}));

// 数据根前置：vi.hoisted 先于一切 import 求值（current-pmo.test.ts 同款）
const { envRoot } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require('node:path') as typeof import('node:path');
  const envRoot = fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'suggestions-env-'));
  process.env.STUDIO_DATA_DIR = envRoot;
  process.env.STUDIO_HOME = envRoot;
  return { envRoot };
});

const CHANNEL_ID = 'ch-suggest';
const nowIso = () => new Date().toISOString();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const minutesAhead = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

// ─── 单元：deriveChannelSuggestions（注入 fileStore，不碰路由） ───

describe('deriveChannelSuggestions（推导骨架）', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suggestions-unit-'));
    fileStore = new FileStore(tmpDir);
    wuService = new WorkUnitService(fileStore);
    await fileStore.createChannel({
      id: CHANNEL_ID, name: '#研发', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', createdAt: nowIso(), updatedAt: nowIso(),
    });
  });

  async function setMembers(ids: string[]) {
    await fileStore.updateChannel(CHANNEL_ID, { members: JSON.stringify(ids) });
  }

  /** 造一枚在线 loop 实例态（roleId = 频道成员 profile id，心跳新鲜） */
  async function onlineLoop(roleId: string) {
    await fileStore.createState(`inst-${roleId}`, {
      id: `inst-${roleId}`, roleId, sessionId: null, status: 'active',
      currentWorkUnitId: null, startedAt: nowIso(), terminatedAt: null,
      lastHeartbeat: nowIso(), metadata: null,
    });
  }

  async function createParent(opts?: { status?: string; type?: string; title?: string; ageMin?: number }): Promise<WorkUnitData> {
    const wu = await wuService.create({
      type: opts?.type ?? 'task', scope: '实现登录功能', channelId: CHANNEL_ID,
      status: opts?.status ?? 'in_review',
      metadata: { title: opts?.title ?? '登录功能' },
    });
    if (opts?.ageMin) {
      const s = (await fileStore.getIndex()).find(x => x.id === wu.id)!;
      await fileStore.upsertSnapshot({ ...s, updatedAt: minutesAgo(opts.ageMin) });
    }
    return wu;
  }

  async function createReviewChild(parentId: string, opts?: { status?: string; leaseFresh?: boolean }): Promise<WorkUnitData> {
    const child = await wuService.create({
      type: 'review', scope: '审查代码变更', channelId: CHANNEL_ID,
      parentId, status: opts?.status ?? 'unassigned',
    });
    if (opts?.leaseFresh) {
      const s = (await fileStore.getIndex()).find(x => x.id === child.id)!;
      await fileStore.upsertSnapshot({
        ...s, assigneeId: 'inst-reviewer', claimedAt: nowIso(), timeoutAt: minutesAhead(5),
      });
    }
    return child;
  }

  function statusOf(suggestions: ChannelSuggestion[]): ChannelSuggestion | undefined {
    return suggestions.find(s => s.kind === 'status' && s.id === 'auto-review-in-flight');
  }

  it('无 WU → currentWuId=null，不出片', async () => {
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r).toEqual({ currentWuId: null, suggestions: [] });
  });

  it('in_review + 活跃 review 子单（租约未到期）→ 出只读状态说明，带工单上下文（在途）', async () => {
    const parent = await createParent();
    await createReviewChild(parent.id, { leaseFresh: true });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.currentWuId).toBe(parent.id);
    const note = statusOf(r.suggestions);
    expect(note).toBeDefined();
    expect(note!.kind).toBe('status');
    expect(note!.params.wuId).toBe(parent.id);
    expect(note!.params.wuTitle).toBe('登录功能');
  });

  it('in_review + 子单未认领但频道成员有在线 loop → 出状态说明（即将被涌现认领，在途）', async () => {
    const parent = await createParent();
    await createReviewChild(parent.id);
    await setMembers(['profile-reviewer']);
    await onlineLoop('profile-reviewer');

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(statusOf(r.suggestions)).toBeDefined();
  });

  it('in_review + 子单存在但租约过期且无在线 loop → 不出片（无接管，fail-closed）', async () => {
    const parent = await createParent();
    // 子单曾被认领但租约已到期（loop 死了）；频道无成员 loop
    const child = await createReviewChild(parent.id, { leaseFresh: true });
    const s = (await fileStore.getIndex()).find(x => x.id === child.id)!;
    await fileStore.upsertSnapshot({ ...s, timeoutAt: minutesAgo(1) });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([]);
  });

  it('in_review 转入未超宽限 + 无子单 + 有在线 loop → 出状态说明（派单在飞）', async () => {
    await createParent(); // updatedAt = now，宽限内
    await setMembers(['profile-reviewer']);
    await onlineLoop('profile-reviewer');

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(statusOf(r.suggestions)).toBeDefined();
  });

  it('in_review 超过宽限仍无子单（断链 = 自动化该派未派）→ 出「补派评审」动作片（#444）', async () => {
    const graceMin = SUGGESTION_TIMING.reviewDispatchInFlightGraceMs / 60_000;
    const parent = await createParent({ ageMin: graceMin + 5 });
    await setMembers(['profile-reviewer']);
    await onlineLoop('profile-reviewer');

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.currentWuId).toBe(parent.id);
    expect(r.suggestions).toEqual([{
      id: 'redispatch-review',
      kind: 'action',
      params: { wuId: parent.id, wuTitle: '登录功能' },
    }]);
  });

  it('双向覆盖反向：活跃 review 子单在途 → 不出补派动作片', async () => {
    const graceMin = SUGGESTION_TIMING.reviewDispatchInFlightGraceMs / 60_000;
    const parent = await createParent({ ageMin: graceMin + 5 });
    await createReviewChild(parent.id, { leaseFresh: true });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions.find(s => s.kind === 'action')).toBeUndefined();
  });

  it('断链但 l2 已达成（done 缺 l3 派生 in_review 列）→ 不出动作片（端点必拒，fail-closed）', async () => {
    const graceMin = SUGGESTION_TIMING.reviewDispatchInFlightGraceMs / 60_000;
    const parent = await createParent({ status: 'done', ageMin: graceMin + 5 });
    await fileStore.updateMetadata(parent.id, latest => ({
      ...latest,
      attestations: { l2: { verdict: 'approved', by: 'reviewer', at: nowIso(), kind: 'agent-review' } },
    }));

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([]);
  });

  it('子单存在但僵死（租约过期无接管）→ 不出补派动作片（补派会被同父唯一性 409，非本动作可修）', async () => {
    const graceMin = SUGGESTION_TIMING.reviewDispatchInFlightGraceMs / 60_000;
    const parent = await createParent({ ageMin: graceMin + 5 });
    const child = await createReviewChild(parent.id, { leaseFresh: true });
    const s = (await fileStore.getIndex()).find(x => x.id === child.id)!;
    await fileStore.upsertSnapshot({ ...s, timeoutAt: minutesAgo(1) });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions.find(s => s.kind === 'action')).toBeUndefined();
  });

  it('契约（#444 AC2/AC3）：动作片 wuId 直调 dispatchReviewNow（自动派发同原语）建出 review 子单；生效后动作片消失', async () => {
    const graceMin = SUGGESTION_TIMING.reviewDispatchInFlightGraceMs / 60_000;
    const parent = await createParent({ ageMin: graceMin + 5 });

    const before = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    const action = before.suggestions.find(s => s.id === 'redispatch-review');
    expect(action).toBeDefined();

    // 与 ReviewDispatcher 自动派发同一原语：直调 dispatchReviewNow（ dispatch-review 端点的服务层）
    const dispatcher = new ReviewDispatcher(fileStore, wuService);
    const child = await dispatcher.dispatchReviewNow(action!.params.wuId);
    expect(child.type).toBe('review');
    expect(child.parentId).toBe(parent.id);

    // 动作生效、状态流转（子单建出）→ 前置条件转假 → 动作片消失
    const after = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(after.suggestions.find(s => s.id === 'redispatch-review')).toBeUndefined();
  });

  it('in_review 宽限内无子单但无在线 loop → 不出片（无接管两向的另一向）', async () => {
    await createParent();
    await setMembers(['profile-reviewer']);
    // 有成员但 loop 心跳过期（离线）
    await fileStore.createState('inst-profile-reviewer', {
      id: 'inst-profile-reviewer', roleId: 'profile-reviewer', sessionId: null, status: 'active',
      currentWorkUnitId: null, startedAt: minutesAgo(30), terminatedAt: null,
      lastHeartbeat: minutesAgo(30), metadata: null,
    });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([]);
  });

  it('review 子单已终态（done）→ 不算在途；超宽限 → 出补派动作片（可重派）', async () => {
    const graceMin = SUGGESTION_TIMING.reviewDispatchInFlightGraceMs / 60_000;
    const parent = await createParent({ ageMin: graceMin + 5 });
    await createReviewChild(parent.id, { status: 'done' });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([{
      id: 'redispatch-review',
      kind: 'action',
      params: { wuId: parent.id, wuTitle: '登录功能' },
    }]);
  });

  it('不可自动评审类型（decision/spec/analysis/review）in_review → 不出片', async () => {
    for (const type of ['decision', 'spec', 'analysis', 'review']) {
      await createParent({ type, title: `${type} 单` });
    }
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    // 最新 updatedAt 的是最后一枚（review 类型），同样不出
    expect(r.suggestions).toEqual([]);
  });

  it('当前 WU 派生列为 active/unassigned/blocked/pending/done/closed → 不出状态说明（本票只有自动评审在途一条）', async () => {
    await createParent({ status: 'active' });
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([]);
  });

  it('pickCurrentWu 后端化：非终态中 updatedAt 最新者胜出；全终态回退最新者', async () => {
    const old = await createParent({ status: 'active', title: '旧工单', ageMin: 30 });
    const done = await wuService.create({
      type: 'task', scope: '已完成', channelId: CHANNEL_ID, status: 'done', metadata: { title: '已完成' },
    });
    void done;
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    // active 虽旧仍为非终态 → 胜出（终态判定走派生列，不读裸 status）
    expect(r.currentWuId).toBe(old.id);
  });

  it('review 子单是自动化内部执行单元：updatedAt 更新也不作「当前工单」（否则状态说明永不触发）', async () => {
    const parent = await createParent({ ageMin: 10 });
    await createReviewChild(parent.id, { leaseFresh: true }); // 子单 updatedAt 最新

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.currentWuId).toBe(parent.id);
  });

  it('频道不存在 → 空结果不抛出（fail-closed）', async () => {
    const r = await deriveChannelSuggestions('ch-not-exist', { fileStore });
    expect(r).toEqual({ currentWuId: null, suggestions: [] });
  });
});

// ─── 路由：GET /:id/suggestions ───

describe('channel routes（#443）：GET /:id/suggestions', () => {
  const tmpDir = envRoot;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    fileStore = new FileStore(tmpDir);
    wuService = new WorkUnitService(fileStore);

    const { default: channelRoutes } = await import('../channel.routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/channels', channelRoutes);
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
    baseUrl = `http://127.0.0.1:${addr.port}/api/v1/channels`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('未知频道 → 404', async () => {
    const res = await fetch(`${baseUrl}/ch-not-exist/suggestions`);
    expect(res.status).toBe(404);
  });

  it('空频道 → currentWuId=null，suggestions=[]', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-suggestions-empty', type: 'rnd' }),
    });
    const channel = (await res.json()).data;

    const r = await fetch(`${baseUrl}/${channel.id}/suggestions`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ currentWuId: null, suggestions: [] });
  });

  it('in_review + 活跃 review 子单 → data 携带 status 形态建议（结构化 params，无自由文案）', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-suggestions-inflight', type: 'rnd' }),
    });
    const channel = (await res.json()).data;

    const parent = await wuService.create({
      type: 'task', scope: '实现登录功能', channelId: channel.id, status: 'in_review',
      metadata: { title: '登录功能' },
    });
    const child = await wuService.create({
      type: 'review', scope: '审查代码变更', channelId: channel.id, parentId: parent.id, status: 'unassigned',
    });
    const snap = (await fileStore.getIndex()).find(x => x.id === child.id)!;
    await fileStore.upsertSnapshot({
      ...snap, assigneeId: 'inst-reviewer', claimedAt: nowIso(), timeoutAt: minutesAhead(5),
    });

    const r = await fetch(`${baseUrl}/${channel.id}/suggestions`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.currentWuId).toBe(parent.id);
    expect(body.data.suggestions).toHaveLength(1);
    expect(body.data.suggestions[0]).toEqual({
      id: 'auto-review-in-flight',
      kind: 'status',
      params: { wuId: parent.id, wuTitle: '登录功能' },
    });
  });

  it('in_review 超宽限无子单（断链）→ data 携带 action 形态建议（#444 redispatch-review，结构化 params）', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-suggestions-broken', type: 'rnd' }),
    });
    const channel = (await res.json()).data;

    const graceMin = SUGGESTION_TIMING.reviewDispatchInFlightGraceMs / 60_000;
    const parent = await wuService.create({
      type: 'task', scope: '实现登录功能', channelId: channel.id, status: 'in_review',
      metadata: { title: '登录功能' },
    });
    const snap = (await fileStore.getIndex()).find(x => x.id === parent.id)!;
    await fileStore.upsertSnapshot({ ...snap, updatedAt: minutesAgo(graceMin + 5) });

    const r = await fetch(`${baseUrl}/${channel.id}/suggestions`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.currentWuId).toBe(parent.id);
    expect(body.data.suggestions).toEqual([{
      id: 'redispatch-review',
      kind: 'action',
      params: { wuId: parent.id, wuTitle: '登录功能' },
    }]);
  });
});
