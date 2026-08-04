// agent-loop-record-result.ts 直接单元测试（2026-08-04 拆分后模块级覆盖，不经 AgentLoop 门面）。
// 聚焦模块自身分支：
//   - 早退（skipped / WU 不存在）与 review WU 提交守卫豁免；
//   - 守卫链顺序：提交守卫 / 子任务守卫把 COMPLETE 打回后，验证守卫不再跑；
//   - verifyFailCount 语义（从持久化累计、≥3 转 blocked + blockReason、全绿清零且 l1 approved 覆盖 rejected）；
//   - F6-c 强制收口补 L1：不计 verifyFailCount、本 step COMPLETE 守卫已跑则不重复跑（幂等）、无命令可跑不落台账。
// 门面级套件已有用例（提交守卫细节、DELEGATE、新鲜度、强制收口全绿/失败基本路径）不在此重复。
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；runWuVerification 与 git 探针（agent-loop-workspace）mock 到模块边界。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata, type WorkUnitData } from '../../workunit/workunit.service.js';

const { mockRunWuVerification } = vi.hoisted(() => ({
  mockRunWuVerification: vi.fn(),
}));

vi.mock('../wu-verification', () => ({
  CODE_WORKTREE_TYPES: new Set(['task', 'bug', 'feature', 'refactor']),
  runWuVerification: mockRunWuVerification,
}));

const { mockResolveExecutionCwd, mockHasUncommittedChanges, mockReadHeadHash } = vi.hoisted(() => ({
  mockResolveExecutionCwd: vi.fn(),
  mockHasUncommittedChanges: vi.fn(),
  mockReadHeadHash: vi.fn(),
}));

vi.mock('../agent-loop-workspace', () => ({
  resolveExecutionCwd: mockResolveExecutionCwd,
  hasUncommittedChanges: mockHasUncommittedChanges,
  readHeadHash: mockReadHeadHash,
}));

import { recordResult, type RecordResultDeps } from '../agent-loop-record-result';
import type { StepResult } from '../agent-output-parser';

