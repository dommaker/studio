// Contract test: Audit Logs API client — AR-012（收编自 AuditLogsPage 裸 fetch）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
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
});
