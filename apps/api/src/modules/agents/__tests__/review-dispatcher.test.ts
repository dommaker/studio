/**
 * ReviewDispatcher 单测（AC-4.1 ~ AC-4.5 + F4 reviewer 解锚）
 *
 * 覆盖：
 *  - F4: in_review + 频道有其他成员 -> 创建未指派子 WU（assigneeId=null），
 *    metadata.excludeAssignee=实现者 profile id（指名未认领 / 已认领 instance id 两种形态）
 *  - F4 决策 5: 频道内除实现者外无成员 -> 自评兜底（不排除 + selfReview=true + 频道提醒）
 *  - F4: 频道 members 未回填（历史频道）-> 保守按自评兜底
 *  - 已有未完结 review 子 WU -> 跳过（同父唯一性）
 *  - child done + approved -> 父 reviewPassed
 *  - child done + rejected -> 父 reviewRejected
 *  - child done + 无 reviewReport -> 父保持 in_review + 频道转人工（P0 修复，不再默认拒绝）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus, stringifyChannels, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';
import { ReviewDispatcher } from '../loop/review-dispatcher.js';

const { mockPostWuSystemMessage } = vi.hoisted(() => ({ mockPostWuSystemMessage: vi.fn() }));

// wu-messenger 间谍包装：真实发送保留（消息断言不受影响），另断言委托参数（milestone 等）
vi.mock('../../workunit/wu-messenger.js', async (importOriginal) => {
  const orig = await importOriginal() as { postWuSystemMessage: (...args: unknown[]) => Promise<unknown> };
  mockPostWuSystemMessage.mockImplementation(orig.postWuSystemMessage);
  return { ...orig, postWuSystemMessage: mockPostWuSystemMessage };
});

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let dispatcher: ReviewDispatcher;

const reviewerProfile: AgentProfileData = {
  id: 'reviewer-1',
  name: 'Reviewer',
  description: 'code reviewer 角色',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

const executorProfile: AgentProfileData = {
  id: 'executor-1',
  name: 'Executor',
  description: '执行角色',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

function metaOf(raw: string | null): WorkUnitMetadata {
  return raw ? JSON.parse(raw) as WorkUnitMetadata : {};
}

/** 事件链异步收口轮询（替代定长 sleep，防监听器累积/CI 负载下的时序抖动） */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
}

