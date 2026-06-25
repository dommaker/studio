// Contract test: workunitStore — MVP-3 Review UI
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API module before importing store
vi.mock('../../api/workunit', () => ({
  workunitApi: {
    list: vi.fn().mockResolvedValue({ data: { data: [], total: 0, page: 1 } }),
    create: vi.fn().mockResolvedValue({ data: {} }),
    reviewPassed: vi.fn().mockResolvedValue({ data: {} }),
    reviewRejected: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { useWorkUnitStore } from '../workunitStore';
import { workunitApi } from '../../api/workunit';

describe('workunitStore reviewRejected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkUnitStore.setState({
      workunits: [],
      total: 0,
      page: 1,
      limit: 20,
      statusFilter: null,
      typeFilter: null,
      loading: false,
      error: null,
    });
  });

  it('should pass reason to API when rejecting', async () => {
    const store = useWorkUnitStore.getState();
    await store.reviewRejected('wu-1', '质量不达标');
    expect(workunitApi.reviewRejected).toHaveBeenCalledWith('wu-1', '质量不达标');
  });

  it('should work without reason', async () => {
    const store = useWorkUnitStore.getState();
    await store.reviewRejected('wu-1');
    expect(workunitApi.reviewRejected).toHaveBeenCalledWith('wu-1', undefined);
  });

  it('should reload workunits after rejection', async () => {
    const store = useWorkUnitStore.getState();
    await store.reviewRejected('wu-1', '原因');
    expect(workunitApi.list).toHaveBeenCalled();
  });
});
