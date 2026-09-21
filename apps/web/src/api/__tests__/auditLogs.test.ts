// Contract test: Audit Logs API client — AR-012（收编自 AuditLogsPage 裸 fetch）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } } }),
    defaults: { baseURL: '/api/v1' },
  },
}));

import { auditLogApi } from '../auditLogs';
import { api } from '../index';

describe('auditLogApi', () => {
  it('list calls GET /audit-logs with query params', async () => {
    const params = { action: 'create', page: 2, limit: 50 };
    await auditLogApi.list(params);
    expect(api.get).toHaveBeenCalledWith('/audit-logs', { params });
  });

  it('getStats calls GET /audit-logs/stats', async () => {
    await auditLogApi.getStats();
    expect(api.get).toHaveBeenCalledWith('/audit-logs/stats');
  });

  it('listActions calls GET /audit-logs/actions', async () => {
    await auditLogApi.listActions();
    expect(api.get).toHaveBeenCalledWith('/audit-logs/actions');
  });

  it('listResources calls GET /audit-logs/resources', async () => {
    await auditLogApi.listResources();
    expect(api.get).toHaveBeenCalledWith('/audit-logs/resources');
  });

  it('getExportUrl builds download URL with non-empty filters only', () => {
    expect(auditLogApi.getExportUrl({ action: 'login', resource: '', userId: 'u1' }))
      .toBe('/api/v1/audit-logs/export?action=login&userId=u1');
    expect(auditLogApi.getExportUrl()).toBe('/api/v1/audit-logs/export');
  });

  // #591：来源/主体两个过滤维度
  it('list 透传 actorType/source 参数', async () => {
    const params = { actorType: 'agent' as const, source: 'proposal' as const, page: 1 };
    await auditLogApi.list(params);
    expect(api.get).toHaveBeenCalledWith('/audit-logs', { params });
  });

  it('getExportUrl 带 actorType/source 参数', () => {
    expect(auditLogApi.getExportUrl({ actorType: 'agent', source: 'proposal' }))
      .toBe('/api/v1/audit-logs/export?actorType=agent&source=proposal');
    expect(auditLogApi.getExportUrl({ source: 'all' }))
      .toBe('/api/v1/audit-logs/export?source=all');
  });

  // #591 review 修复：后端行 details/changes 是 JSON 字符串，list 归一为对象（坏串容错落 undefined）
  it('list 归一 details/changes 字符串 → 对象', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      data: {
        data: [
          { id: 'a1', action: 'create', resource: 'task', status: 'success', createdAt: '2026-09-20T00:00:00.000Z',
            details: '{"via":"mention"}', changes: '{"after":{"x":1}}' },
          { id: 'a2', action: 'propose', resource: 'distill', status: 'executed', createdAt: '2026-09-20T01:00:00.000Z',
            details: '{bad json', changes: null },
        ],
        pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
      },
    } as never);

    const res = await auditLogApi.list();

    expect(res.data.data[0].details).toEqual({ via: 'mention' });
    expect(res.data.data[0].changes).toEqual({ after: { x: 1 } });
    expect(res.data.data[1].details).toBeUndefined();
    expect(res.data.data[1].changes).toBeUndefined();
  });
});
