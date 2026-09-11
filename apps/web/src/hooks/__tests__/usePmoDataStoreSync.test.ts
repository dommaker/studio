// usePmoDataStoreSync 单测 — #456 PMO 数据面接线的契约钉子：
// 重连 → ensureFresh({maxAgeMs:0})（companies + 已驻留 projects 键强刷）；
// 任何 SSE 事件 → no-op（本域无失效事件可接，ADR 决策 3）。
// 引用计数单例 / 门禁轮询契约由 useDataPlaneSync 套件锁定，此处不重复。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockOnEvent, mockOnReconnect, mockCompanyList, mockProjectList } = vi.hoisted(() => ({
  mockOnEvent: vi.fn(),
  mockOnReconnect: vi.fn(),
  mockCompanyList: vi.fn(),
  mockProjectList: vi.fn(),
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent, onReconnect: mockOnReconnect, status: 'disconnected' }),
}));
vi.mock('../useGatedPoll', () => ({ useGatedPoll: () => {} }));
vi.mock('../../api/company', () => ({
  companyApi: { list: mockCompanyList },
}));
vi.mock('../../api', () => ({
  projectApi: { list: mockProjectList },
}));

import { usePmoDataStoreSync } from '../usePmoDataStoreSync';
import { usePmoDataStore } from '../../stores/pmoDataStore';

let handler: ((msg: { event_type: string; data?: unknown }) => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  handler = null;
  usePmoDataStore.getState().__resetForTests();
  mockOnEvent.mockImplementation((h: typeof handler) => { handler = h; return () => {}; });
  mockOnReconnect.mockReturnValue(() => {});
  mockCompanyList.mockResolvedValue({ data: { data: [{ id: 'co-1' }] } });
  mockProjectList.mockResolvedValue({ data: { data: [] } });
});

describe('usePmoDataStoreSync', () => {
  it('onReconnect → ensureFresh({maxAgeMs:0})：companies + 已驻留 projects 键强刷一次', async () => {
    let reconnect: (() => void) | null = null;
    mockOnReconnect.mockImplementation((h: () => void) => { reconnect = h; return () => {}; });
    await usePmoDataStore.getState().ensureProjects('co-1');
    renderHook(() => usePmoDataStoreSync());
    vi.clearAllMocks();

    act(() => reconnect!());
    await vi.waitFor(() => {
      expect(mockCompanyList).toHaveBeenCalledTimes(1);
      expect(mockProjectList).toHaveBeenCalledTimes(1);
    });
    expect(mockProjectList).toHaveBeenLastCalledWith(expect.objectContaining({ companyId: 'co-1' }));
  });

  it('任何 SSE 事件 → no-op（不重拉不炸）', async () => {
    renderHook(() => usePmoDataStoreSync());
    act(() => handler!({ event_type: 'workunit.status_changed', data: { workunit: { id: 'wu-1' } } }));
    act(() => handler!({ event_type: 'requirement.created', data: { id: 'REQ-1' } }));
    expect(mockCompanyList).not.toHaveBeenCalled();
    expect(mockProjectList).not.toHaveBeenCalled();
  });
});
