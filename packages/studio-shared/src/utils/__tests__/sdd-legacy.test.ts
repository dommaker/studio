/**
 * sdd-legacy — 遗产 SDD 只读区测试
 *
 * 覆盖：纯函数（toKebab / parseSddFrontmatter / stringifySddFrontmatter）+
 * 显式 baseDir 的遗产读取（list / read / findById / find 带 filter）。
 * baseDir 必填：空/非字符串一律抛错，不存在目录读取返回空而非抛错。
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { FileStore } from '../../file-store';
import {
  toKebab,
  parseSddFrontmatter,
  stringifySddFrontmatter,
  listLegacySddDocs,
  readLegacySddDoc,
  findLegacySddDocById,
  findLegacySddDocs,
} from '../sdd-legacy';

const TEST_BASE_DIR = join('/tmp', `sdd-legacy-test-${Date.now()}`);
const store = new FileStore();

beforeAll(async () => {
  mkdirSync(TEST_BASE_DIR, { recursive: true });

  await store.writeDoc(TEST_BASE_DIR, 'legacy-doc-1/requirement', {
    id: 'doc-aaa-111',
    workUnitId: 'goal-xxx-001',
    slug: 'legacy-doc-1',
    title: 'Legacy Doc 1',
    status: 'done',
    tier: 'standard',
    version: 1,
    requirementVersion: 1,
    designVersion: 1,
    taskVersion: 1,
    tags: ['legacy'],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }, '## Requirement\n\nLegacy content');

  await store.writeDoc(TEST_BASE_DIR, 'legacy-doc-2/requirement', {
    id: 'doc-bbb-222',
    slug: 'legacy-doc-2',
    title: 'Legacy Doc 2',
    status: 'stale',
    tier: 'fast',
    version: 1,
    requirementVersion: 1,
    designVersion: 1,
    taskVersion: 1,
    tags: ['legacy'],
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  }, '## Requirement\n\nOther legacy content');
});

afterAll(() => {
  rmSync(TEST_BASE_DIR, { recursive: true, force: true });
});

describe('toKebab', () => {
  test('converts Chinese title to kebab', () => {
    expect(toKebab('添加 JWT 验证')).toBe('add-jwt-auth');
  });

  test('converts English title to kebab', () => {
    expect(toKebab('SDD Knowledge Architecture')).toBe('sdd-knowledge-architecture');
  });

  test('handles empty input', () => {
    const result = toKebab('');
    expect(result).toMatch(/^doc-\d+$/);
  });
});

describe('parseSddFrontmatter', () => {
  test('parses valid frontmatter', () => {
    const content = '---\nid: "abc"\ntitle: "Test"\ntags: ["a", "b"]\n---\n\nBody here';
    const result = parseSddFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.meta.id).toBe('abc');
    expect(result!.meta.title).toBe('Test');
    expect(result!.meta.tags).toEqual(['a', 'b']);
    expect(result!.body).toBe('Body here');
  });

  test('returns null for no frontmatter', () => {
    expect(parseSddFrontmatter('no frontmatter')).toBeNull();
  });
});

describe('stringifySddFrontmatter', () => {
  test('serializes frontmatter', () => {
    const result = stringifySddFrontmatter({
      id: 'abc',
      title: 'Test',
      tags: ['a'],
      version: 1,
    });
    expect(result).toContain('id: "abc"');
    expect(result).toContain('title: "Test"');
    expect(result).toContain('version: 1');
    expect(result).toContain('tags: ["a"]');
  });
});

describe('baseDir 必填', () => {
  test('空/非字符串 baseDir 一律抛错', async () => {
    await expect(listLegacySddDocs('')).rejects.toThrow('baseDir is required');
    await expect(readLegacySddDoc('', 'x', 'requirement')).rejects.toThrow('baseDir is required');
    await expect(findLegacySddDocById(undefined as unknown as string, 'x')).rejects.toThrow('baseDir is required');
    await expect(findLegacySddDocs(null as unknown as string)).rejects.toThrow('baseDir is required');
  });
});

describe('listLegacySddDocs', () => {
  test('列出遗产区所有 slug 目录', async () => {
    const docs = await listLegacySddDocs(TEST_BASE_DIR);
    expect(docs).toContain('legacy-doc-1');
    expect(docs).toContain('legacy-doc-2');
  });

  test('目录不存在 → 返回 []（不抛错）', async () => {
    await expect(listLegacySddDocs(join(TEST_BASE_DIR, 'nonexistent-dir'))).resolves.toEqual([]);
  });
});

describe('readLegacySddDoc', () => {
  test('读取存在的遗产文档', async () => {
    const result = await readLegacySddDoc(TEST_BASE_DIR, 'legacy-doc-1', 'requirement');
    expect(result).not.toBeNull();
    expect(result!.meta.title).toBe('Legacy Doc 1');
    expect(result!.body).toContain('Legacy content');
  });

  test('文档不存在 → null', async () => {
    await expect(readLegacySddDoc(TEST_BASE_DIR, 'nonexistent', 'requirement')).resolves.toBeNull();
  });
});

describe('findLegacySddDocById', () => {
  test('按文档 ID 找到 slug', async () => {
    await expect(findLegacySddDocById(TEST_BASE_DIR, 'doc-aaa-111')).resolves.toBe('legacy-doc-1');
  });

  test('ID 不存在 → null', async () => {
    await expect(findLegacySddDocById(TEST_BASE_DIR, 'doc-nonexistent')).resolves.toBeNull();
  });
});

describe('findLegacySddDocs', () => {
  test('无 filter 返回全部', async () => {
    const results = await findLegacySddDocs(TEST_BASE_DIR);
    const ids = results.map(r => r.id);
    expect(ids).toContain('doc-aaa-111');
    expect(ids).toContain('doc-bbb-222');
  });

  test('按 status 过滤', async () => {
    const results = await findLegacySddDocs(TEST_BASE_DIR, { status: 'done' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('doc-aaa-111');
  });

  test('按 workUnitId 过滤', async () => {
    const results = await findLegacySddDocs(TEST_BASE_DIR, { workUnitId: 'goal-xxx-001' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('doc-aaa-111');
  });

  test('组合 filter 不命中 → 空', async () => {
    const results = await findLegacySddDocs(TEST_BASE_DIR, { status: 'stale', workUnitId: 'goal-xxx-001' });
    expect(results).toEqual([]);
  });
});
