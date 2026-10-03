// workspaceApi — Workspace 只读：端点契约测试（P3-a 自 api/index.ts 拆出后的归位文件）
import { describe, it, expect, vi } from 'vitest';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));
vi.mock('../client', () => ({ api: { get: mockGet } }));

import { workspaceApi } from '../workspaces';

describe('workspaceApi', () => {
  it('list → GET /workspaces', () => {
    workspaceApi.list();
    expect(mockGet).toHaveBeenCalledWith('/workspaces');
  });

  it('get → GET /workspaces/:id', () => {
    workspaceApi.get('ws-1');
    expect(mockGet).toHaveBeenCalledWith('/workspaces/ws-1');
  });
});
