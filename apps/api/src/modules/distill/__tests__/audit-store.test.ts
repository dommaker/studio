/**
 * audit-store (#146) — 审计提案持久化测试：墓碑折叠 / findPending / 人判保留集
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { ConstraintAuditStore, type ConstraintAuditProposal } from '../audit-store.js';

let tmpDir: string;
let store: ConstraintAuditStore;

function makeProposal(id: string, constraintIds: string[]): ConstraintAuditProposal {
  return {
    id,
    createdAt: new Date().toISOString(),
    runId: 'run-1',
    suggestions: constraintIds.map(constraintId => ({
      constraintId, category: 'target-gone', rationale: `${constraintId} 作用对象消失`,
    })),
    auditedCount: 7,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-store-'));
  store = new ConstraintAuditStore(new FileStore(tmpDir), path.join(tmpDir, 'distill'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ConstraintAuditStore', () => {
  it('append + list：提案默认 pending，墓碑折叠取最新状态', async () => {
    await store.appendProposal(makeProposal('a-1', ['c1', 'c2']));
    await store.appendProposal(makeProposal('a-2', ['c3']));
    await store.appendStatus('a-1', 'executed');

    const list = await store.listProposals();
    expect(list).toHaveLength(2);
    expect(list.find(p => p.id === 'a-1')).toMatchObject({ status: 'executed', auditedCount: 7 });
    expect(list.find(p => p.id === 'a-2')?.status).toBe('pending');
  });

  it('findPending / getProposal', async () => {
    expect(await store.findPending()).toBeNull();
    await store.appendProposal(makeProposal('a-1', ['c1']));
    expect((await store.findPending())?.id).toBe('a-1');
    expect((await store.getProposal('a-1'))?.suggestions).toHaveLength(1);
    expect(await store.getProposal('nope')).toBeNull();
    await store.appendStatus('a-1', 'rejected');
    expect(await store.findPending()).toBeNull();
  });

  it('rejectedConstraintIds：被拒提案的建议 id 进人判保留集', async () => {
    await store.appendProposal(makeProposal('a-1', ['c1', 'c2']));
    await store.appendProposal(makeProposal('a-2', ['c3']));
    await store.appendStatus('a-1', 'rejected');
    await store.appendStatus('a-2', 'executed');

    const ids = await store.rejectedConstraintIds();
    expect([...ids].sort()).toEqual(['c1', 'c2']); // executed 提案的不算人判保留
  });

  it('空文件 → 空清单', async () => {
    expect(await store.listProposals()).toEqual([]);
    expect(await store.rejectedConstraintIds()).toEqual(new Set());
  });
});
