// Contract test: Maintenance API client - 手动任务按钮（B7 token-burn issue）
// 模式同 monitoring.test.ts：mock ../index 的 api，验证 URL/参数
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { maintenanceApi } from '../maintenance';
import { api } from '../index';

describe('maintenanceApi', () => {
  it('fireTrigger calls POST /triggers/:id/fire', async () => {
    await maintenanceApi.fireTrigger('doc-semantic-review');
    expect(api.post).toHaveBeenCalledWith('/triggers/doc-semantic-review/fire');
  });

  it('getCosts calls GET /triggers/costs with days param (default 30)', async () => {
    await maintenanceApi.getCosts();
    expect(api.get).toHaveBeenCalledWith('/triggers/costs', { params: { days: 30 } });
  });

  it('getCosts forwards custom days window', async () => {
    await maintenanceApi.getCosts(7);
    expect(api.get).toHaveBeenCalledWith('/triggers/costs', { params: { days: 7 } });
  });

  it('runKnowledgeMaintenance posts with 10min timeout', async () => {
    await maintenanceApi.runKnowledgeMaintenance();
    expect(api.post).toHaveBeenCalledWith('/knowledge/maintenance/run', undefined, { timeout: 600_000 });
  });

  it('runMesoEvolution posts projectId in body', async () => {
    await maintenanceApi.runMesoEvolution('proj-1');
    expect(api.post).toHaveBeenCalledWith('/knowledge/evolution/meso', { projectId: 'proj-1' });
  });
});
