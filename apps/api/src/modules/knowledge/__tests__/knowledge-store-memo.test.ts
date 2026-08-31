/**
 * MtimeMemoKnowledgeStore 测试（#343：知识库存储栈过缓存 seam 决策树）
 *
 * 语义基线：包装后对外行为 = 底层 FileKnowledgeStore 逐字节等价，
 * 差异只有性能（同指纹重复读不重扫磁盘）。正确性锚点：
 * - mtime+size 指纹校验 → 跨进程外部写（本进程外另一个 store 实例模拟）必被看见
 * - 本进程写穿透（save/update/delete/rebuildIndex 后立即可读新值）
 * - 返回对象按次深克隆（调用方变更不得污染 memo，保持底层 store 每次
 *   返回全新对象的既有语义——recordOutcome 等调用方会原地改嵌套数组）
 * - readEntriesFromDisk / snapshot / getSurvivalRate 直通（显式磁盘核对路径不缓存）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileKnowledgeStore } from '@dommaker/harness';
import type { KnowledgeEntry } from '@dommaker/harness';
import { setReadMetricsSink } from '@dommaker/studio-shared/read-metrics';
import { MtimeMemoKnowledgeStore } from '../knowledge-store-memo.js';

function makeEntry(over: Partial<KnowledgeEntry> & { id: string }): KnowledgeEntry {
  return {
    type: 'guideline',
    title: `t-${over.id}`,
    content: `c-${over.id}`,
    maturity: 'active',
    layer: 'project',
    created: '2026-08-28T00:00:00.000Z',
    lastReferenced: '',
    contributors: [],
    projects: [],
    tags: ['seed'],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: [],
    consumptionMode: 'reference',
    origin: 'agent',
    ...over,
  } as KnowledgeEntry;
}

describe('MtimeMemoKnowledgeStore', () => {
  let dir: string;
  let raw: FileKnowledgeStore;
  let store: MtimeMemoKnowledgeStore;
  /** 模拟另一个进程：同一目录上的独立 store 实例 */
  let other: FileKnowledgeStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-memo-'));
    raw = new FileKnowledgeStore({ baseDir: dir });
    raw.save(makeEntry({ id: 'kb1' }));
    raw.save(makeEntry({ id: 'kb2', tags: ['seed', 'extra'] }));
    raw.save(makeEntry({ id: 'kb3', maturity: 'archived' }));
    other = new FileKnowledgeStore({ baseDir: dir });
    store = new MtimeMemoKnowledgeStore(raw);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    setReadMetricsSink(null);
  });

  it('passes getBaseDir through', () => {
    expect(store.getBaseDir()).toBe(raw.getBaseDir());
  });

  it('repeated list with the same filter does not rescan the underlying store', () => {
    const spy = vi.spyOn(raw, 'list');
    const first = store.list({});
    expect(first.map(e => e.id).sort()).toEqual(['kb1', 'kb2']);
    const second = store.list({});
    expect(second.map(e => e.id)).toEqual(first.map(e => e.id));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('distinct filters are memoized independently', () => {
    const spy = vi.spyOn(raw, 'list');
    store.list({ tags: ['seed'] });
    store.list({ tags: ['seed', 'extra'] });
    store.list({ tags: ['seed'] });
    store.list({ tags: ['seed', 'extra'] });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('sees external cross-process writes via mtime/size fingerprint', () => {
    store.list({});
    other.update('kb1', { content: 'changed-external-longer-content' });
    const fresh = store.list({});
    expect(fresh.find(e => e.id === 'kb1')?.content).toBe('changed-external-longer-content');
  });

  it('sees externally added entries', () => {
    store.list({});
    other.save(makeEntry({ id: 'kb4' }));
    const ids = store.list({}).map(e => e.id);
    expect(ids).toContain('kb4');
  });

  it('sees externally deleted entries', () => {
    store.list({});
    expect(other.delete('kb2')).toBe(true);
    const ids = store.list({}).map(e => e.id);
    expect(ids).not.toContain('kb2');
  });

  it('write-through: save is immediately visible and busts the memo once', () => {
    const spy = vi.spyOn(raw, 'list');
    store.list({});
    store.save(makeEntry({ id: 'kb1', content: 'saved-through-wrapper' }));
    const fresh = store.list({});
    expect(fresh.find(e => e.id === 'kb1')?.content).toBe('saved-through-wrapper');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('write-through: update and delete are immediately visible', () => {
    store.update('kb1', { title: 'updated-title' });
    expect(store.get('kb1')?.title).toBe('updated-title');

    store.delete('kb2');
    expect(store.get('kb2')).toBeUndefined();
    expect(store.list({}).map(e => e.id)).not.toContain('kb2');
  });

  it('write-through: rebuildIndex picks up hand-written files', () => {
    const orphan = makeEntry({ id: 'kb9' });
    const frontmatter = [
      '---',
      `id: ${orphan.id}`,
      `type: ${orphan.type}`,
      `title: ${orphan.title}`,
      `maturity: ${orphan.maturity}`,
      `layer: ${orphan.layer}`,
      `created: ${orphan.created}`,
      '---',
      '',
      orphan.content,
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'guideline-kb9.md'), frontmatter, 'utf-8');
    store.rebuildIndex();
    expect(store.list({}).map(e => e.id)).toContain('kb9');
  });

  it('get is memoized and invalidated by external writes', () => {
    const spy = vi.spyOn(raw, 'get');
    expect(store.get('kb1')?.id).toBe('kb1');
    expect(store.get('kb1')?.id).toBe('kb1');
    expect(spy).toHaveBeenCalledTimes(1);
    other.update('kb1', { content: 'external-get-update' });
    expect(store.get('kb1')?.content).toBe('external-get-update');
  });

  it('returns deep-fresh objects per read — caller mutation never poisons the memo', () => {
    const first = store.list({});
    first[0].tags.push('mutated-list');
    first[0].referencedBy.push('mutated-ref');
    const again = store.list({});
    expect(again[0].tags).toEqual(['seed']);
    expect(again[0].referencedBy).toEqual([]);

    const g1 = store.get('kb2');
    g1?.tags.push('mutated-get');
    expect(store.get('kb2')?.tags).toEqual(['seed', 'extra']);
  });

  it('readIndex is memoized and invalidated by external index rewrites', () => {
    const spy = vi.spyOn(raw, 'readIndex');
    expect(store.readIndex().length).toBe(3);
    expect(store.readIndex().length).toBe(3);
    expect(spy).toHaveBeenCalledTimes(1);
    other.save(makeEntry({ id: 'kb5' }));
    expect(store.readIndex().map(e => e.id)).toContain('kb5');
  });

  it('readEntriesFromDisk stays a raw passthrough (explicit disk audit path)', () => {
    const spy = vi.spyOn(raw, 'readEntriesFromDisk');
    store.readEntriesFromDisk();
    store.readEntriesFromDisk();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('snapshot and getSurvivalRate pass through', () => {
    const snapPath = store.snapshot();
    expect(fs.existsSync(snapPath)).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    expect(store.getSnapshot(today)?.length).toBe(3);
    expect(store.getSurvivalRate(0)?.total).toBe(3);
  });

  it('emits knowledge-read read-metrics with cacheHit semantics', () => {
    const events: Array<{ op: string; file: string; cacheHit: boolean }> = [];
    setReadMetricsSink(e => events.push({ op: e.op, file: e.file, cacheHit: e.cacheHit }));
    store.list({});
    store.list({});
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ op: 'knowledgeRead', file: dir, cacheHit: false });
    expect(events[1]).toMatchObject({ op: 'knowledgeRead', file: dir, cacheHit: true });
  });
});
