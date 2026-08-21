// Contract test: workunitStore — MVP-3 Review UI
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the API module before importing store
vi.mock('../../api/workunit', () => ({
  workunitApi: {
    list: vi.fn().mockResolvedValue({ data: { data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } } }),
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

// #280：store 从 pagination.total 解析总数（旧版类型把 total 扁平化导致恒 0）
describe('workunitStore loadWorkUnits - pagination.total 解析（#280）', () => {
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

  it('从 pagination.total 读取总数（而非顶层 total）', async () => {
    const sample = [
      { id: 'wu-1', scope: 'demo', status: 'pending', metadata: null },
      { id: 'wu-2', scope: 'demo2', status: 'in_review', metadata: null },
      { id: 'wu-3', scope: 'demo3', status: 'active', metadata: null },
    ];
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        data: sample,
        pagination: { total: 3, page: 1, limit: 20, totalPages: 1 },
      },
    });

    const store = useWorkUnitStore.getState();
    await store.loadWorkUnits();

    const state = useWorkUnitStore.getState();
    expect(state.total).toBe(3);
    expect(state.workunits).toHaveLength(3);
    expect(state.page).toBe(1);
  });

  it('缺 pagination 字段时降级为 0（不崩）', async () => {
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [] },
    });
    const store = useWorkUnitStore.getState();
    await store.loadWorkUnits();
    expect(useWorkUnitStore.getState().total).toBe(0);
  });
});
