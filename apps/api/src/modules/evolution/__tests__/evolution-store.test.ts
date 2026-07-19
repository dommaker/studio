/**
 * Evolution 提案存储单元测试（E1 约束进化，复制 Requirement store 模式）。
 *
 * 覆盖：seq 分配（顺序/并发唯一/index 恢复）、create/get/list（status/targetType
 * 过滤、损坏文件容错）、update（不可变 id/seq、未知 id 抛错）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, formatEvolutionId, type EvolutionProposalData } from '@dommaker/studio-shared';

let tmpDir: string;
let fileStore: FileStore;
let seq = 0;

function makeProposal(patch?: Partial<EvolutionProposalData>): EvolutionProposalData {
  seq++;
  return {
    id: formatEvolutionId(seq),
    seq,
    targetType: 'guideline',
    targetId: 'monorepo_app_boundary',
    action: 'amend',
    constraintChange: 'message',
    currentText: '旧文案',
    proposedText: '新文案',
    rationale: '测试理由',
    evidence: { windowHours: 24, eventCounts: { constraintTraces: 8 } },
    status: 'pending',
    source: 'harness-autoEvolve',
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-store-test-'));
  fileStore = new FileStore(tmpDir);
  seq = 0;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FileStore evolution proposals (E1)', () => {
  it('formatEvolutionId pads to 4 digits', () => {
    expect(formatEvolutionId(1)).toBe('EP-0001');
    expect(formatEvolutionId(42)).toBe('EP-0042');
    expect(formatEvolutionId(12345)).toBe('EP-12345');
  });

  it('allocates seqs sequentially', async () => {
    expect(await fileStore.allocateEvolutionSeq()).toBe(1);
    expect(await fileStore.allocateEvolutionSeq()).toBe(2);
    expect(await fileStore.allocateEvolutionSeq()).toBe(3);
  });

  it('allocates unique seqs under concurrency', async () => {
    const seqs = await Promise.all(Array.from({ length: 8 }, () => fileStore.allocateEvolutionSeq()));
    expect(new Set(seqs).size).toBe(8);
    expect([...seqs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('recovers seq from existing files when index.json is missing/stale', async () => {
    await fileStore.createEvolutionProposal(makeProposal({ id: 'EP-0007', seq: 7 }));
    // index.json 落后于现存文件 → 按文件恢复
    const next = await fileStore.allocateEvolutionSeq();
    expect(next).toBe(8);
  });

  it('create/get round-trips a proposal', async () => {
    const p = makeProposal({ id: 'EP-0001', seq: 1 });
    await fileStore.createEvolutionProposal(p);
    expect(await fileStore.getEvolutionProposal('EP-0001')).toEqual(p);
    expect(await fileStore.getEvolutionProposal('EP-9999')).toBeNull();
  });

  it('lists with status/targetType filters, sorted by seq; skips malformed files', async () => {
    await fileStore.createEvolutionProposal(makeProposal({ id: 'EP-0002', seq: 2, status: 'rejected' }));
    await fileStore.createEvolutionProposal(makeProposal({ id: 'EP-0001', seq: 1, targetType: 'role-preset', targetId: 'developer' }));
    // 损坏文件与非 EP 文件被跳过
    fs.writeFileSync(path.join(tmpDir, 'evolution', 'EP-0003.json'), 'not-json', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'evolution', 'random.json'), '{}', 'utf-8');

    const all = await fileStore.listEvolutionProposals();
    expect(all.map(p => p.id)).toEqual(['EP-0001', 'EP-0002']);
    expect((await fileStore.listEvolutionProposals({ status: 'pending' })).map(p => p.id)).toEqual(['EP-0001']);
    expect((await fileStore.listEvolutionProposals({ targetType: 'role-preset' })).map(p => p.id)).toEqual(['EP-0001']);
  });

  it('update patches fields, keeps id/seq immutable, throws for unknown id', async () => {
    await fileStore.createEvolutionProposal(makeProposal({ id: 'EP-0001', seq: 1 }));
    const updated = await fileStore.updateEvolutionProposal('EP-0001', {
      status: 'applied',
      appliedAt: '2026-07-19T00:00:00.000Z',
      id: 'EP-HACK',
      seq: 99,
    } as Partial<EvolutionProposalData>);
    expect(updated.id).toBe('EP-0001');
    expect(updated.seq).toBe(1);
    expect(updated.status).toBe('applied');
    expect(updated.appliedAt).toBe('2026-07-19T00:00:00.000Z');

    await expect(fileStore.updateEvolutionProposal('EP-9999', { status: 'rejected' }))
      .rejects.toThrow('not found');
  });
});
