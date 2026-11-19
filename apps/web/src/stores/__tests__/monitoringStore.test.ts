import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetOverview } = vi.hoisted(() => ({ mockGetOverview: vi.fn() }));
vi.mock('../../api/monitoring', () => ({ monitoringApi: { getOverview: mockGetOverview } }));

import { useMonitoringStore } from '../monitoringStore';

const response = { data: { data: { windowDays: 7 } } };

beforeEach(() => {
  useMonitoringStore.getState().__resetForTests();
  mockGetOverview.mockReset();
  mockGetOverview.mockResolvedValue(response);
});

describe('monitoringStore overview', () => {
  it('并发与 TTL 内加载共享一次请求，强拉绕过 TTL', async () => {
    await Promise.all([
      useMonitoringStore.getState().loadOverview(),
      useMonitoringStore.getState().loadOverview(),
    ]);
    await useMonitoringStore.getState().loadOverview();
    expect(mockGetOverview).toHaveBeenCalledTimes(1);
    expect(useMonitoringStore.getState().overview).toEqual(response.data.data);

    await useMonitoringStore.getState().loadOverview({ maxAgeMs: 0 });
    expect(mockGetOverview).toHaveBeenCalledTimes(2);
  });

  it('失败保留旧数据并暴露 error，成功重试后清除', async () => {
    await useMonitoringStore.getState().loadOverview();
    mockGetOverview.mockRejectedValueOnce(new Error('network'));
    await useMonitoringStore.getState().loadOverview({ maxAgeMs: 0 });
    expect(useMonitoringStore.getState().overview).toEqual(response.data.data);
    expect(useMonitoringStore.getState().overviewError?.message).toBe('network');

    await useMonitoringStore.getState().loadOverview({ maxAgeMs: 0 });
    expect(useMonitoringStore.getState().overviewError).toBeNull();
  });
});
