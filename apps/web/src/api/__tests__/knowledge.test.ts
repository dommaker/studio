// knowledgeApi — 2026-07 知识审核闭环：端点契约测试
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('../index', () => ({ api: { get: mockGet, post: mockPost } }));

import { knowledgeApi } from '../knowledge';

describe('knowledgeApi（知识审核闭环）', () => {
  it('listPendingReview → GET /knowledge-service/entries?maturity=draft（待审列表数据源）', () => {
    knowledgeApi.listPendingReview();
    expect(mockGet).toHaveBeenCalledWith('/knowledge-service/entries', {
      params: { maturity: 'draft', limit: 50 },
    });
  });

  it('promote → POST /knowledge-service/promote（draft→verified）', () => {
    knowledgeApi.promote('k-1');
    expect(mockPost).toHaveBeenCalledWith('/knowledge-service/promote', { entryId: 'k-1' });
  });

  it('demote → POST /knowledge-service/demote（draft→archived）', () => {
    knowledgeApi.demote('k-2');
    expect(mockPost).toHaveBeenCalledWith('/knowledge-service/demote', { entryId: 'k-2' });
  });

  it('archive → POST /knowledge/:id/archive（PMO 详情页归档知识库）', () => {
    knowledgeApi.archive('doc-1');
    expect(mockPost).toHaveBeenCalledWith('/knowledge/doc-1/archive');
  });
});
