/**
 * review-proposal/store (#351) — 通用提案存取测试
 *
 * 覆盖自 distill 三胞胎 store（distill-store/gc-store/audit-store）同构用例收敛而来：
 *   - appendProposal 自带 pending 墓碑；后续状态行覆盖（墓碑折叠取最新状态）
 *   - findPending 只回最新状态为 pending 的提案
 *   - getProposal 查无 → null；空文件 → 空列表
 *   - 状态词表全口径（pending | executed | rejected | failed | card-failed）可落可取
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { ReviewProposalStore } from '../store.js';

interface TestProposal {
  id: string;
  createdAt: string;
  note: string;
}

function makeProposal(id: string): TestProposal {
  return { id, createdAt: new Date().toISOString(), note: `note-${id}` };
}

let tmpDir: string;
let store: ReviewProposalStore<TestProposal>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposal-store-'));
  store = new ReviewProposalStore<TestProposal>(new FileStore(tmpDir), path.join(tmpDir, 'proposals.jsonl'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ReviewProposalStore', () => {
  it('appendProposal 落盘即 pending；墓碑折叠取最新状态', async () => {
    await store.appendProposal(makeProposal('p-1'));
    await store.appendProposal(makeProposal('p-2'));
    await store.appendStatus('p-1', 'executed');

    const list = await store.listProposals();
    expect(list).toHaveLength(2);
    const p1 = list.find(p => p.id === 'p-1')!;
    const p2 = list.find(p => p.id === 'p-2')!;
    expect(p1.status).toBe('executed');
    expect(p1.note).toBe('note-p-1'); // 提案载荷原样保留
    expect(p2.status).toBe('pending');
    expect(p2.statusAt >= p2.createdAt).toBe(true); // pending 墓碑时间戳不早于提案创建
  });

  it('状态词表全口径可落可取（distill 超集：含 failed / card-failed）', async () => {
    await store.appendProposal(makeProposal('p-1'));
    for (const status of ['rejected', 'failed', 'card-failed', 'executed'] as const) {
      await store.appendStatus('p-1', status);
      expect((await store.getProposal('p-1'))!.status).toBe(status);
    }
  });

  it('findPending 只返回最新状态为 pending 的提案', async () => {
    await store.appendProposal(makeProposal('p-1'));
    await store.appendProposal(makeProposal('p-2'));
    await store.appendStatus('p-1', 'rejected');

    expect((await store.findPending())?.id).toBe('p-2');
    await store.appendStatus('p-2', 'card-failed');
    expect(await store.findPending()).toBeNull();
  });

  it('getProposal 查无返回 null；空文件 → 空清单', async () => {
    expect(await store.getProposal('nope')).toBeNull();
    expect(await store.listProposals()).toEqual([]);
    expect(await store.findPending()).toBeNull();
  });
});
