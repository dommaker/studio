/**
 * #443（spec #441 情境引导 02）：频道建议推导骨架 + 只读状态说明端到端。
 *
 * 推导模块测试范式照抄 waiting-input / dispatch-reconciliation：tmpdir 真实 FileStore +
 * 真实 WorkUnitService；wu-messenger 发声出口做间谍包装（#444 补派契约 / #445 认领契约断言用）。
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
import { detectMention } from '../message-routing.js';

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

  it('无 WU + 有成员 → currentWuId=null，不出片', async () => {
    await setMembers(['profile-exec']);
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r).toEqual({ currentWuId: null, suggestions: [], degraded: false });
  });

  // #465（首用路径断点）：空转频道（无当前工单）+ 成员为空 → 出只读提示片
  // （新装三默认频道正是此态；角色不进频道 = @ 不到、loop 不认领）
  it('无 WU + 频道成员为空 → 出 channel-no-members 只读提示片（currentWuId=null）', async () => {
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r).toEqual({
      currentWuId: null,
      suggestions: [{ id: 'channel-no-members', kind: 'status', params: {} }],
      degraded: false,
    });
  });

  it('有当前工单 + 成员为空 → 不出 channel-no-members 片（由既有片型覆盖，不叠加）', async () => {
    await createParent({ status: 'unassigned' });
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions.find(s => s.id === 'channel-no-members')).toBeUndefined();
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

  // ─── #445：认领动作片（unassigned 断链补救） ───

  it('unassigned 当前工单 + 频道无在线 loop → 出「认领」动作片（无人接管，立即出）', async () => {
    const parent = await createParent({ status: 'unassigned' });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.currentWuId).toBe(parent.id);
    expect(r.suggestions).toEqual([{
      id: 'claim-wu',
      kind: 'action',
      params: { wuId: parent.id, wuTitle: '登录功能' },
    }]);
  });

  it('双向覆盖反向：unassigned + 有在线成员 loop 且宽限内 → 不出认领片（涌现认领大概率在途）', async () => {
    await createParent({ status: 'unassigned' }); // updatedAt = now，宽限内
    await setMembers(['profile-exec']);
    await onlineLoop('profile-exec');

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([]);
  });

  it('unassigned + 有在线 loop 但已超宽限（loop 迟迟未认领）→ 出认领片', async () => {
    const graceMin = SUGGESTION_TIMING.unassignedClaimGraceMs / 60_000;
    const parent = await createParent({ status: 'unassigned', ageMin: graceMin + 5 });
    await setMembers(['profile-exec']);
    await onlineLoop('profile-exec');

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([{
      id: 'claim-wu',
      kind: 'action',
      params: { wuId: parent.id, wuTitle: '登录功能' },
    }]);
  });

  it('契约（#445 AC1/AC3）：动作片 wuId 经认领即发声原语（REST claim 端点同一路径）认领生效 → 片消失 + 发声', async () => {
    const parent = await createParent({ status: 'unassigned' });

    const before = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    const action = before.suggestions.find(s => s.id === 'claim-wu');
    expect(action).toBeDefined();

    // 与 REST claim 端点同一原语：直调 claimWorkUnitAndAnnounce（人工引导片认领路径）
    const { claimWorkUnitAndAnnounce } = await import('../../workunit/claim-announce.js');
    const claimed = await claimWorkUnitAndAnnounce(action!.params.wuId, 'user-1', '守夜人', { wuService, fileStore });
    expect(claimed.status).toBe('active');
    expect(claimed.assigneeId).toBe('user-1');
    // 认领即发声（本文件对 wu-messenger 做间谍包装：断言出口调用形态）
    const { postWuSystemMessage } = await import('../../workunit/wu-messenger.js');
    expect(postWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: parent.id }),
      '『守夜人』已认领任务，开始执行',
      expect.objectContaining({ agentName: '守夜人' }),
    );

    // 动作生效、状态流转（unassigned → active）→ 前置条件转假 → 动作片消失
    const after = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(after.suggestions.find(s => s.id === 'claim-wu')).toBeUndefined();
  });

  // ─── #446：prompt 建议片（诊断阻塞 + 前置门禁转写清单） ───

  it('blocked 当前工单（无 waitingForInput、租约不活）→ 出「诊断阻塞」prompt 片，带标题与阻塞原因上下文', async () => {
    const parent = await createParent({ status: 'blocked' });
    await fileStore.updateMetadata(parent.id, latest => ({
      ...latest, blockReason: 'verify-failed: 自动验证未通过（3 个用例）',
    }));

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.currentWuId).toBe(parent.id);
    expect(r.suggestions).toEqual([{
      id: 'diagnose-blocked',
      kind: 'prompt',
      // blockReason 剥机器类型前缀（verify-failed: 等）后入 params——片上文案说人话
      params: { wuId: parent.id, wuTitle: '登录功能', blockReason: '自动验证未通过（3 个用例）' },
      text: expect.stringContaining('@developer'),
    }]);
  });

  it('blocked 无 blockReason → 出诊断片，params 不含 blockReason 键（不编造原因）', async () => {
    const parent = await createParent({ status: 'blocked' });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([{
      id: 'diagnose-blocked',
      kind: 'prompt',
      params: { wuId: parent.id, wuTitle: '登录功能' },
      text: expect.stringContaining('@developer'),
    }]);
  });

  it('契约（#446 AC3）：诊断阻塞片预填文案经 @mention 路由解析出目标角色 developer', async () => {
    await createParent({ status: 'blocked' });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    const prompt = r.suggestions.find(s => s.id === 'diagnose-blocked');
    expect(prompt?.kind).toBe('prompt');
    expect(typeof prompt?.text).toBe('string');
    expect(detectMention(prompt!.text!)).toBe('developer');
  });

  it('双向：blocked + waitingForInput（人闸挂起）→ 不出诊断片（NeedInputOptions 内嵌回复覆盖）', async () => {
    const parent = await createParent({ status: 'blocked' });
    await fileStore.updateMetadata(parent.id, latest => ({ ...latest, waitingForInput: true }));

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([]);
  });

  it('双向：blocked + 当前 WU 租约仍活（loop 在处理）→ 不出诊断片', async () => {
    const parent = await createParent({ status: 'blocked' });
    const s = (await fileStore.getIndex()).find(x => x.id === parent.id)!;
    await fileStore.upsertSnapshot({ ...s, assigneeId: 'inst-dev', claimedAt: nowIso(), timeoutAt: minutesAhead(5) });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions).toEqual([]);
  });

  it('in_review 前置门禁窗口（无子单未超宽限）+ 有在线 loop → 状态片与可选「转写审查清单」prompt 片并存', async () => {
    const parent = await createParent(); // updatedAt = now，宽限内
    await setMembers(['profile-reviewer']);
    await onlineLoop('profile-reviewer');

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.currentWuId).toBe(parent.id);
    expect(r.suggestions).toEqual([
      { id: 'auto-review-in-flight', kind: 'status', params: { wuId: parent.id, wuTitle: '登录功能' } },
      {
        id: 'transcribe-review-checklist', kind: 'prompt',
        params: { wuId: parent.id, wuTitle: '登录功能' },
        text: expect.stringContaining('@reviewer'),
      },
    ]);
  });

  it('契约（#446 AC3）：转写清单片预填文案经 @mention 路由解析出目标角色 reviewer', async () => {
    await createParent(); // in_review，宽限内，无子单 → 前置门禁窗口

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    const prompt = r.suggestions.find(s => s.id === 'transcribe-review-checklist');
    expect(prompt?.kind).toBe('prompt');
    expect(typeof prompt?.text).toBe('string');
    expect(detectMention(prompt!.text!)).toBe('reviewer');
  });

  it('双向：评审在途（未完结 review 子单）→ 不出转写清单片', async () => {
    const parent = await createParent();
    await createReviewChild(parent.id, { leaseFresh: true });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions.find(s => s.id === 'transcribe-review-checklist')).toBeUndefined();
  });

  it('in_review 宽限内无子单但无在线 loop → 不出状态片（无接管 fail-closed）；仍出可选转写清单片（#446：窗口内经消息路由人工介入可行）', async () => {
    const parent = await createParent();
    await setMembers(['profile-reviewer']);
    // 有成员但 loop 心跳过期（离线）
    await fileStore.createState('inst-profile-reviewer', {
      id: 'inst-profile-reviewer', roleId: 'profile-reviewer', sessionId: null, status: 'active',
      currentWorkUnitId: null, startedAt: minutesAgo(30), terminatedAt: null,
      lastHeartbeat: minutesAgo(30), metadata: null,
    });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.suggestions.find(s => s.kind === 'status')).toBeUndefined();
    expect(r.suggestions).toEqual([{
      id: 'transcribe-review-checklist', kind: 'prompt',
      params: { wuId: parent.id, wuTitle: '登录功能' },
      text: expect.stringContaining('@reviewer'),
    }]);
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

  it('不可自动评审类型（decision/spec/analysis/review/plan）in_review → 不出片', async () => {
    for (const type of ['decision', 'spec', 'analysis', 'review', 'plan']) {
      await createParent({ type, title: `${type} 单` });
    }
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    // 最新 updatedAt 的是最后一枚（review 类型），同样不出
    expect(r.suggestions).toEqual([]);
  });

  it('当前 WU 派生列为 active/blocked/pending/done/closed → 不出状态说明（unassigned 现为 #445 认领动作片位置，见上方用例）', async () => {
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

  // ─── #487：currentWu 拣选粘性（多单并行不抖动） ───

  /** 直接改快照 updatedAt（模拟 loop 每步簿记 bump，不经状态流转） */
  async function bumpUpdatedAt(wuId: string, iso: string) {
    const s = (await fileStore.getIndex()).find(x => x.id === wuId)!;
    await fileStore.upsertSnapshot({ ...s, updatedAt: iso });
  }

  it('#487：双活跃 WU 交替簿写 → currentWuId 不抖动（领先未超粘性窗口不切换）', async () => {
    const a = await createParent({ status: 'active', title: '工单A' });
    const b = await createParent({ status: 'active', title: '工单B' }); // 后建，updatedAt 最新

    const first = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(first.currentWuId).toBe(b.id);

    // 交替簿写（loop 每步 metadata 簿记都 bump updatedAt）：A 短暂领先 → 不切换；
    // B 再簿写 → 仍 B；A 再领先 → 仍 B。现任未终态且挑战者领先未超窗口 → 保持现任。
    const t0 = Date.now();
    await bumpUpdatedAt(a.id, new Date(t0 + 1_000).toISOString());
    expect((await deriveChannelSuggestions(CHANNEL_ID, { fileStore })).currentWuId).toBe(b.id);
    await bumpUpdatedAt(b.id, new Date(t0 + 2_000).toISOString());
    expect((await deriveChannelSuggestions(CHANNEL_ID, { fileStore })).currentWuId).toBe(b.id);
    await bumpUpdatedAt(a.id, new Date(t0 + 3_000).toISOString());
    expect((await deriveChannelSuggestions(CHANNEL_ID, { fileStore })).currentWuId).toBe(b.id);
  });

  it('#487：现任转入终态 → 立即切换到下一候选（不等粘性窗口）', async () => {
    const a = await createParent({ status: 'active', title: '工单A' });
    const b = await createParent({ status: 'active', title: '工单B' });
    expect((await deriveChannelSuggestions(CHANNEL_ID, { fileStore })).currentWuId).toBe(b.id);

    // b 关闭（终态）——updatedAt 仍最新，但终态现任立即让位
    await bumpUpdatedAt(b.id, nowIso());
    const s = (await fileStore.getIndex()).find(x => x.id === b.id)!;
    await fileStore.upsertSnapshot({ ...s, status: 'closed' });

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.currentWuId).toBe(a.id);
  });

  it('#487：现任长时间静默（挑战者 updatedAt 领先超粘性窗口）→ 切换', async () => {
    const stickyMs = SUGGESTION_TIMING.currentWuStickyMs;
    const a = await createParent({ status: 'active', title: '工单A' });
    const b = await createParent({ status: 'active', title: '工单B' });
    expect((await deriveChannelSuggestions(CHANNEL_ID, { fileStore })).currentWuId).toBe(b.id);

    // b 静默不动，a 持续活跃至领先超过窗口 → 切换（现任已长时间静默，粘性解除）
    const bSnap = (await fileStore.getIndex()).find(x => x.id === b.id)!;
    await bumpUpdatedAt(a.id, new Date(Date.parse(bSnap.updatedAt) + stickyMs + 60_000).toISOString());

    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r.currentWuId).toBe(a.id);
  });

  it('频道不存在 → 空结果不抛出（fail-closed）', async () => {
    const r = await deriveChannelSuggestions('ch-not-exist', { fileStore });
    expect(r).toEqual({ currentWuId: null, suggestions: [], degraded: false });
  });

  // #490：fail-closed 可观测——推导内部读取失败被吞时 degraded=true（仍空 suggestions，
  // 语义不变），正常路径 degraded=false；前端据此区分「真无建议」与「推导失败被吞」
  it('#490：内部读取失败（getIndex 抛错）→ degraded=true + 空 suggestions（fail-closed 语义不变）', async () => {
    vi.spyOn(fileStore, 'getIndex').mockRejectedValueOnce(new Error('index corrupted'));
    const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(r).toEqual({ currentWuId: null, suggestions: [], degraded: true });
  });

  it('#490：失败恢复后正常推导 → degraded=false（degraded 不是粘性状态）', async () => {
    vi.spyOn(fileStore, 'getIndex').mockRejectedValueOnce(new Error('index corrupted'));
    const failed = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(failed.degraded).toBe(true);
    const ok = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
    expect(ok.degraded).toBe(false);
  });

  // ─── #447：「出片 ⟺ 前置条件成立」双向不变量全状态覆盖 ───
  // 状态列（deriveDisplayState 派生列）× 自动化在途/断链 全组合表驱动：
  // 在途 = 自动化信号成立（租约活 / 在线成员 loop / 宽限内）→ 不出催促片（最多只读说明）；
  // 断链 = 无接管 / 超宽限 → 有对应补救片型则出，无片型的列 fail-closed 空白（spec：拿不准不出）。
  describe('#447 全状态不变量矩阵（出片 ⟺ 前置条件成立）', () => {
    /** 把某 WU 快照租约改为活（loop 心跳中）/ 死（租约过期无接管） */
    async function setLease(wuId: string, alive: boolean) {
      const s = (await fileStore.getIndex()).find(x => x.id === wuId)!;
      await fileStore.upsertSnapshot(alive
        ? { ...s, assigneeId: 'inst-dev', claimedAt: nowIso(), timeoutAt: minutesAhead(5) }
        : { ...s, assigneeId: 'inst-dev', claimedAt: minutesAgo(30), timeoutAt: minutesAgo(1) });
    }

    const ids = (list: ChannelSuggestion[]) => list.map(s => s.id).sort();

    interface MatrixCase {
      name: string;
      arrange: () => Promise<void>;
      /** 期望出片 id 集（排序后比较）；空数组 = 不出片 */
      expect: string[];
    }

    const reviewGraceMin = SUGGESTION_TIMING.reviewDispatchInFlightGraceMs / 60_000;
    const claimGraceMin = SUGGESTION_TIMING.unassignedClaimGraceMs / 60_000;

    const cases: MatrixCase[] = [
      // ── unassigned：认领动作片 ⟺ 无接管（无在线 loop）或超宽限 ──
      {
        name: 'unassigned × 在途（在线成员 loop 且宽限内）→ 不出片（涌现认领大概率在途）',
        arrange: async () => {
          await createParent({ status: 'unassigned' });
          await setMembers(['profile-exec']);
          await onlineLoop('profile-exec');
        },
        expect: [],
      },
      {
        name: 'unassigned × 断链（无在线 loop，无人接管）→ 出认领动作片',
        arrange: async () => { await createParent({ status: 'unassigned' }); },
        expect: ['claim-wu'],
      },
      {
        name: 'unassigned × 断链（在线 loop 但已超宽限，迟迟未认领）→ 出认领动作片',
        arrange: async () => {
          await createParent({ status: 'unassigned', ageMin: claimGraceMin + 5 });
          await setMembers(['profile-exec']);
          await onlineLoop('profile-exec');
        },
        expect: ['claim-wu'],
      },
      // ── active：无片型（活正在干）——在途/断链都不出（断链无确定性补救可给，fail-closed 空白） ──
      {
        name: 'active × 在途（本 WU 租约活，loop 在处理）→ 不出片',
        arrange: async () => {
          const wu = await createParent({ status: 'active' });
          await setLease(wu.id, true);
        },
        expect: [],
      },
      {
        name: 'active × 断链（租约过期无接管）→ 不出片（无对应片型，拿不准不出）',
        arrange: async () => {
          const wu = await createParent({ status: 'active' });
          await setLease(wu.id, false);
        },
        expect: [],
      },
      // ── in_review：状态说明 ⟺ 在途；补派动作片 ⟺ 断链；僵死子单 fail-closed ──
      {
        name: 'in_review × 在途（未完结子单租约活）→ 只出只读状态说明',
        arrange: async () => {
          const parent = await createParent();
          await createReviewChild(parent.id, { leaseFresh: true });
        },
        expect: ['auto-review-in-flight'],
      },
      {
        name: 'in_review × 在途（无子单、宽限内、在线 loop，派单在飞）→ 状态说明 + 可选转写清单片',
        arrange: async () => {
          await createParent();
          await setMembers(['profile-reviewer']);
          await onlineLoop('profile-reviewer');
        },
        expect: ['auto-review-in-flight', 'transcribe-review-checklist'],
      },
      {
        name: 'in_review × 断链（超宽限仍无子单，该派未派）→ 出补派评审动作片',
        arrange: async () => { await createParent({ ageMin: reviewGraceMin + 5 }); },
        expect: ['redispatch-review'],
      },
      {
        name: 'in_review × 断链（子单僵死：租约过期无接管）→ 不出片（补派必 409，非本动作可修）',
        arrange: async () => {
          const parent = await createParent({ ageMin: reviewGraceMin + 5 });
          const child = await createReviewChild(parent.id, { leaseFresh: true });
          await setLease(child.id, false);
        },
        expect: [],
      },
      // ── blocked：诊断 prompt 片 ⟺ 无接管（租约不活）且非人闸挂起 ──
      {
        name: 'blocked × 在途（本 WU 租约活，loop 在处理）→ 不出诊断片',
        arrange: async () => {
          const wu = await createParent({ status: 'blocked' });
          await setLease(wu.id, true);
        },
        expect: [],
      },
      {
        name: 'blocked × 断链（租约不活无接管）→ 出诊断阻塞 prompt 片',
        arrange: async () => { await createParent({ status: 'blocked' }); },
        expect: ['diagnose-blocked'],
      },
      // ── pending / done（列）/ closed：人闸与终态无片型，在途/断链都不出 ──
      {
        name: 'pending × 在途（在线 loop）→ 不出片（待确认人闸，人决定）',
        arrange: async () => {
          await createParent({ status: 'pending' });
          await setMembers(['profile-exec']);
          await onlineLoop('profile-exec');
        },
        expect: [],
      },
      {
        name: 'pending × 断链（无在线 loop）→ 不出片',
        arrange: async () => { await createParent({ status: 'pending' }); },
        expect: [],
      },
      {
        name: 'done（列 = done，无 attestations）× 断链 → 不出片（终态）',
        arrange: async () => { await createParent({ status: 'done' }); },
        expect: [],
      },
      {
        name: 'closed × 断链 → 不出片（终态）',
        arrange: async () => { await createParent({ status: 'closed' }); },
        expect: [],
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        await c.arrange();
        const r = await deriveChannelSuggestions(CHANNEL_ID, { fileStore });
        expect(ids(r.suggestions)).toEqual([...c.expect].sort());
      });
    }
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

  it('空频道（无 WU、无成员）→ currentWuId=null + channel-no-members 提示片（#465）', async () => {
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
    expect(body.data).toEqual({
      currentWuId: null,
      suggestions: [{ id: 'channel-no-members', kind: 'status', params: {} }],
      degraded: false,
    });
  });

  // #490：推导失败被吞 → 契约 degraded=true 透传到 HTTP 层（仍 200 + 空 suggestions，fail-closed 语义不变）
  it('#490：推导内部读取失败 → data.degraded=true + 空 suggestions（200 不 5xx）', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-suggestions-degraded', type: 'rnd' }),
    });
    const channel = (await res.json()).data;

    const spy = vi.spyOn(FileStore.prototype, 'getIndex').mockRejectedValueOnce(new Error('index corrupted'));
    try {
      const r = await fetch(`${baseUrl}/${channel.id}/suggestions`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.data).toEqual({ currentWuId: null, suggestions: [], degraded: true });
    } finally {
      spy.mockRestore();
    }
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

  it('blocked 当前工单 → data 携带 prompt 形态建议（#446 diagnose-blocked，含预填指令 text）', async () => {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ch-suggestions-blocked', type: 'rnd' }),
    });
    const channel = (await res.json()).data;

    const parent = await wuService.create({
      type: 'task', scope: '实现登录功能', channelId: channel.id, status: 'blocked',
      metadata: { title: '登录功能', blockReason: 'stuck: 连续 3 步无进展' },
    });

    const r = await fetch(`${baseUrl}/${channel.id}/suggestions`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.currentWuId).toBe(parent.id);
    expect(body.data.suggestions).toEqual([{
      id: 'diagnose-blocked',
      kind: 'prompt',
      params: { wuId: parent.id, wuTitle: '登录功能', blockReason: '连续 3 步无进展' },
      text: expect.stringContaining('@developer'),
    }]);
  });
});
