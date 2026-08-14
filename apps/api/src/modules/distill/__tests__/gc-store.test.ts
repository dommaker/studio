/**
 * gc-store (#144) — GC 提案持久化测试：墓碑折叠 / findPending / 人判保留集
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { GcStore, type GcProposal } from '../gc-store.js';

let tmpDir: string;
let store: GcStore;

function proposal(id: string, entryIds: string[]): GcProposal {
  return {
    id,
    createdAt: new Date().toISOString(),
    runId: 'run-1',
    candidates: entryIds.map(e => ({
      entryId: e, title: `t-${e}`, zeroRefStreak: 3,
      zeroRefCycles: ['2026-07-01T00:00:00.000Z'], reason: '连续 3 个蒸馏周期零引用',
    })),
    forced: false,
    mainAreaCount: 42,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-store-'));
  store = new GcStore(new FileStore(tmpDir), tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GcStore', () => {
  it('appendProposal 落盘即 pending；墓碑折叠取最新状态', async () => {
    await store.appendProposal(proposal('gc-1', ['e1']));
    await store.appendStatus('gc-1', 'executed');

    const list = await store.listProposals();
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('executed');
    expect(list[0].candidates.map(c => c.entryId)).toEqual(['e1']);
  });

  it('findPending 只回 pending 提案', async () => {
    await store.appendProposal(proposal('gc-1', ['e1']));
    expect((await store.findPending())?.id).toBe('gc-1');
    await store.appendStatus('gc-1', 'rejected');
    expect(await store.findPending()).toBeNull();
  });

  it('getProposal 查无返回 null', async () => {
    expect(await store.getProposal('nope')).toBeNull();
  });

  it('rejectedEntryIds = 所有 rejected 提案的候选并集（人判保留）', async () => {
    await store.appendProposal(proposal('gc-1', ['e1', 'e2']));
    await store.appendProposal(proposal('gc-2', ['e3']));
    await store.appendStatus('gc-1', 'rejected');
    // gc-2 保持 pending，其候选不算人判保留
    expect([...(await store.rejectedEntryIds())].sort()).toEqual(['e1', 'e2']);
  });
});
