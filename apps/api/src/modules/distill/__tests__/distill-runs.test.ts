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
