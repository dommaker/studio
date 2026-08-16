/**
 * F6 证据台账写入单测（2026-07-28 分析文档，决策 1）
 *
 * 覆盖 reviewPassed/reviewRejected 的 attestation 入参：
 *  - agent-review → l2（含 selfReview/ref 透传）
 *  - human-confirm → l3
 *  - rejected 留痕，重审 approved 覆盖同层最新值
 *  - 不带 attestation 的存量调用路径不写台账（双轨期兼容）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-attestation-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventBus.unsubscribeAll?.('workunit.status_changed');
});

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createInReviewWu(): Promise<string> {
  const wu = await wuService.create({ scope: '实现功能 X', type: 'feature', status: 'active' });
  await wuService.transitionStatus(wu.id, 'in_review');
  return wu.id;
}

function attestationsOf(meta: string | null): NonNullable<WorkUnitMetadata['attestations']> {
  const parsed: WorkUnitMetadata = meta ? JSON.parse(meta) : {};
  return parsed.attestations ?? {};
}

describe('F6 attestation 台账写入（reviewPassed/reviewRejected）', () => {
  it('agent-review 通过 → l2 approved，by/ref/selfReview 透传', async () => {
    const id = await createInReviewWu();
    await wuService.reviewPassed(id, {
      by: 'reviewer-1',
      kind: 'agent-review',
      selfReview: true,
      ref: 'wu-child-9',
      summary: '代码质量良好',
    });

    const wu = await wuService.getById(id);
    const att = attestationsOf(wu!.metadata);
    expect(att.l2?.verdict).toBe('approved');
    expect(att.l2?.by).toBe('reviewer-1');
    expect(att.l2?.kind).toBe('agent-review');
    expect(att.l2?.ref).toBe('wu-child-9');
    expect(att.l2?.selfReview).toBe(true);
    expect(att.l2?.summary).toBe('代码质量良好');
    expect(att.l3).toBeUndefined();
  });

  it('human-confirm 通过 → l3 approved', async () => {
    const id = await createInReviewWu();
    await wuService.reviewPassed(id, { by: 'Alice', kind: 'human-confirm' });

    const wu = await wuService.getById(id);
    const att = attestationsOf(wu!.metadata);
    expect(att.l3?.verdict).toBe('approved');
    expect(att.l3?.by).toBe('Alice');
    expect(att.l3?.kind).toBe('human-confirm');
    expect(att.l2).toBeUndefined();
  });

  it('agent-review 拒绝 → l2 rejected 留痕；返工后重审通过覆盖为 approved', async () => {
    const id = await createInReviewWu();
    await wuService.reviewRejected(id, '缺少错误处理', {
      by: 'reviewer-1',
      kind: 'agent-review',
      ref: 'wu-child-1',
    });

    let wu = await wuService.getById(id);
    let att = attestationsOf(wu!.metadata);
    expect(att.l2?.verdict).toBe('rejected');
    expect(att.l2?.summary).toBe('缺少错误处理');

    // 返工：active → in_review → 重审通过
    await wuService.transitionStatus(id, 'in_review');
    await wuService.reviewPassed(id, { by: 'reviewer-1', kind: 'agent-review', ref: 'wu-child-2' });

    wu = await wuService.getById(id);
    att = attestationsOf(wu!.metadata);
    expect(att.l2?.verdict).toBe('approved');
    expect(att.l2?.ref).toBe('wu-child-2');
  });

  it('不带 attestation 的存量调用路径不写台账（双轨期兼容）', async () => {
    const id = await createInReviewWu();
    await wuService.reviewPassed(id);

    const wu = await wuService.getById(id);
    expect(wu!.status).toBe('done');
    expect(attestationsOf(wu!.metadata).l2).toBeUndefined();
  });

  it('#177：reviewPassed 带 defaultTaskAssigneeId → 落 metadata（analysis 确认默认执行角色，analysis-handoff 消费）', async () => {
    const id = await createInReviewWu();
    await wuService.reviewPassed(
      id,
      { by: 'Alice', kind: 'human-confirm' },
      { defaultTaskAssigneeId: 'profile-7' },
    );

    const wu = await wuService.getById(id);
    expect(wu!.status).toBe('done');
    const meta: WorkUnitMetadata = wu!.metadata ? JSON.parse(wu!.metadata) : {};
    expect(meta.defaultTaskAssigneeId).toBe('profile-7');
  });

  it('F6-b：done + human-confirm → 幂等补写 l3（不动状态/时间戳）；agent-review 打 done 仍报错', async () => {
    const id = await createInReviewWu();
    // agent 评审通过 → done + l2
    await wuService.reviewPassed(id, { by: 'reviewer-1', kind: 'agent-review', ref: 'wu-child-1' });
    const before = await wuService.getById(id);
    expect(before!.status).toBe('done');

    // 人工确认补写 l3（人类待办出口）
    await wuService.reviewPassed(id, { by: 'Alice', kind: 'human-confirm' });
    const after = await wuService.getById(id);
    expect(after!.status).toBe('done');
    expect(after!.completedAt?.getTime()).toBe(before!.completedAt?.getTime());
    const att = attestationsOf(after!.metadata);
    expect(att.l2?.verdict).toBe('approved');
    expect(att.l3?.verdict).toBe('approved');
    expect(att.l3?.by).toBe('Alice');

    // 幂等：重复确认覆盖 l3 最新值，不报错
    await wuService.reviewPassed(id, { by: 'Bob', kind: 'human-confirm' });
    expect(attestationsOf((await wuService.getById(id))!.metadata).l3?.by).toBe('Bob');

    // agent-review 对已 done 的 WU 仍是非法迁移（不放宽状态机）
    await expect(wuService.reviewPassed(id, { by: 'reviewer-1', kind: 'agent-review' }))
      .rejects.toThrow('Cannot review');
  });

  it('F6-c（断点 3）：done + agent-review + l2 缺失 → 幂等补写 l2（不动状态/时间戳/不触发合并），发 status_changed', async () => {
    const id = await createInReviewWu();
    // 存量双轨路径：人工直推 done（不带 attestation → 无 l2）
    await wuService.reviewPassed(id);
    const before = await wuService.getById(id);
    expect(before!.status).toBe('done');
    expect(attestationsOf(before!.metadata).l2).toBeUndefined();

    // 迟到的评审结论回传 → 幂等补写 l2，期间应发一次 status_changed（状态值不变也发，pmo rollup 重估）
    let events = 0;
    eventBus.subscribe('workunit.status_changed', (p: { workunit: { id: string } }) => {
      if (p.workunit.id === id) events++;
    });
    await wuService.reviewPassed(id, {
      by: 'reviewer-1',
      kind: 'agent-review',
      ref: 'wu-child-late',
      summary: '迟到但通过',
    });

    const after = await wuService.getById(id);
    expect(after!.status).toBe('done');
    expect(after!.completedAt?.getTime()).toBe(before!.completedAt?.getTime());
    const att = attestationsOf(after!.metadata);
    expect(att.l2?.verdict).toBe('approved');
    expect(att.l2?.kind).toBe('agent-review');
    expect(att.l2?.by).toBe('reviewer-1');
    expect(att.l2?.ref).toBe('wu-child-late');
    expect(events).toBe(1);

    // l2 补全后再回传 agent-review → 仍是非法迁移（幂等口只在 l2 缺失时开放）
    await expect(wuService.reviewPassed(id, { by: 'reviewer-1', kind: 'agent-review' }))
      .rejects.toThrow('Cannot review');
  });

  it('F6-c：done + l2 为 stale rejected → agent-review 补写覆盖为 approved（rejected 不算达成）', async () => {
    const id = await createInReviewWu();
    await wuService.reviewRejected(id, '返工', { by: 'reviewer-1', kind: 'agent-review', ref: 'wu-child-1' });
    // 返工后人工直推 done（双轨期合法路径），l2 停留 rejected
    await wuService.transitionStatus(id, 'in_review');
    await wuService.reviewPassed(id);
    expect(attestationsOf((await wuService.getById(id))!.metadata).l2?.verdict).toBe('rejected');

    await wuService.reviewPassed(id, { by: 'reviewer-1', kind: 'agent-review', ref: 'wu-child-2' });
    const att = attestationsOf((await wuService.getById(id))!.metadata);
    expect(att.l2?.verdict).toBe('approved');
    expect(att.l2?.ref).toBe('wu-child-2');
  });

  it('F6-c（断点 2）recordL1Verification：全绿 → l1 approved + verifyReport，不动 status/verifyFailCount，发 status_changed', async () => {
    const id = await createInReviewWu();
    let events = 0;
    eventBus.subscribe('workunit.status_changed', (p: { workunit: { id: string } }) => {
      if (p.workunit.id === id) events++;
    });

    await wuService.recordL1Verification(id, {
      by: 'Alice',
      ran: ['pnpm run test', 'pnpm run typecheck'],
      source: 'convention',
    });

    const wu = await wuService.getById(id);
    expect(wu!.status).toBe('in_review'); // 不动状态机
    const meta: WorkUnitMetadata = JSON.parse(wu!.metadata!);
    expect(meta.attestations?.l1?.verdict).toBe('approved');
    expect(meta.attestations?.l1?.kind).toBe('verify');
    expect(meta.attestations?.l1?.by).toBe('Alice');
    expect(meta.verifyReport?.commands).toEqual(['pnpm run test', 'pnpm run typecheck']);
    expect(meta.verifyFailCount).toBeUndefined();
    expect(events).toBe(1);
  });

  it('F6-c（断点 2）recordL1Verification：失败 → l1 rejected 留痕，不写 verifyReport（metrics 按存在计通过）', async () => {
    const id = await createInReviewWu();
    await wuService.recordL1Verification(id, {
      by: 'Alice',
      ran: [],
      source: 'override',
      failure: { command: 'make check', tail: 'boom' },
    });

    const wu = await wuService.getById(id);
    const meta: WorkUnitMetadata = JSON.parse(wu!.metadata!);
    expect(meta.attestations?.l1?.verdict).toBe('rejected');
    expect(meta.attestations?.l1?.summary).toContain('make check');
    expect(meta.verifyReport).toBeUndefined();
    expect(meta.verifyFailCount).toBeUndefined();

    // 失败后重跑全绿 → approved 覆盖 + verifyReport 补写
    await wuService.recordL1Verification(id, { by: 'Alice', ran: ['make check'], source: 'override' });
    const meta2: WorkUnitMetadata = JSON.parse((await wuService.getById(id))!.metadata!);
    expect(meta2.attestations?.l1?.verdict).toBe('approved');
    expect(meta2.verifyReport?.commands).toEqual(['make check']);
  });

  it('F6-c（断点 2）recordL1Verification：WU 不存在 → 抛 not found', async () => {
    await expect(wuService.recordL1Verification('wu-x', { by: 'A', ran: [], source: 'convention' }))
      .rejects.toThrow('not found');
  });
});