beforeEach(async () => {
  mockPostWuSystemMessage.mockClear(); // 清调用记录（保留间谍包装的实现）
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-dispatcher-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  dispatcher = new ReviewDispatcher(fileStore, wuService);

  // Clean eventBus subscribers between tests
  eventBus.unsubscribeAll?.('workunit.status_changed');

  await fileStore.createProfile(reviewerProfile);
  await fileStore.createProfile(executorProfile);
  await fileStore.createChannel({
    id: 'ch-test',
    name: '#test',
    type: 'rnd',
    defaultWorkspaceId: null,
    defaultPath: null,
    discordChannelId: null,
    discordWebhookUrl: null,
    members: stringifyChannels([reviewerProfile.id, executorProfile.id]),
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  });

  dispatcher.subscribeToEvents();
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createParentAndReview(scope: string, assigneeId: string | null) {
  const parent = await wuService.create({
    scope,
    type: 'feature',
    channelId: 'ch-test',
    assigneeId,
    status: 'active',
  });
  await wuService.transitionStatus(parent.id, 'in_review');
  await new Promise(r => setTimeout(r, 100));
  const snapshots = await fileStore.getIndex();
  return { parent, child: snapshots.find(s => s.parentId === parent.id && s.type === 'review') };
}

describe('ReviewDispatcher (AC-4.1 ~ AC-4.5 + F4)', () => {
  it('AC-4.1 + F4: in_review + 有其他成员 -> 未指派子 WU，excludeAssignee=实现者 profile id', async () => {
    // assigneeId 为 profile id（指名未认领形态）
    const { child } = await createParentAndReview('实现功能 A', executorProfile.id);
    expect(child).toBeDefined();
    expect(child!.assigneeId).toBeNull();
    expect(child!.status).toBe('unassigned');
    const meta = metaOf(child!.metadata);
    expect(meta.excludeAssignee).toBe(executorProfile.id);
    expect(meta.selfReview).toBeUndefined();
  });

  it('F4: assigneeId 为 instance id（已认领形态）-> 经 instance.state.roleId 解析排除实现者', async () => {
    await fileStore.createState('inst-exec-1', {
      id: 'inst-exec-1',
      roleId: executorProfile.id,
      status: 'idle',
      startedAt: '2026-07-01T00:00:00Z',
      terminatedAt: null,
      lastHeartbeat: null,
      metadata: null,
    });

    const { child } = await createParentAndReview('实现功能 A2', 'inst-exec-1');
    expect(child).toBeDefined();
    const meta = metaOf(child!.metadata);
    expect(meta.excludeAssignee).toBe(executorProfile.id);
  });

  it('F4 决策 5: 频道内除实现者外无成员 -> 自评兜底（不排除 + selfReview + 频道提醒）', async () => {
    // Channel with only executor (无其他可评审成员)
    await fileStore.updateChannel('ch-test', {
      members: stringifyChannels([executorProfile.id]),
    });

    const { parent, child } = await createParentAndReview('实现功能 B', executorProfile.id);
    expect(child).toBeDefined(); // 不再静默跳过
    expect(child!.assigneeId).toBeNull();
    const meta = metaOf(child!.metadata);
    expect(meta.excludeAssignee).toBeUndefined();
    expect(meta.selfReview).toBe(true);

    const messages = await fileStore.queryMessages('ch-test', { workUnitId: parent.id });
    const sysMsg = messages.find(m => m.authorType === 'agent' && m.agentName === 'Studio');
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toContain('自评');
  });

  it('F4: 频道 members 未回填（历史频道）-> 保守按自评兜底', async () => {
    await fileStore.updateChannel('ch-test', { members: '[]' });

    const { child } = await createParentAndReview('实现功能 B2', executorProfile.id);
    expect(child).toBeDefined();
    const meta = metaOf(child!.metadata);
    expect(meta.excludeAssignee).toBeUndefined();
    expect(meta.selfReview).toBe(true);
  });

  it('R3: 评审子 WU scope 为 diff-only 输入契约（+code-review + needs-info 出口 + reviewInput 落档）', async () => {
    const { child } = await createParentAndReview('实现功能 R3', executorProfile.id);
    expect(child).toBeDefined();
    expect(child!.scope).toContain('diff-only');
    expect(child!.scope).toContain('+code-review');
    expect(child!.scope).toContain('needs-info');
    expect(child!.scope).toContain('REVIEW_RESULT');
    const meta = metaOf(child!.metadata);
    expect(meta.reviewInput).toEqual({ mode: 'diff-only', skill: 'code-review' });
  });

  it('2026-07-30: 子 WU 不继承父 WU 的会话/执行簿记（防跨 WU 会话续用），域血缘保留', async () => {
    const parent = await wuService.create({
      scope: '实现功能 S',
      type: 'feature',
      channelId: 'ch-test',
      assigneeId: executorProfile.id,
      status: 'active',
      metadata: {
        pmoId: 'proj-1',
        pmoNumber: 'PM-001',
        sessionId: 'sess-parent-123',
        startedAt: '2026-07-29T00:00:00Z',
        sessionResumes: 2,
        stepCount: 3,
        consecutiveStuck: 1,
        _cumulativeTokens: 999,
        lastInputTokens: 123,
        errorType: 'execution_failed',
        errorDetail: 'x',
        errorAt: '2026-07-29T01:00:00Z',
      },
    });
    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const child = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
    expect(child).toBeDefined();
    const meta = metaOf(child!.metadata);
    // 会话/执行簿记一律不继承
    expect(meta.sessionId).toBeUndefined();
    expect(meta.startedAt).toBeUndefined();
    expect(meta.sessionResumes).toBeUndefined();
    expect(meta.stepCount).toBeUndefined();
    expect(meta.consecutiveStuck).toBeUndefined();
    expect(meta._cumulativeTokens).toBeUndefined();
    expect(meta.lastInputTokens).toBeUndefined();
    expect(meta.errorType).toBeUndefined();
    expect(meta.errorDetail).toBeUndefined();
    expect(meta.errorAt).toBeUndefined();
    // 域血缘字段保留
    expect(meta.pmoId).toBe('proj-1');
    expect(meta.pmoNumber).toBe('PM-001');
  });

  it('AC-4.3: 已有未完结 review 子 WU -> 跳过（同父唯一性）', async () => {
    const parent = await wuService.create({
      scope: '实现功能 C',
      type: 'feature',
      channelId: 'ch-test',
      status: 'active',
    });

    // Manually create an existing review child
    await wuService.create({
      scope: '已有审查',
      type: 'review',
      parentId: parent.id,
      assigneeId: reviewerProfile.id,
      channelId: 'ch-test',
      status: 'active',
    });

    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const reviewChildren = snapshots.filter(s => s.parentId === parent.id && s.type === 'review');
    expect(reviewChildren).toHaveLength(1); // 不创建第二个
  });

  it('AC-4.5: child done + approved -> 父 reviewPassed', async () => {
    const { parent, child } = await createParentAndReview('实现功能 D', executorProfile.id);
    expect(child).toBeDefined();

    // Simulate reviewer workflow: claim -> active -> in_review -> write report -> done
    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    const childMeta = metaOf(child!.metadata);
    childMeta.reviewReport = { approved: true, reason: '代码质量良好' };
    await wuService.update(child!.id, { metadata: childMeta });
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const updatedParent = await wuService.getById(parent.id);
    expect(updatedParent!.status).toBe('done');
  });

  it('F6: child done + approved -> 父台账落 l2（agent-review，ref 指回子 WU）', async () => {
    const { parent, child } = await createParentAndReview('实现功能 D2', executorProfile.id);
    expect(child).toBeDefined();

    // 评审者认领（assigneeId = profile id 形态）→ 台账 by 应解析为 reviewer profile id
    await wuService.update(child!.id, { assigneeId: reviewerProfile.id });
    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    const childMeta = metaOf((await wuService.getById(child!.id))!.metadata);
    childMeta.reviewReport = { approved: true, reason: '代码质量良好' };
    await wuService.update(child!.id, { metadata: childMeta });
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const updatedParent = await wuService.getById(parent.id);
    const att = metaOf(updatedParent!.metadata).attestations;
    expect(att?.l2?.verdict).toBe('approved');
    expect(att?.l2?.kind).toBe('agent-review');
    expect(att?.l2?.by).toBe(reviewerProfile.id);
    expect(att?.l2?.ref).toBe(child!.id);
    expect(att?.l2?.selfReview).toBeUndefined();
  });

  it('F6 决策 5: 自评兜底场景 -> 父台账 l2 带 selfReview 标记', async () => {
    await fileStore.updateChannel('ch-test', {
      members: stringifyChannels([executorProfile.id]),
    });
    const { parent, child } = await createParentAndReview('实现功能 D3', executorProfile.id);
    expect(child).toBeDefined();
    expect(metaOf(child!.metadata).selfReview).toBe(true);

    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    const childMeta = metaOf((await wuService.getById(child!.id))!.metadata);
    childMeta.reviewReport = { approved: true };
    await wuService.update(child!.id, { metadata: childMeta });
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const updatedParent = await wuService.getById(parent.id);
    const att = metaOf(updatedParent!.metadata).attestations;
    expect(att?.l2?.verdict).toBe('approved');
    expect(att?.l2?.selfReview).toBe(true);
  });

  it('AC-4.5: child done + rejected -> 父 reviewRejected', async () => {
    const { parent, child } = await createParentAndReview('实现功能 E', executorProfile.id);
    expect(child).toBeDefined();

    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    const childMeta = metaOf(child!.metadata);
    childMeta.reviewReport = { approved: false, reason: '缺少错误处理' };
    await wuService.update(child!.id, { metadata: childMeta });
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const updatedParent = await wuService.getById(parent.id);
    expect(['active', 'blocked']).toContain(updatedParent!.status);
  });

  it('AC-4.5 + P0 修复: child done + 无 reviewReport -> 父保持 in_review，频道转人工（不再默认拒绝）', async () => {
    const { parent, child } = await createParentAndReview('实现功能 F', executorProfile.id);
    expect(child).toBeDefined();

    // Don't set reviewReport - just transition through to done
    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    // P0 修复：解析失败不再默认 reviewRejected（误杀）——父 WU 保持 in_review，
    // 频道发系统消息转人工裁决
    const updatedParent = await wuService.getById(parent.id);
    expect(updatedParent!.status).toBe('in_review');

    const messages = await fileStore.queryMessages('ch-test', { workUnitId: parent.id });
    const sysMsg = messages.find(m => m.authorType === 'agent' && m.agentName === 'Studio' && m.content.includes('转人工'));
    expect(sysMsg).toBeDefined();
    // 2026-07 PMO-flow UX（§6-3）：评审结果转人工 → 以里程碑消息委托 wu-messenger
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: parent.id }),
      expect.stringContaining('转人工'),
      expect.objectContaining({ milestone: true, fileStore }),
    );
  });

  it('PMO 分析接力：analysis WU in_review -> 不派 review 子 WU（人工确认，analysis-handoff 接管）', async () => {
    const analysis = await wuService.create({
      scope: '分析需求 PMO-1: 测试',
      type: 'analysis',
      channelId: 'ch-test',
      assigneeId: executorProfile.id,
      status: 'active',
    });
    await wuService.transitionStatus(analysis.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const reviewChild = snapshots.find(s => s.parentId === analysis.id && s.type === 'review');
    expect(reviewChild).toBeUndefined();
  });

  it('#108: decision/spec WU in_review -> 不派 review 子 WU（人工验收类工单，验收闸 = 人工 in_review）', async () => {
    for (const type of ['decision', 'spec']) {
      const wu = await wuService.create({
        scope: `${type} 单测试`,
        type,
        channelId: 'ch-test',
        assigneeId: executorProfile.id,
        status: 'active',
      });
      await wuService.transitionStatus(wu.id, 'in_review');
      await new Promise(r => setTimeout(r, 100));

      const snapshots = await fileStore.getIndex();
      const reviewChild = snapshots.find(s => s.parentId === wu.id && s.type === 'review');
      expect(reviewChild).toBeUndefined();
    }
  });

  // ─── F6-c 断点 3：dispatchReviewNow 人工补派 ───

  it('F6-c: in_review 父 WU 缺评审子 WU -> dispatchReviewNow 补派成功（未指派 + excludeAssignee=实现者）', async () => {
    // 直接建 in_review（create 只发 workunit.created，不触发路径 A 自动派单）
    const parent = await wuService.create({
      scope: '实现功能 G', type: 'feature', channelId: 'ch-test',
      assigneeId: executorProfile.id, status: 'in_review',
    });

    const child = await dispatcher.dispatchReviewNow(parent.id);

    expect(child.type).toBe('review');
    expect(child.status).toBe('unassigned');
    expect(child.assigneeId).toBeNull();
    expect(child.parentId).toBe(parent.id);
    const meta = metaOf(child.metadata);
    expect(meta.excludeAssignee).toBe(executorProfile.id);
    expect(meta.reviewInput).toEqual({ mode: 'diff-only', skill: 'code-review' });
  });

  it('F6-c: done 父 WU（人工直推，l2 缺失）-> dispatchReviewNow 补派成功', async () => {
    const parent = await wuService.create({
      scope: '实现功能 H', type: 'feature', channelId: 'ch-test',
      assigneeId: executorProfile.id, status: 'in_review',
    });
    await wuService.transitionStatus(parent.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    const child = await dispatcher.dispatchReviewNow(parent.id);
    expect(child.type).toBe('review');
    expect(child.parentId).toBe(parent.id);
  });

  it('F6-c: type=review/analysis -> 拒绝补派（设计如此：analysis 验收闸是人工 L3）', async () => {
    const review = await wuService.create({
      scope: '评审 X', type: 'review', channelId: 'ch-test', status: 'in_review',
    });
    await expect(dispatcher.dispatchReviewNow(review.id)).rejects.toThrow('not reviewable');

    const analysis = await wuService.create({
      scope: '分析 X', type: 'analysis', channelId: 'ch-test', status: 'in_review',
    });
    await expect(dispatcher.dispatchReviewNow(analysis.id)).rejects.toThrow('not reviewable');
  });

  it('#108: type=decision/spec -> 拒绝补派（人工验收类工单，同 analysis 先例）', async () => {
    for (const type of ['decision', 'spec']) {
      const wu = await wuService.create({
        scope: `${type} Y`, type, channelId: 'ch-test', status: 'in_review',
      });
      await expect(dispatcher.dispatchReviewNow(wu.id)).rejects.toThrow('not reviewable');
    }
  });

  it('F6-c: status 不在 in_review/done（active）-> 拒绝补派', async () => {
    const parent = await wuService.create({
      scope: '实现功能 I', type: 'feature', channelId: 'ch-test',
      assigneeId: executorProfile.id, status: 'active',
    });
    await expect(dispatcher.dispatchReviewNow(parent.id)).rejects.toThrow('Cannot dispatch review');
  });

  it('F6-c: l2 已达成 -> 拒绝补派（409 语义）；l2 rejected 留痕 -> 允许重派', async () => {
    const parent = await wuService.create({
      scope: '实现功能 J', type: 'feature', channelId: 'ch-test',
      assigneeId: executorProfile.id, status: 'in_review',
      metadata: {
        attestations: {
          l2: { verdict: 'approved', by: 'reviewer-1', at: '2026-07-30T00:00:00Z', kind: 'agent-review' },
        },
      },
    });
    await expect(dispatcher.dispatchReviewNow(parent.id)).rejects.toThrow('already present');

    const rejected = await wuService.create({
      scope: '实现功能 J2', type: 'feature', channelId: 'ch-test',
      assigneeId: executorProfile.id, status: 'in_review',
      metadata: {
        attestations: {
          l2: { verdict: 'rejected', by: 'reviewer-1', at: '2026-07-30T00:00:00Z', kind: 'agent-review' },
        },
      },
    });
    const child = await dispatcher.dispatchReviewNow(rejected.id);
    expect(child.type).toBe('review');
  });

  it('F6-c: 已有未完结评审子 WU -> 拒绝补派（同父唯一性）', async () => {
    const parent = await wuService.create({
      scope: '实现功能 K', type: 'feature', channelId: 'ch-test',
      assigneeId: executorProfile.id, status: 'in_review',
    });
    await wuService.create({
      scope: '在途评审', type: 'review', parentId: parent.id,
      channelId: 'ch-test', status: 'active',
    });
    await expect(dispatcher.dispatchReviewNow(parent.id)).rejects.toThrow('already in flight');
  });

  it('F6-c: WU 不存在 / 无频道 -> 拒绝补派', async () => {
    await expect(dispatcher.dispatchReviewNow('wu-x')).rejects.toThrow('not found');
    const noChannel = await wuService.create({
      scope: '实现功能 L', type: 'feature', status: 'in_review',
    });
    await expect(dispatcher.dispatchReviewNow(noChannel.id)).rejects.toThrow('no channel');
  });

  // ─── F6-c 断点 3：handleReviewChildDone 对 done 父 WU 的幂等补写 ───

  /** 建父 WU（active → in_review 触发路径 A）并轮询等评审子 WU 落地 */
  async function createParentAndReviewWait(scope: string, assigneeId: string | null) {
    const parent = await wuService.create({
      scope, type: 'feature', channelId: 'ch-test', assigneeId, status: 'active',
    });
    await wuService.transitionStatus(parent.id, 'in_review');
    let child;
    await waitFor(async () => {
      const snapshots = await fileStore.getIndex();
      child = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
      return !!child;
    });
    return { parent, child: child! };
  }

  it('F6-c: 父被人工直推 done（l2 缺失）-> 子 done + approved 补写父台账 l2，状态保持 done', async () => {
    const { parent, child } = await createParentAndReviewWait('实现功能 M', executorProfile.id);

    // 人工直推 done（存量双轨路径，不带 attestation → l2 缺失）
    await wuService.reviewPassed(parent.id);
    expect((await wuService.getById(parent.id))!.status).toBe('done');

    // 评审子 WU 迟到回传 approved
    await wuService.update(child.id, { assigneeId: reviewerProfile.id });
    await wuService.transitionStatus(child.id, 'active');
    await wuService.transitionStatus(child.id, 'in_review');
    const childMeta = metaOf((await wuService.getById(child.id))!.metadata);
    childMeta.reviewReport = { approved: true, reason: '迟到但通过' };
    await wuService.update(child.id, { metadata: childMeta });
    await wuService.transitionStatus(child.id, 'done');

    await waitFor(async () => {
      const p = await wuService.getById(parent.id);
      return metaOf(p!.metadata).attestations?.l2?.verdict === 'approved';
    });
    const updatedParent = await wuService.getById(parent.id);
    expect(updatedParent!.status).toBe('done'); // 不动状态
    const att = metaOf(updatedParent!.metadata).attestations;
    expect(att?.l2?.kind).toBe('agent-review');
    expect(att?.l2?.by).toBe(reviewerProfile.id);
    expect(att?.l2?.ref).toBe(child.id);
  });

  it('F6-c: 父 done（l2 缺失）+ 子 done 无 reviewReport -> 静默跳过，不写台账不发转人工', async () => {
    const { parent, child } = await createParentAndReviewWait('实现功能 N', executorProfile.id);
    await wuService.reviewPassed(parent.id);

    await wuService.transitionStatus(child.id, 'active');
    await wuService.transitionStatus(child.id, 'in_review');
    await wuService.transitionStatus(child.id, 'done');
    await new Promise(r => setTimeout(r, 150)); // 断言「不发生」，给事件链留窗口

    const updatedParent = await wuService.getById(parent.id);
    expect(updatedParent!.status).toBe('done');
    expect(metaOf(updatedParent!.metadata).attestations?.l2).toBeUndefined();
    const messages = await fileStore.queryMessages('ch-test', { workUnitId: parent.id });
    expect(messages.some(m => m.content.includes('转人工'))).toBe(false);
  });

  it('F6-c: 父 done（l2 缺失）+ 子 done rejected -> 不打回已收口 WU，频道发人工复核提醒，l2 保持缺失', async () => {
    const { parent, child } = await createParentAndReviewWait('实现功能 O', executorProfile.id);
    await wuService.reviewPassed(parent.id);

    await wuService.transitionStatus(child.id, 'active');
    await wuService.transitionStatus(child.id, 'in_review');
    const childMeta = metaOf((await wuService.getById(child.id))!.metadata);
    childMeta.reviewReport = { approved: false, reason: '缺少错误处理' };
    await wuService.update(child.id, { metadata: childMeta });
    await wuService.transitionStatus(child.id, 'done');

    let notice;
    await waitFor(async () => {
      const messages = await fileStore.queryMessages('ch-test', { workUnitId: parent.id });
      notice = messages.find(m => m.authorType === 'agent' && m.agentName === 'Studio' && m.content.includes('人工复核'));
      return !!notice;
    });
    expect(notice!.content).toContain('缺少错误处理');

    const updatedParent = await wuService.getById(parent.id);
    expect(updatedParent!.status).toBe('done'); // 不打回
    expect(metaOf(updatedParent!.metadata).attestations?.l2).toBeUndefined();
  });

  it('F6-c: 父 done 且 l2 已达成 -> 子 done 仍跳过（其余情况维持现状）', async () => {
    const { parent, child } = await createParentAndReviewWait('实现功能 P', executorProfile.id);

    // 人工直推 done 并自带 l2 已达成（如另一评审链已落账）
    await wuService.reviewPassed(parent.id, {
      by: 'human-lead', kind: 'agent-review', ref: 'wu-other',
    });
    expect(metaOf((await wuService.getById(parent.id))!.metadata).attestations?.l2?.verdict).toBe('approved');

    await wuService.transitionStatus(child.id, 'active');
    await wuService.transitionStatus(child.id, 'in_review');
    const childMeta = metaOf((await wuService.getById(child.id))!.metadata);
    childMeta.reviewReport = { approved: true, reason: '重复结论' };
    await wuService.update(child.id, { metadata: childMeta });
    await wuService.transitionStatus(child.id, 'done');
    await new Promise(r => setTimeout(r, 150)); // 断言「不发生」，给事件链留窗口

    // l2 保持原值（ref 不被迟到结论覆盖）
    const att = metaOf((await wuService.getById(parent.id))!.metadata).attestations;
    expect(att?.l2?.ref).toBe('wu-other');
  });
});
