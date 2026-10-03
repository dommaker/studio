/**
 * library 域契约测试：LibraryListItem/LibraryDocDetail parity + query/响应壳边界。
 * 正本 = library.service.ts（LibraryListItem/LibraryDocDetail）+ library.routes.ts 实测 wire。
 */

import { describe, it, expect } from 'vitest';
import {
  libraryKindSchema,
  libraryListItemSchema,
  type LibraryListItem,
  libraryDocDetailSchema,
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

describe('手写 interface parity（z.infer 退化规避）', () => {
  it('parity：LibraryListItem fixture 通过校验；必填字段删除即拒', () => {
    expect(libraryListItemSchema.parse(listItemRow)).toEqual(listItemRow);
    // status/tags 可缺省（普通文档无 frontmatter status）
    const minimal: LibraryListItem = {
      id: 'PMO-7:CONTEXT.md', title: 'CONTEXT.md', kind: 'context', legacy: false,
      projectId: 'PMO-7', pmoNumber: 'PMO-7', path: 'CONTEXT.md', updatedAt: 't',
    };
    expect(libraryListItemSchema.parse(minimal)).toEqual(minimal);
    expect(() => libraryListItemSchema.parse({ ...listItemRow, id: undefined })).toThrow();
    expect(() => libraryListItemSchema.parse({ ...listItemRow, kind: undefined })).toThrow();
    expect(() => libraryListItemSchema.parse({ ...listItemRow, legacy: undefined })).toThrow();
    expect(() => libraryListItemSchema.parse({ ...listItemRow, updatedAt: undefined })).toThrow();
  });

  it('parity：LibraryDocDetail = ListItem + content；legacy 三段可空', () => {
    expect(libraryDocDetailSchema.parse(docDetailRow)).toEqual(docDetailRow);
    const legacy: LibraryDocDetail = {
      id: 'PMO-7:legacy-sdd/old', title: 'old', kind: 'legacy', legacy: true,
      projectId: 'PMO-7', pmoNumber: 'PMO-7', path: 'legacy-sdd/old', updatedAt: 't',
      content: 'req body', requirement: 'req body', design: null, task: null,
    };
    expect(libraryDocDetailSchema.parse(legacy)).toEqual(legacy);
    expect(() => libraryDocDetailSchema.parse({ ...docDetailRow, content: undefined })).toThrow();
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
