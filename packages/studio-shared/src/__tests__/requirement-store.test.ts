/**
 * Requirement 存储单元测试（vision §5.3）
 *
 * 覆盖：seq 原子分配（含并发）、REQ id 格式化、CRUD、容错读、index 恢复
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FileStore,
  formatRequirementId,
  type RequirementData,
} from '../file-store';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'req-store-test-'));
}

function makeRequirement(id: string, seq: number, overrides?: Partial<RequirementData>): RequirementData {
  return {
    id,
    seq,
    title: `需求 ${id}`,
    status: 'open',
    channelId: null,
    createdAt: new Date().toISOString(),
    createdBy: 'test',
    ...overrides,
  };
}

describe('Requirement store (vision §5.3)', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('formatRequirementId', () => {
    it('zero-pads to 4 digits', () => {
      expect(formatRequirementId(1)).toBe('REQ-0001');
      expect(formatRequirementId(42)).toBe('REQ-0042');
      expect(formatRequirementId(12345)).toBe('REQ-12345');
    });
  });

  describe('allocateRequirementSeq', () => {
    it('allocates sequential seqs starting from 1', async () => {
      expect(await store.allocateRequirementSeq()).toBe(1);
      expect(await store.allocateRequirementSeq()).toBe(2);
      expect(await store.allocateRequirementSeq()).toBe(3);
    });

    it('allocates unique seqs under concurrent allocation', async () => {
      const seqs = await Promise.all(
        Array.from({ length: 10 }, () => store.allocateRequirementSeq()),
      );
      expect(new Set(seqs).size).toBe(10);
      expect([...seqs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it('recovers from missing index.json (falls back to existing files)', async () => {
      await store.createRequirement(makeRequirement('REQ-0007', 7));
      // 删除 index.json（seq 计数器丢失）
      fs.rmSync(path.join(tmpDir, 'requirements', 'index.json'), { force: true });

      const seq = await store.allocateRequirementSeq();
      expect(seq).toBe(8);
    });

    it('recovers from corrupt index.json', async () => {
      await store.createRequirement(makeRequirement('REQ-0003', 3));
      fs.writeFileSync(path.join(tmpDir, 'requirements', 'index.json'), 'not-json{{{', 'utf-8');

      const seq = await store.allocateRequirementSeq();
      expect(seq).toBe(4);
    });
  });

  describe('CRUD', () => {
    it('creates and reads a requirement', async () => {
      const req = makeRequirement('REQ-0001', 1, { status: 'in-progress', channelId: 'ch-1' });
      await store.createRequirement(req);

      const loaded = await store.getRequirement('REQ-0001');
      expect(loaded).toEqual(req);
    });

    it('getRequirement returns null for missing or corrupt file', async () => {
      expect(await store.getRequirement('REQ-9999')).toBeNull();

      // 损坏文件 → null（容错）
      const dir = path.join(tmpDir, 'requirements');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'REQ-0002.json'), '{{{corrupt', 'utf-8');
      expect(await store.getRequirement('REQ-0002')).toBeNull();
    });

    it('lists requirements sorted by seq, skipping malformed files', async () => {
      await store.createRequirement(makeRequirement('REQ-0002', 2));
      await store.createRequirement(makeRequirement('REQ-0001', 1));
      // 损坏文件 + 结构异常文件 + 非 json 文件 → 全部跳过
      const dir = path.join(tmpDir, 'requirements');
      fs.writeFileSync(path.join(dir, 'REQ-0003.json'), 'broken', 'utf-8');
      fs.writeFileSync(path.join(dir, 'REQ-0004.json'), JSON.stringify({ nope: true }), 'utf-8');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me', 'utf-8');

      const list = await store.listRequirements();
      expect(list.map(r => r.id)).toEqual(['REQ-0001', 'REQ-0002']);
    });

    it('filters list by status and channelId', async () => {
      await store.createRequirement(makeRequirement('REQ-0001', 1, { status: 'open', channelId: 'ch-1' }));
      await store.createRequirement(makeRequirement('REQ-0002', 2, { status: 'done', channelId: 'ch-1' }));
      await store.createRequirement(makeRequirement('REQ-0003', 3, { status: 'open', channelId: 'ch-2' }));

      expect((await store.listRequirements({ status: 'open' })).map(r => r.id)).toEqual(['REQ-0001', 'REQ-0003']);
      expect((await store.listRequirements({ channelId: 'ch-1' })).map(r => r.id)).toEqual(['REQ-0001', 'REQ-0002']);
      expect((await store.listRequirements({ status: 'open', channelId: 'ch-2' })).map(r => r.id)).toEqual(['REQ-0003']);
    });

    it('updates a requirement (id/seq immutable)', async () => {
      await store.createRequirement(makeRequirement('REQ-0001', 1));

      const updated = await store.updateRequirement('REQ-0001', {
        status: 'done',
        title: '新标题',
        docs: ['docs/a.md'],
        // 试图篡改 id/seq — 应被忽略
        ...({ id: 'REQ-9999', seq: 99 } as Partial<RequirementData>),
      });

      expect(updated.id).toBe('REQ-0001');
      expect(updated.seq).toBe(1);
      expect(updated.status).toBe('done');
      expect(updated.title).toBe('新标题');
      expect(updated.docs).toEqual(['docs/a.md']);
    });

    it('updateRequirement throws for missing requirement', async () => {
      await expect(store.updateRequirement('REQ-9999', { status: 'done' })).rejects.toThrow('not found');
    });
  });
});
