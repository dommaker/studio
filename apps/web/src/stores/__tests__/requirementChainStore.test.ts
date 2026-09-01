// requirementChainStore 单测 — #412 REQ chain 数据面 store（ADR 2026-08-31-channel-data-plane-store 第三个使用者）
// per-reqId 粒度：TTL / single-flight / seq 守卫走 fetchDiscipline；失败落 errors 不落 TTL 锚点。
// workunit.status_changed 本地推导：已知 WU 就地 patch 零请求；未知 WU 但 reqId 命中缓存 → 失效强刷一次。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetChain } = vi.hoisted(() => ({
  mockGetChain: vi.fn(),
}));

vi.mock('../../api/requirements', () => ({
  requirementApi: { getChain: mockGetChain },
}));

import { useRequirementChainStore, REQUIREMENT_CHAIN_TTL_MS } from '../requirementChainStore';
import type { RequirementChain } from '../../api/requirements';

function chainFixture(reqId: string, workunits: Array<{ id: string; status: string; assigneeId?: string | null; title?: string; metadata?: string | null }>): RequirementChain {
  return {
    requirement: {
      id: reqId, seq: 1, title: `需求${reqId}`, status: 'in-progress',
      createdAt: '2026-08-01T00:00:00Z', createdBy: 'human',
    },
    workunits: workunits.map(w => ({
      id: w.id, title: w.title ?? `任务${w.id}`, status: w.status,
      assigneeId: w.assigneeId ?? null, metadata: w.metadata ?? null,
    })),
  };
}

