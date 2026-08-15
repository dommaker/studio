/**
 * distill-store (#143) — proposals/runs JSONL 持久化测试
 *
 * 覆盖：墓碑折叠（最新状态胜出）、pending 查找、lastRunAt（熔断时钟，任何 outcome）
 * 与 lastConsumedAt（消费基线，仅 executed 且产物 ≥1）的分离语义。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { DistillStore, type DistillProposal, type DistillRun } from '../distill-store.js';

let tmpDir: string;
let store: DistillStore;

function makeProposal(id: string): DistillProposal {
  return {
    id,
    createdAt: new Date().toISOString(),
    materialIds: ['ore-1', 'ore-2'],
    materials: [{ id: 'ore-1', title: 't1' }, { id: 'ore-2', title: 't2' }],
    signals: { topicTags: ['session-summary'], manualCount: 0 },
  };
}

function makeRun(over: Partial<DistillRun>): DistillRun {
  return {
    id: over.id ?? `run-${Math.random().toString(36).slice(2, 8)}`,
    proposalId: 'dp-1',
    executedAt: new Date().toISOString(),
    outcome: 'executed',
    signals: { topicTags: [], manualCount: 0 },
    materialIds: [],
    productIds: [],
    ...over,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-store-'));
  store = new DistillStore(new FileStore(tmpDir), path.join(tmpDir, 'distill'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('proposals 墓碑折叠', () => {
  it('appendProposal 自带 pending 墓碑；后续状态行覆盖', async () => {
    await store.appendProposal(makeProposal('dp-1'));
    expect((await store.getProposal('dp-1'))?.status).toBe('pending');

    await store.appendStatus('dp-1', 'executed');
    const p = (await store.getProposal('dp-1'))!;
    expect(p.status).toBe('executed');
    expect(p.materialIds).toEqual(['ore-1', 'ore-2']); // 墓碑折叠不丢原始字段
  });

  it('findPending 只返回最新状态为 pending 的提案', async () => {
    await store.appendProposal(makeProposal('dp-1'));
    await store.appendProposal(makeProposal('dp-2'));
    await store.appendStatus('dp-1', 'rejected');
    expect((await store.findPending())?.id).toBe('dp-2');
    await store.appendStatus('dp-2', 'failed');
    expect(await store.findPending()).toBeNull();
  });

  it('查无此提案 → null；空文件 → 空列表', async () => {
    expect(await store.getProposal('nope')).toBeNull();
    expect(await store.listProposals()).toEqual([]);
  });
});

describe('runs 双时间戳基线', () => {
  it('lastRunAt：任何 outcome 都推进（含 failed）；lastConsumedAt：仅 executed 且产物 ≥1', async () => {
    expect(await store.lastRunAt()).toBeNull();
    expect(await store.lastConsumedAt()).toBeNull();

    await store.appendRun(makeRun({ executedAt: '2026-08-01T00:00:00.000Z', outcome: 'failed' }));
    expect(await store.lastRunAt()).toBe('2026-08-01T00:00:00.000Z');
    expect(await store.lastConsumedAt()).toBeNull(); // 失败不推进消费基线

    // 空产出 executed：推进熔断时钟，不推进消费基线
    await store.appendRun(makeRun({ executedAt: '2026-08-03T00:00:00.000Z', outcome: 'executed', productIds: [] }));
    expect(await store.lastRunAt()).toBe('2026-08-03T00:00:00.000Z');
    expect(await store.lastConsumedAt()).toBeNull();

    await store.appendRun(makeRun({ executedAt: '2026-08-02T00:00:00.000Z', outcome: 'executed', productIds: ['p-1'] }));
    expect(await store.lastRunAt()).toBe('2026-08-03T00:00:00.000Z'); // max
    expect(await store.lastConsumedAt()).toBe('2026-08-02T00:00:00.000Z');
  });
});
