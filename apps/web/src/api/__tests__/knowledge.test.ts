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
});

describe('knowledgeApi（知识库浏览/搜索）', () => {
  it('listResolutions → GET /knowledge/resolutions（解法库 tab）', () => {
    knowledgeApi.listResolutions();
    expect(mockGet).toHaveBeenCalledWith('/knowledge/resolutions');
  });

  it('listGaps → GET /knowledge/gaps/:type（五类缺口 tab）', () => {
    knowledgeApi.listGaps('business_rule');
    expect(mockGet).toHaveBeenCalledWith('/knowledge/gaps/business_rule');
  });

  it('listUnified → GET /knowledge/unified（统一视图，分页 + consumptionMode 过滤）', () => {
    knowledgeApi.listUnified({ limit: 50, offset: 50, consumptionMode: 'rule' });
    expect(mockGet).toHaveBeenCalledWith('/knowledge/unified', {
      params: { limit: 50, offset: 50, consumptionMode: 'rule' },
    });
  });

  it('createUnifiedEntry → POST /knowledge/unified（手动条目）', () => {
    const payload = { type: 'guideline', title: 'T', content: 'C', consumptionMode: 'reference', tags: ['a'] };
    knowledgeApi.createUnifiedEntry(payload);
    expect(mockPost).toHaveBeenCalledWith('/knowledge/unified', payload);
  });

  it('search → GET /knowledge/search?q=（S11 全局搜索）', () => {
    knowledgeApi.search('超时 重试');
    expect(mockGet).toHaveBeenCalledWith('/knowledge/search', { params: { q: '超时 重试' } });
  });
});