function resetStore() {
  useRequirementChainStore.getState().__resetForTests();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

describe('requirementChainStore 拉取去重', () => {
  it('同 reqId 并发调用共享单飞：只发一次请求', async () => {
    let resolveChain!: (v: unknown) => void;
    mockGetChain.mockReturnValue(new Promise((r) => { resolveChain = r; }));
    const p1 = useRequirementChainStore.getState().ensureChain('REQ-1');
    const p2 = useRequirementChainStore.getState().ensureChain('REQ-1');
    resolveChain({ data: { success: true, data: chainFixture('REQ-1', [{ id: 'wu-1', status: 'active' }]) } });
    await Promise.all([p1, p2]);
    expect(mockGetChain).toHaveBeenCalledTimes(1);
    expect(mockGetChain).toHaveBeenCalledWith('REQ-1');
    expect(useRequirementChainStore.getState().chains['REQ-1']?.workunits).toHaveLength(1);
  });

  it('不同 reqId 各自拉取；TTL 内重复调用零重拉，过期后重拉', async () => {
    mockGetChain.mockImplementation((id: string) =>
      Promise.resolve({ data: { success: true, data: chainFixture(id, []) } }));
    vi.useFakeTimers();
    try {
      await useRequirementChainStore.getState().ensureChain('REQ-1');
      await useRequirementChainStore.getState().ensureChain('REQ-2');
      expect(mockGetChain).toHaveBeenCalledTimes(2);
      await useRequirementChainStore.getState().ensureChain('REQ-1');
      expect(mockGetChain).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(REQUIREMENT_CHAIN_TTL_MS + 1);
      await useRequirementChainStore.getState().ensureChain('REQ-1');
      expect(mockGetChain).toHaveBeenCalledTimes(3);
      expect(mockGetChain).toHaveBeenLastCalledWith('REQ-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ensureFresh 刷新全部已缓存 key（TTL 过期的）；未缓存的 reqId 不发起', async () => {
    mockGetChain.mockImplementation((id: string) =>
      Promise.resolve({ data: { success: true, data: chainFixture(id, []) } }));
    vi.useFakeTimers();
    try {
      await useRequirementChainStore.getState().ensureChain('REQ-1');
      await useRequirementChainStore.getState().ensureChain('REQ-2');
      vi.advanceTimersByTime(REQUIREMENT_CHAIN_TTL_MS + 1);
      await useRequirementChainStore.getState().ensureFresh();
      expect(mockGetChain).toHaveBeenCalledTimes(4);
      expect(mockGetChain).toHaveBeenCalledWith('REQ-1');
      expect(mockGetChain).toHaveBeenCalledWith('REQ-2');
      expect(mockGetChain).not.toHaveBeenCalledWith('REQ-3');
    } finally {
      vi.useRealTimers();
    }
  });

  it('拉取失败：error 落消息、chains 缺键、不落 TTL 锚点（下次重试），ensure 永不 reject', async () => {
    mockGetChain.mockRejectedValue(new Error('boom'));
    await expect(useRequirementChainStore.getState().ensureChain('REQ-1')).resolves.toBeUndefined();
    const s = useRequirementChainStore.getState();
    expect(s.chains['REQ-1']).toBeUndefined();
    expect(s.errors['REQ-1']).toBe('boom');
    mockGetChain.mockResolvedValue({ data: { success: true, data: chainFixture('REQ-1', []) } });
    await useRequirementChainStore.getState().ensureChain('REQ-1');
    expect(useRequirementChainStore.getState().errors['REQ-1']).toBeUndefined();
    expect(useRequirementChainStore.getState().chains['REQ-1']).toBeTruthy();
  });
});

describe('requirementChainStore — status_changed 本地推导（#412 验收：右栏新鲜度）', () => {
  beforeEach(() => {
    mockGetChain.mockImplementation((id: string) =>
      Promise.resolve({ data: { success: true, data: chainFixture(id, [
        { id: 'wu-1', status: 'active', assigneeId: 'a-1', title: '旧标题' },
        { id: 'wu-2', status: 'done' },
      ]) } }));
  });

  it('已知 WU 状态变化：就地 patch（status/assignee/时间戳/标题），零请求，数组顺序不变', async () => {
    await useRequirementChainStore.getState().ensureChain('REQ-1');
    expect(mockGetChain).toHaveBeenCalledTimes(1);

    useRequirementChainStore.getState().applyWorkunitStatusChanged({
      id: 'wu-1', reqId: 'REQ-1', status: 'done', scope: '新的范围文本', assigneeId: null,
      metadata: JSON.stringify({ title: '新标题' }),
      claimedAt: '2026-08-01T01:00:00Z', completedAt: '2026-08-01T02:00:00Z',
    });

    const s = useRequirementChainStore.getState();
    const wus = s.chains['REQ-1']!.workunits;
    expect(mockGetChain).toHaveBeenCalledTimes(1); // 未重拉
    expect(wus.map(w => w.id)).toEqual(['wu-1', 'wu-2']); // 顺序不变
    expect(wus[0]).toMatchObject({ id: 'wu-1', status: 'done', assigneeId: null, completedAt: '2026-08-01T02:00:00Z' });
    expect(wus[0].title).toBe('新标题'); // metadata.title 优先（对齐服务端 extractWorkUnitTitle）
    expect(wus[1].status).toBe('done'); // 其他 WU 不动
  });

  it('未知 WU 但 reqId 命中缓存 chain：失效并强刷该 chain 一次', async () => {
    await useRequirementChainStore.getState().ensureChain('REQ-1');
    expect(mockGetChain).toHaveBeenCalledTimes(1);
    mockGetChain.mockImplementation((id: string) =>
      Promise.resolve({ data: { success: true, data: chainFixture(id, [
        { id: 'wu-1', status: 'active' }, { id: 'wu-2', status: 'done' }, { id: 'wu-3', status: 'unassigned' },
      ]) } }));

    useRequirementChainStore.getState().applyWorkunitStatusChanged({ id: 'wu-3', reqId: 'REQ-1', status: 'active' });

    // refetch 异步在途，等它落地（强刷恰好一次）
    await vi.waitFor(() => expect(mockGetChain).toHaveBeenCalledTimes(2));
    expect(useRequirementChainStore.getState().chains['REQ-1']!.workunits).toHaveLength(3);
  });

  it('未知 WU 且 reqId 无缓存 chain：no-op 零请求', async () => {
    await useRequirementChainStore.getState().ensureChain('REQ-1');
    expect(mockGetChain).toHaveBeenCalledTimes(1);
    useRequirementChainStore.getState().applyWorkunitStatusChanged({ id: 'wu-9', reqId: 'REQ-9', status: 'active' });
    expect(mockGetChain).toHaveBeenCalledTimes(1);
    expect(useRequirementChainStore.getState().chains['REQ-9']).toBeUndefined();
  });

  it('坏事件防护：缺 id / null / 空对象不炸不改状态', async () => {
    await useRequirementChainStore.getState().ensureChain('REQ-1');
    const before = useRequirementChainStore.getState().chains['REQ-1'];
    const store = useRequirementChainStore.getState();
    expect(() => store.applyWorkunitStatusChanged(null)).not.toThrow();
    expect(() => store.applyWorkunitStatusChanged({} as never)).not.toThrow();
    expect(() => store.applyWorkunitStatusChanged({ id: 'wu-1' } as never)).not.toThrow(); // 缺 status 视为坏负载
    expect(useRequirementChainStore.getState().chains['REQ-1']).toBe(before);
    expect(mockGetChain).toHaveBeenCalledTimes(1);
  });
});
