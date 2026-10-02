// libraryApi — 阅览室只读层：端点契约测试（P3-a 自 api/index.ts 拆出后的归位文件）
import { describe, it, expect, vi } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../client', () => ({ api: { get: mockGet } }));

import { libraryApi } from '../library';

describe('libraryApi（阅览室）', () => {
  it('list → GET /library（search/project 过滤可选）', () => {
    libraryApi.list();
    expect(mockGet).toHaveBeenCalledWith('/library', { params: undefined });

    libraryApi.list({ search: 'adr', project: 'studio' });
    expect(mockGet).toHaveBeenCalledWith('/library', { params: { search: 'adr', project: 'studio' } });
  });

  it('getDoc → GET /library/:id（id 做 encodeURIComponent）', () => {
    libraryApi.getDoc('proj/.studio/specs/a b.md');
    expect(mockGet).toHaveBeenCalledWith(`/library/${encodeURIComponent('proj/.studio/specs/a b.md')}`);
  });
});