const mockRole: AgentProfileData = {
  id: 'role-rr',
  name: 'rr-agent',
  description: 'record-result test agent',
  channels: '[]',
  status: 'active',
  provider: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('agent-loop-record-result: recordResult 直接单测', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let deps: RecordResultDeps;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-rr-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-rr-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#rr-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    deps = { workUnitService: wuService, fileStore, role: mockRole };
    // 默认：cwd 可解析、worktree 干净、HEAD 读取跳过无提交监视（个案再覆盖）
    mockResolveExecutionCwd.mockResolvedValue('/tmp/wt');
    mockHasUncommittedChanges.mockReturnValue(false);
    mockReadHeadHash.mockReturnValue(null);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function createWu(type: string, metadata?: WorkUnitMetadata, extra?: { parentId?: string; status?: string }) {
    return wuService.create({
      scope: '实现登录功能', channelId, type,
      status: extra?.status ?? 'active', assigneeId: 'instance-1',
      ...(extra?.parentId ? { parentId: extra.parentId } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  async function record(wu: WorkUnitData, result: StepResult) {
    return recordResult(deps, { workUnit: wu }, result);
  }

  async function metaOf(wuId: string): Promise<WorkUnitMetadata> {
    const wu = (await wuService.getById(wuId))!;
    return JSON.parse(wu.metadata!);
  }

  async function agentTexts(wuId: string): Promise<string[]> {
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wuId });
    return messages.filter(m => m.authorType === 'agent').map(m => m.content);
  }

  describe('早退分支', () => {
    it("action='skipped' → 完全不碰 WU（无 metadata 写回、无守卫、无发帖）", async () => {
      const wu = await createWu('task');

      await record(wu, { action: 'skipped', summary: '测试特征 WU 已由 agentStep 自行关闭' });

      const after = (await wuService.getById(wu.id))!;
      expect(after.status).toBe('active');
      expect(after.metadata).toBe(wu.metadata); // 未被原子写回碰过
      expect(mockResolveExecutionCwd).not.toHaveBeenCalled();
      expect(mockRunWuVerification).not.toHaveBeenCalled();
      expect(await agentTexts(wu.id)).toHaveLength(0);
    });

    it('WU 不存在 → 静默返回（不抛错、不跑守卫、不发帖）', async () => {
      const ghost = { id: 'wu-gone' } as unknown as WorkUnitData;

      await recordResult(deps, { workUnit: ghost }, { action: 'complete', summary: '做完了' });

      expect(mockResolveExecutionCwd).not.toHaveBeenCalled();
      expect(mockRunWuVerification).not.toHaveBeenCalled();
      expect(await fileStore.queryMessages(channelId, {})).toHaveLength(0);
    });
  });

  describe('守卫链：COMPLETE 被前置守卫打回后验证守卫不跑', () => {
    it('review WU 整体豁免提交守卫：cwd 解析不调用，complete 直接收口 done', async () => {
      const wu = await createWu('review');

      await record(wu, { action: 'complete', summary: 'REVIEW_RESULT: {"verdict":"pass"}' });

      expect(mockResolveExecutionCwd).not.toHaveBeenCalled();
      expect(mockHasUncommittedChanges).not.toHaveBeenCalled();
      expect(mockRunWuVerification).not.toHaveBeenCalled(); // review 非代码类，不进验证守卫
      // review 子 WU complete → in_review → done（P0 修复路径，不被二次评审）
      expect((await wuService.getById(wu.id))!.status).toBe('done');
    });

    it('提交守卫命中（未提交改动）→ 降级 progress 保持 active，验证守卫不跑、不落 verifyReport/l1', async () => {
      mockHasUncommittedChanges.mockReturnValue(true);
      const wu = await createWu('task', { worktreePath: '/tmp/wt' });

      await record(wu, { action: 'complete', summary: '做完了' });

      const after = (await wuService.getById(wu.id))!;
      expect(after.status).toBe('active');
      const meta = await metaOf(wu.id);
      expect(meta.commitGuardHint).toContain('未提交改动');
      expect(mockRunWuVerification).not.toHaveBeenCalled();
      expect(meta.verifyReport).toBeUndefined();
      expect(meta.attestations?.l1).toBeUndefined();
    });

    it('子任务守卫命中（未完结子 WU）→ 降级 progress 保持 active，验证守卫不跑', async () => {
      const parent = await createWu('task', { worktreePath: '/tmp/wt' });
      const child = await createWu('task', undefined, { parentId: parent.id });

      await record(parent, { action: 'complete', summary: '父任务完成' });

      const after = (await wuService.getById(parent.id))!;
      expect(after.status).toBe('active');
      const meta = await metaOf(parent.id);
      expect(meta.childGuardHint).toContain(child.id);
      expect(mockRunWuVerification).not.toHaveBeenCalled();
      expect(meta.verifyReport).toBeUndefined();
    });

    it('子任务全部完结 → 守卫链通过，验证全绿正常进 in_review', async () => {
      mockRunWuVerification.mockResolvedValue({ ran: ['make check'], source: 'override' });
      const parent = await createWu('task', { worktreePath: '/tmp/wt' });
      await createWu('task', undefined, { parentId: parent.id, status: 'done' });

      await record(parent, { action: 'complete', summary: '做完了' });

      expect(mockRunWuVerification).toHaveBeenCalledTimes(1);
      const meta = await metaOf(parent.id);
      expect(meta.childGuardHint).toBeUndefined();
      expect((await wuService.getById(parent.id))!.status).toBe('in_review');
    });
  });

  describe('验证守卫触发条件（仅代码类 + worktree + action=complete）', () => {
    it('action=progress 且未超限 → 不跑验证', async () => {
      const wu = await createWu('task', { worktreePath: '/tmp/wt' });

      await record(wu, { action: 'progress', summary: '推进中' });

      expect(mockRunWuVerification).not.toHaveBeenCalled();
      expect((await wuService.getById(wu.id))!.status).toBe('active');
    });

    it('代码类 WU 但无 worktreePath → COMPLETE 跳过验证直接 in_review', async () => {
      const wu = await createWu('task'); // 无 worktreePath 落档

      await record(wu, { action: 'complete', summary: '做完了' });

      expect(mockRunWuVerification).not.toHaveBeenCalled();
      const meta = await metaOf(wu.id);
      expect(meta.verifyReport).toBeUndefined();
      expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    });
  });

  describe('verifyFailCount 语义', () => {
    it('失败从持久化计数累加（1→2）：l1 rejected 留痕、降级 progress 保持 active、不达 blocked', async () => {
      mockRunWuVerification.mockResolvedValue({
        ran: [], source: 'override',
        failure: { command: 'pnpm run test', tail: 'boom-tail' },
      });
      const wu = await createWu('task', { worktreePath: '/tmp/wt', verifyFailCount: 1 });

      await record(wu, { action: 'complete', summary: '做完了' });

      const after = (await wuService.getById(wu.id))!;
      expect(after.status).toBe('active');
      const meta = await metaOf(wu.id);
      expect(meta.verifyFailCount).toBe(2);
      expect(meta.verifyFailHint).toContain('第 2 次');
      expect(meta.verifyFailHint).toContain('pnpm run test');
      expect(meta.verifyFailHint).toContain('boom-tail');
      expect(meta.attestations?.l1?.verdict).toBe('rejected');
      expect(meta.attestations?.l1?.by).toBe('role-rr');
      expect(meta.attestations?.l1?.kind).toBe('verify');
      expect(meta.verifyReport).toBeUndefined();
      // 打回按 progress 处理：摘要仍发频道
      expect((await agentTexts(wu.id)).some(t => t.includes('做完了'))).toBe(true);
    });

    it('第 3 次失败 → blocked + blockReason 落盘 + 频道说明一次（摘要不再按 progress 发帖）', async () => {
      mockRunWuVerification.mockResolvedValue({
        ran: [], source: 'override',
        failure: { command: 'make check', tail: 'tail' },
      });
      const wu = await createWu('task', { worktreePath: '/tmp/wt', verifyFailCount: 2 });

      await record(wu, { action: 'complete', summary: '做完了' });

      const after = (await wuService.getById(wu.id))!;
      expect(after.status).toBe('blocked');
      const meta = await metaOf(wu.id);
      expect(meta.verifyFailCount).toBe(3);
      expect(meta.blockReason).toBe('verify-failed x3: 自动验证连续失败');
      const texts = await agentTexts(wu.id);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('自动验证连续失败 3 次');
      expect(texts[0]).toContain('blocked');
    });

    it('全绿 → verifyFailCount 清零、verifyReport 落档、l1 approved 覆盖前次 rejected', async () => {
      mockRunWuVerification.mockResolvedValue({ ran: ['make check', './ci.sh'], source: 'override' });
      const wu = await createWu('task', {
        worktreePath: '/tmp/wt',
        verifyFailCount: 2,
        attestations: {
          l1: { verdict: 'rejected', by: 'role-rr', at: new Date().toISOString(), kind: 'verify', summary: '失败命令: make check' },
        },
      });

      await record(wu, { action: 'complete', summary: '做完了' });

      expect((await wuService.getById(wu.id))!.status).toBe('in_review');
      const meta = await metaOf(wu.id);
      expect(meta.verifyFailCount).toBe(0);
      expect(meta.verifyReport).toMatchObject({ commands: ['make check', './ci.sh'], source: 'override' });
      expect(meta.attestations?.l1?.verdict).toBe('approved');
      expect(meta.attestations?.l1?.kind).toBe('verify');
      // 验证全绿简报发频道
      const texts = await agentTexts(wu.id);
      expect(texts.some(t => t.includes('自动验证通过') && t.includes('make check'))).toBe(true);
    });
  });

  describe('F6-c 强制收口补 L1', () => {
    it('progress 超限 + 全绿 → l1 approved + verifyReport；verifyFailCount 保持不动（不计数）', async () => {
      mockRunWuVerification.mockResolvedValue({ ran: ['make check'], source: 'convention' });
      const wu = await createWu('task', { worktreePath: '/tmp/wt', stepCount: 15, verifyFailCount: 2 });

      await record(wu, { action: 'progress', summary: '继续中' });

      expect(mockRunWuVerification).toHaveBeenCalledTimes(1);
      const after = (await wuService.getById(wu.id))!;
      expect(after.status).toBe('in_review');
      const meta = await metaOf(wu.id);
      expect(meta.stepCount).toBe(16);
      expect(meta.attestations?.l1?.verdict).toBe('approved');
      expect(meta.attestations?.l1?.kind).toBe('verify');
      expect(meta.verifyReport?.commands).toEqual(['make check']);
      expect(meta.verifyFailCount).toBe(2); // 强制收口不动 verifyFailCount
      // 超限收口说明发频道（progress 摘要因提前 return 不发）
      const texts = await agentTexts(wu.id);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain('步骤数超限');
    });

    it('progress 超限 + 失败 → 仍 in_review + l1 rejected，verifyFailCount 不动、不写 verifyReport', async () => {
      mockRunWuVerification.mockResolvedValue({
        ran: [], source: 'convention',
        failure: { command: 'make check', tail: 'tail' },
      });
      const wu = await createWu('task', { worktreePath: '/tmp/wt', stepCount: 15, verifyFailCount: 1 });

      await record(wu, { action: 'progress', summary: '继续中' });

      expect((await wuService.getById(wu.id))!.status).toBe('in_review');
      const meta = await metaOf(wu.id);
      expect(meta.attestations?.l1?.verdict).toBe('rejected');
      expect(meta.attestations?.l1?.summary).toContain('make check');
      expect(meta.verifyFailCount).toBe(1); // 不动
      expect(meta.verifyReport).toBeUndefined();
    });

    it('幂等：COMPLETE 本 step 已跑验证（失败打回）→ 超限收口不重复跑（仅一次调用）', async () => {
      mockRunWuVerification.mockResolvedValue({
        ran: [], source: 'override',
        failure: { command: 'make check', tail: 'tail' },
      });
      const wu = await createWu('task', { worktreePath: '/tmp/wt', stepCount: 15 });

      await record(wu, { action: 'complete', summary: '做完了' });

      // COMPLETE 守卫已跑过（verifyGuardRan=true）→ 强制收口路径不再跑第二次
      expect(mockRunWuVerification).toHaveBeenCalledTimes(1);
      const meta = await metaOf(wu.id);
      expect(meta.verifyFailCount).toBe(1); // 守卫计 1 次；强制收口未再加、未 blocked（<3）
      expect(meta.attestations?.l1?.verdict).toBe('rejected');
      // 未达 blocked 阈值，最终按步骤超限强制 in_review
      expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    });

    it('超限但无命令可跑（ran 空且无 failure）→ 不落 attestation/verifyReport，仍 in_review', async () => {
      mockRunWuVerification.mockResolvedValue({ ran: [], source: 'convention' });
      const wu = await createWu('task', { worktreePath: '/tmp/wt', stepCount: 15 });

      await record(wu, { action: 'progress', summary: '继续中' });

      expect(mockRunWuVerification).toHaveBeenCalledTimes(1);
      const meta = await metaOf(wu.id);
      expect(meta.attestations?.l1).toBeUndefined();
      expect(meta.verifyReport).toBeUndefined();
      expect((await wuService.getById(wu.id))!.status).toBe('in_review');
    });
  });
});
