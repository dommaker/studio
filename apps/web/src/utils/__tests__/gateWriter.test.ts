// #545：gateWriter 模块级契约——「闸门转移 = 一次 API 调用 + 响应体快照双写落点」写路径只测这一份
// （ADR 2026-09-15-web-gate-write-module 决策 2 冻结契约）；五处宿主只留渲染级断言。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockReviewPassed, mockReviewRejected, mockTransitionStatus,
  mockApplyWorkunitSnapshot, mockMarkSuggestionsDirty, mockApplyWorkunitEvent,
} = vi.hoisted(() => ({
  mockReviewPassed: vi.fn(),
  mockReviewRejected: vi.fn(),
  mockTransitionStatus: vi.fn(),
  mockApplyWorkunitSnapshot: vi.fn(),
  mockMarkSuggestionsDirty: vi.fn(),
  mockApplyWorkunitEvent: vi.fn(),
}));

vi.mock('../../api/workunit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/workunit')>();
  return {
    ...actual,
    workunitApi: {
      ...actual.workunitApi,
      reviewPassed: mockReviewPassed,
      reviewRejected: mockReviewRejected,
      transitionStatus: mockTransitionStatus,
    },
  };
});

vi.mock('../../stores/channelWorkStore', () => ({
  useChannelWorkStore: {
    getState: () => ({
      applyWorkunitSnapshot: mockApplyWorkunitSnapshot,
      markSuggestionsDirty: mockMarkSuggestionsDirty,
    }),
  },
}));

vi.mock('../../stores/workunitStore', () => ({
  useWorkUnitStore: {
    getState: () => ({ applyWorkunitEvent: mockApplyWorkunitEvent }),
  },
}));

import { createGateWriter } from '../gateWriter';
import type { WorkUnit } from '../../api/workunit';

const updatedWu = { id: 'wu-1', status: 'done', channelId: 'ch-1' } as unknown as WorkUnit;

beforeEach(() => {
  vi.clearAllMocks();
  mockReviewPassed.mockResolvedValue({ data: updatedWu });
  mockReviewRejected.mockResolvedValue({ data: updatedWu });
  mockTransitionStatus.mockResolvedValue({ data: updatedWu });
});

describe('createGateWriter — 一次 API 调用 + 快照双写落点（ADR 决策 2 冻结契约）', () => {
  it('reviewPassed：参数（含 confirm 载荷）原样透传，响应体 WU 双写落点并返回', async () => {
    const onUpdated = vi.fn();
    const writer = createGateWriter(onUpdated);
    const confirm = { kind: 'analysis', destination: '目标', fog: ['问题1'], tasks: [] } as const;
    const result = await writer.reviewPassed('wu-1', '摘要', 'role-1', confirm);
    expect(mockReviewPassed).toHaveBeenCalledWith('wu-1', '摘要', 'role-1', confirm);
    // 双写：channelWorkStore 快照 + 建议标脏（镜像 status_changed 路由）+ workunitStore 存量行 upsert
    expect(mockApplyWorkunitSnapshot).toHaveBeenCalledWith('ch-1', updatedWu);
    expect(mockMarkSuggestionsDirty).toHaveBeenCalledWith('ch-1');
    expect(mockApplyWorkunitEvent).toHaveBeenCalledWith(updatedWu, { insertIfMissing: false });
    expect(onUpdated).toHaveBeenCalledWith(updatedWu);
    expect(result).toBe(updatedWu);
  });

  it('reviewRejected / confirmPending：同一双写契约（confirmPending 固定 transitionStatus(id, unassigned)）', async () => {
    const writer = createGateWriter();
    await writer.reviewRejected('wu-1', '质量不达标');
    expect(mockReviewRejected).toHaveBeenCalledWith('wu-1', '质量不达标');
    await writer.confirmPending('wu-1');
    expect(mockTransitionStatus).toHaveBeenCalledWith('wu-1', 'unassigned');
    expect(mockApplyWorkunitSnapshot).toHaveBeenCalledTimes(2);
    expect(mockApplyWorkunitEvent).toHaveBeenCalledTimes(2);
  });

  it('store 双写先于宿主 onUpdated（宿主见到的快照已落 store）', async () => {
    const order: string[] = [];
    mockApplyWorkunitEvent.mockImplementation(() => order.push('store'));
    const writer = createGateWriter(() => { order.push('host'); });
    await writer.reviewPassed('wu-1');
    expect(order).toEqual(['store', 'host']);
  });

  it('channelId 缺省（未归属 WU）：跳过频道侧落点，workunitStore upsert 仍执行', async () => {
    const noChannelWu = { id: 'wu-2', status: 'done', channelId: null } as unknown as WorkUnit;
    mockReviewPassed.mockResolvedValue({ data: noChannelWu });
    const writer = createGateWriter();
    await writer.reviewPassed('wu-2');
    expect(mockApplyWorkunitSnapshot).not.toHaveBeenCalled();
    expect(mockMarkSuggestionsDirty).not.toHaveBeenCalled();
    expect(mockApplyWorkunitEvent).toHaveBeenCalledWith(noChannelWu, { insertIfMissing: false });
  });

  it('无 onUpdated（列表行/工作条宿主）：store 双写后正常返回响应体', async () => {
    const writer = createGateWriter();
    const result = await writer.reviewPassed('wu-1');
    expect(result).toBe(updatedWu);
  });

  it('API 失败：错误向上传播，任何落点都不被调用（失败不得污染快照）', async () => {
    const onUpdated = vi.fn();
    const writer = createGateWriter(onUpdated);
    mockReviewPassed.mockRejectedValue(new Error('状态机不允许该迁移'));
    await expect(writer.reviewPassed('wu-1')).rejects.toThrow('状态机不允许该迁移');
    expect(mockApplyWorkunitSnapshot).not.toHaveBeenCalled();
    expect(mockMarkSuggestionsDirty).not.toHaveBeenCalled();
    expect(mockApplyWorkunitEvent).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});
