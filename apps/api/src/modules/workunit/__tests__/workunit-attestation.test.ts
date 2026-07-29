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
});
