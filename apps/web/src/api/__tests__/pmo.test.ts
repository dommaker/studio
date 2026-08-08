// okrApi — PMO OKR：端点契约测试
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPost: vi.fn() }));
vi.mock('../index', () => ({ api: { get: mockGet, post: mockPost } }));

import { okrApi } from '../pmo';

describe('okrApi（PMO OKR）', () => {
  it('list → GET /pmo/okr?companyId=（companyId 必填）', () => {
    okrApi.list('co-1');
    expect(mockGet).toHaveBeenCalledWith('/pmo/okr', { params: { companyId: 'co-1' } });
  });

  it('list 带 status 过滤', () => {
    okrApi.list('co-1', 'active');
    expect(mockGet).toHaveBeenCalledWith('/pmo/okr', { params: { companyId: 'co-1', status: 'active' } });
  });

  it('create → POST /pmo/okr（PMOPage 新建 OKR）', () => {
    const payload = {
      companyId: 'co-1',
      title: 'Q3 增长',
      quarter: '2026-Q3',
      objectives: [{ id: 'o1', title: 'Q3 增长' }],
      keyResults: [{ id: 'kr1', objectiveId: 'o1', title: 'KR1', target: 100, current: 0, unit: '%' }],
    };
    okrApi.create(payload);
    expect(mockPost).toHaveBeenCalledWith('/pmo/okr', payload);
  });
});
