/**
 * distill-runs (#351) — 蒸馏运行记录持久化测试
 *
 * 自 distill-store.test.ts 的 runs 部分原样收敛（提案存取测试归 review-proposal/store.test.ts）：
 * runs 双时间戳基线——lastRunAt 任何 outcome 都推进（含 failed）；
 * lastConsumedAt 仅 executed 且产物 ≥1（失败/空产出不推进消费基线）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { DistillRunsStore, type DistillRun } from '../distill-runs.js';

function makeRun(id: string, executedAt: string, outcome: DistillRun['outcome'], productIds: string[] = []): DistillRun {
  return {
    id,
    proposalId: 'p-1',
    executedAt,
    outcome,
    signals: { topicTags: [], manualCount: 0 },
    materialIds: [],
    productIds,
  };
}

let tmpDir: string;
let store: DistillRunsStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-runs-'));
  store = new DistillRunsStore(new FileStore(tmpDir), tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('runs 双时间戳基线', () => {
  it('lastRunAt：任何 outcome 都推进（含 failed）；lastConsumedAt：仅 executed 且产物 ≥1', async () => {
    expect(await store.lastRunAt()).toBeNull();
    expect(await store.lastConsumedAt()).toBeNull();

    await store.appendRun(makeRun('r-1', '2026-08-01T00:00:00.000Z', 'executed', ['prod-1']));
    expect(await store.lastRunAt()).toBe('2026-08-01T00:00:00.000Z');
    expect(await store.lastConsumedAt()).toBe('2026-08-01T00:00:00.000Z');

    // 空产出的 executed：推进 lastRunAt，不推进 lastConsumedAt
    await store.appendRun(makeRun('r-2', '2026-08-02T00:00:00.000Z', 'executed', []));
    expect(await store.lastRunAt()).toBe('2026-08-02T00:00:00.000Z');
    expect(await store.lastConsumedAt()).toBe('2026-08-01T00:00:00.000Z');

    // failed：推进 lastRunAt（烧了 token 触发熔断），不推进 lastConsumedAt（原料不老化）
    await store.appendRun(makeRun('r-3', '2026-08-03T00:00:00.000Z', 'failed'));
    expect(await store.lastRunAt()).toBe('2026-08-03T00:00:00.000Z');
    expect(await store.lastConsumedAt()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('listRuns 原样返回全部记录；乱序写入取最新时间戳', async () => {
    await store.appendRun(makeRun('r-2', '2026-08-02T00:00:00.000Z', 'executed', ['p']));
    await store.appendRun(makeRun('r-1', '2026-08-01T00:00:00.000Z', 'executed', ['p']));
    expect((await store.listRuns()).map(r => r.id)).toEqual(['r-2', 'r-1']);
    expect(await store.lastRunAt()).toBe('2026-08-02T00:00:00.000Z');
  });
});

describe('持久执行状态与恢复投影', () => {
  it('同一 run 的 triggered/running/retry-after/succeeded 追加快照折叠为最新状态', async () => {
    const triggered = {
      ...makeRun('r-state', '2026-08-01T00:00:00.000Z', 'triggered'),
      materialIds: ['m1', 'm2'],
      attempts: 0,
    };
    await store.appendRun(triggered);
    await store.appendRun({
      ...triggered,
      executedAt: '2026-08-01T00:00:01.000Z',
      outcome: 'running',
      attempts: 1,
    });
    await store.appendRun({
      ...triggered,
      executedAt: '2026-08-01T00:00:02.000Z',
      outcome: 'retry-after',
      attempts: 1,
      nextAttemptAt: '2026-08-01T00:00:32.000Z',
      lastError: 'provider timeout',
    });
    await store.appendRun({
      ...triggered,
      executedAt: '2026-08-01T00:00:33.000Z',
      outcome: 'succeeded',
      attempts: 2,
      productIds: ['product-1'],
      nextAttemptAt: undefined,
      lastError: undefined,
    });

    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 'r-state', outcome: 'succeeded', attempts: 2,
      materialIds: ['m1', 'm2'], productIds: ['product-1'],
    });
    expect(runs[0].nextAttemptAt).toBeUndefined();
    expect(runs[0].lastError).toBeUndefined();
    expect(await store.getRun('r-state')).toEqual(runs[0]);
    expect(await store.lastConsumedAt()).toBe('2026-08-01T00:00:33.000Z');
  });

  it('legacy executed/failed 保持可读，legacy error 归一为 lastError', async () => {
    await store.appendRun({
      ...makeRun('legacy-failed', '2026-08-01T00:00:00.000Z', 'failed'),
      error: 'legacy provider error',
    });
    await store.appendRun(makeRun('legacy-executed', '2026-08-02T00:00:00.000Z', 'executed', ['p']));

    const runs = await store.listRuns();
    expect(runs.map(r => r.outcome)).toEqual(['failed', 'executed']);
    expect(runs[0].lastError).toBe('legacy provider error');
    expect(await store.lastConsumedAt()).toBe('2026-08-02T00:00:00.000Z');
  });
});
