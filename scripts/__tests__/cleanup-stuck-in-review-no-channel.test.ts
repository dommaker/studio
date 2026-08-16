/**
 * cleanup-stuck-in-review-no-channel.ts — #186（#167 决议 4）存量清理脚本测试
 *
 * 在 tmp --root 上构造 fixture：
 *   命中：in_review + analysis + channelId=null + metadata.triggerId（trigger 巡检单）
 *   不命中：有频道 / 非 trigger / 非 analysis / 非 in_review
 * 验证 dry-run 不改盘、apply 置 closed + cleanupNote 留痕、并发重读跳过状态已变单。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, type WorkUnitSnapshot, type WorkUnitEvent } from '../../packages/studio-shared/src/index';
import { runCleanup, formatSummary, CLEANUP_NOTE } from '../cleanup-stuck-in-review-no-channel';

let studioRoot: string;
let fileStore: FileStore;

function makeSnapshot(id: string, over: Partial<WorkUnitSnapshot> & { metadataObj?: Record<string, unknown> }): WorkUnitSnapshot {
  const { metadataObj, ...rest } = over;
  const now = new Date().toISOString();
  return {
    id,
    parentId: null,
    type: 'analysis',
    scope: `scope-${id}`,
    assigneeId: null,
    status: 'in_review',
    failureType: null,
    retryCount: 0,
    timeoutAt: null,
    channelId: null,
    projectPath: null,
    workspaceId: null,
    reqId: null,
    metadata: metadataObj ? JSON.stringify(metadataObj) : null,
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    completedAt: null,
    ...rest,
  };
}

async function seed(snapshot: WorkUnitSnapshot): Promise<void> {
  const event: WorkUnitEvent = {
    type: 'created',
    wuId: snapshot.id,
    timestamp: snapshot.createdAt,
    data: snapshot as unknown as Record<string, unknown>,
  };
  await fileStore.commitSnapshot(event, snapshot);
}

beforeEach(async () => {
  studioRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-stuck-review-'));
  fileStore = new FileStore(path.join(studioRoot, 'data'));

  // 命中 ×2：trigger 巡检单（knowledge-quality / session-knowledge-extraction 形态）
  await seed(makeSnapshot('hit-1', {
    metadataObj: { triggerId: 'knowledge-quality', triggerSource: 'trigger-registry', triggeredAt: '2026-08-01T00:00:00Z' },
  }));
  await seed(makeSnapshot('hit-2', {
    metadataObj: { triggerId: 'session-knowledge-extraction', triggerSource: 'trigger-registry', triggeredAt: '2026-07-30T00:00:00Z' },
  }));
  // 不命中：有频道（走频道确认闸）
  await seed(makeSnapshot('miss-channel', {
    channelId: 'ch-1',
    metadataObj: { triggerId: 'knowledge-quality', triggerSource: 'trigger-registry' },
  }));
  // 不命中：无 trigger 溯源（非 trigger 来源）
  await seed(makeSnapshot('miss-no-trigger', { metadataObj: {} }));
  // 不命中：非 analysis 类型
  await seed(makeSnapshot('miss-type', {
    type: 'task',
    metadataObj: { triggerId: 'knowledge-quality', triggerSource: 'trigger-registry' },
  }));
  // 不命中：非 in_review 状态
  await seed(makeSnapshot('miss-status', {
    status: 'done',
    metadataObj: { triggerId: 'knowledge-quality', triggerSource: 'trigger-registry' },
  }));
});

afterEach(() => {
  fs.rmSync(studioRoot, { recursive: true, force: true });
});

describe('cleanup-stuck-in-review-no-channel（#186 / #167 决议 4）', () => {
  it('dry-run：列出命中清单但不改盘', async () => {
    const summary = await runCleanup({ studioRoot, apply: false });
    expect(summary.mode).toBe('dry-run');
    expect(summary.targets.map(t => t.id).sort()).toEqual(['hit-1', 'hit-2']);
    expect(summary.closed).toEqual([]);

    const index = await fileStore.getIndex();
    expect(index.find(s => s.id === 'hit-1')!.status).toBe('in_review');
    expect(index.find(s => s.id === 'hit-2')!.status).toBe('in_review');
  });

  it('apply：命中单置 closed + cleanupNote 留痕，其他单一律不动', async () => {
    const summary = await runCleanup({ studioRoot, apply: true });
    expect(summary.closed.sort()).toEqual(['hit-1', 'hit-2']);
    expect(summary.failed).toEqual([]);

    const index = await fileStore.getIndex();
    for (const id of ['hit-1', 'hit-2']) {
      const s = index.find(x => x.id === id)!;
      expect(s.status).toBe('closed');
      expect(s.completedAt).toBeTruthy();
      const meta = JSON.parse(s.metadata!) as Record<string, unknown>;
      expect(meta.cleanupNote).toBe(CLEANUP_NOTE);
      // trigger 溯源保留（不被清理覆写）
      expect(meta.triggerId).toBeTruthy();
    }
    // 不命中的保持原状
    expect(index.find(s => s.id === 'miss-channel')!.status).toBe('in_review');
    expect(index.find(s => s.id === 'miss-no-trigger')!.status).toBe('in_review');
    expect(index.find(s => s.id === 'miss-type')!.status).toBe('in_review');
    expect(index.find(s => s.id === 'miss-status')!.status).toBe('done');
  });

  it('apply：并发竞态保护——dry-run 后状态已变的单不再命中、不被覆盖', async () => {
    // 先 dry-run 拿清单，再把 hit-1 改成 done（模拟评审回传并发写）
    const dry = await runCleanup({ studioRoot, apply: false });
    expect(dry.targets.map(t => t.id).sort()).toEqual(['hit-1', 'hit-2']);
    const current = (await fileStore.getIndex()).find(s => s.id === 'hit-1')!;
    const isoNow = new Date().toISOString();
    const updated: WorkUnitSnapshot = { ...current, status: 'done', completedAt: isoNow, updatedAt: isoNow };
    await fileStore.commitSnapshot(
      { type: 'completed', wuId: 'hit-1', timestamp: isoNow, data: updated as unknown as Record<string, unknown> },
      updated,
    );

    // apply 重新取数：hit-1 已不满足命中条件 → 不进清单、不动；hit-2 照常关闭
    const summary = await runCleanup({ studioRoot, apply: true });
    expect(summary.closed).toEqual(['hit-2']);
    expect(summary.targets.map(t => t.id)).toEqual(['hit-2']);
    expect((await fileStore.getIndex()).find(s => s.id === 'hit-1')!.status).toBe('done');
  });

  it('formatSummary：输出命中条件与结果计数', async () => {
    const summary = await runCleanup({ studioRoot, apply: false });
    const text = formatSummary(summary);
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('hit-1');
    expect(text).toContain(CLEANUP_NOTE);
  });
});
