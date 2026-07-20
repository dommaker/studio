/**
 * document-store 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 ~/.studio/data/documents 的 save/get/list 与 ~/.studio/projects 的读取。
 * HOME 指向临时目录以隔离真实数据（os.homedir() 在 POSIX 下优先取 $HOME，
 * 模块在设置 HOME 之后动态导入）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
let prevHome: string | undefined;
let store: typeof import('../document-store.js');

function makeDoc(patch?: Partial<import('../document-store.js').DocRecord>) {
  const now = new Date().toISOString();
  return {
    id: 'doc_test_1', projectId: 'p1', companyId: 'c1', type: 'design',
    title: 'T', content: 'C', tags: [], status: 'active', version: 1,
    createdAt: now, updatedAt: now, ...patch,
  };
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-docstore-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmpHome;
  store = await import('../document-store.js');
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('document-store', () => {
  it('listDocs returns [] when documents dir does not exist', async () => {
    expect(await store.listDocs()).toEqual([]);
  });

  it('saveDoc + getDoc round trip', async () => {
    await store.saveDoc(makeDoc());
    const doc = await store.getDoc('doc_test_1');
    expect(doc?.title).toBe('T');
    expect(doc?.projectId).toBe('p1');
  });

  it('getDoc returns null for unknown id', async () => {
    expect(await store.getDoc('doc_nope')).toBeNull();
  });

  it('listDocs returns saved docs and ignores non-json files', async () => {
    await store.saveDoc(makeDoc({ id: 'doc_a' }));
    await store.saveDoc(makeDoc({ id: 'doc_b' }));
    const dir = path.join(tmpHome, '.studio', 'data', 'documents');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
    const docs = await store.listDocs();
    expect(docs.map(d => d.id).sort()).toEqual(['doc_a', 'doc_b', 'doc_test_1']);
  });

  it('getProject / findProjectPmoNumber read project json', async () => {
    const dir = path.join(tmpHome, '.studio', 'projects');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'p1.json'), JSON.stringify({ id: 'p1', pmoNumber: 'PMO-1', title: 'Proj' }));
    expect((await store.getProject('p1'))?.pmoNumber).toBe('PMO-1');
    expect(await store.getProject('missing')).toBeNull();
    expect(await store.findProjectPmoNumber('p1')).toEqual({ pmoNumber: 'PMO-1', title: 'Proj' });
    expect(await store.findProjectPmoNumber('missing')).toBeNull();
  });
});
