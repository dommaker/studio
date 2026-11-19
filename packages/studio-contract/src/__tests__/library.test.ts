/**
 * library 域契约测试：kind 词表 + query/响应壳边界。
 * schema 即正本；同名类型为 z.infer alias / import type 同源，由编译期断言锚定，无 parity 互验层。
 */

import { describe, it, expect } from 'vitest';
import {
  libraryKindSchema,
  type LibraryListItem,
  type LibraryDocDetail,
  listLibraryDocsQuerySchema,
  libraryListResponseSchema,
  libraryDocDetailResponseSchema,
} from '../library.js';
import * as contractIndex from '../index.js';

const listItemRow: LibraryListItem = {
  id: 'PMO-7:specs/login.md',
  title: '登录需求',
  kind: 'spec',
  legacy: false,
  projectId: 'PMO-7',
  pmoNumber: 'PMO-7',
  path: 'specs/login.md',
  status: 'frozen',
  tags: ['auth'],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

const docDetailRow: LibraryDocDetail = {
  ...listItemRow,
  content: '# 登录需求\n正文',
};

describe('libraryKindSchema', () => {
  it('kind 词表 = spec/research/adr/context/legacy', () => {
    for (const k of ['spec', 'research', 'adr', 'context', 'legacy']) {
      expect(libraryKindSchema.parse(k)).toBe(k);
    }
    expect(() => libraryKindSchema.parse('wiki')).toThrow();
  });
});

describe('请求 / 响应壳', () => {
  it('GET / query：project/search 均可选', () => {
    expect(listLibraryDocsQuerySchema.parse({}).project).toBeUndefined();
    expect(listLibraryDocsQuerySchema.parse({ project: 'PMO-7', search: '登录' }).search).toBe('登录');
  });

  it('list / detail 响应 = { data } 壳（success 标志退役）', () => {
    expect(libraryListResponseSchema.parse({ data: [listItemRow] }).data).toHaveLength(1);
    expect(libraryDocDetailResponseSchema.parse({ data: docDetailRow }).data.content).toContain('正文');
  });
});

describe('index.ts 出口', () => {
  it('library 域 schema 经 index 导出', () => {
    expect(contractIndex.libraryListItemSchema).toBeDefined();
    expect(contractIndex.libraryDocDetailResponseSchema).toBeDefined();
  });
});
