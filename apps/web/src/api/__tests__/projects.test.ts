// projectsApi — #266（决策 #258）：工程发现候选 + 归属候选排除清单管理，端点契约测试
import { describe, it, expect, vi } from 'vitest';

const { mockGet, mockPut } = vi.hoisted(() => ({ mockGet: vi.fn(), mockPut: vi.fn() }));
vi.mock('../index', () => ({ api: { get: mockGet, put: mockPut } }));

import { projectsApi } from '../projects';

describe('projectsApi（工程候选管理）', () => {
  it('discover → GET /projects/discover（候选工程列表）', () => {
    projectsApi.discover();
    expect(mockGet).toHaveBeenCalledWith('/projects/discover');
  });

  it('getExclude → GET /projects/exclude（读取排除清单）', () => {
    projectsApi.getExclude();
    expect(mockGet).toHaveBeenCalledWith('/projects/exclude');
  });

  it('saveExclude → PUT /projects/exclude（全量保存排除清单）', () => {
    const exclude = ['/root/projects/studio-prod'];
    projectsApi.saveExclude(exclude);
    expect(mockPut).toHaveBeenCalledWith('/projects/exclude', { exclude });
  });
});
