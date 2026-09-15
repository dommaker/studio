// channelWorkStore 单测 — #528 频道工作面数据面 store（ADR 2026-08-31-channel-data-plane-store）
// per-channelId 三 slice（wus / reqs / suggestions+currentWuId 同响应同 slice）+ per-wuId wuChangedFiles；
// wus/reqs 30s TTL + single-flight + seq 守卫走 fetchDiscipline；suggestions 无 TTL 纯事件驱动（500ms 防抖内化）。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWuList, mockReqList, mockGetSuggestions, mockGetChangedFiles } = vi.hoisted(() => ({
  mockWuList: vi.fn(),
  mockReqList: vi.fn(),
  mockGetSuggestions: vi.fn(),
  mockGetChangedFiles: vi.fn(),
}));

vi.mock('../../api/workunit', () => ({
  workunitApi: { list: mockWuList, getChangedFiles: mockGetChangedFiles },
}));
vi.mock('../../api/requirements', () => ({
  requirementApi: { list: mockReqList },
}));
vi.mock('../../api/channel', () => ({
  channelApi: { getSuggestions: mockGetSuggestions },
}));

import { useChannelWorkStore, CHANNEL_WORK_TTL_MS, wuIdleOf } from '../channelWorkStore';
import type { WorkUnit } from '../../api/workunit';
import type { Requirement } from '../../api/requirements';

function wuFixture(id: string, over: Partial<WorkUnit> = {}): WorkUnit {
  return {
    id, parentId: null, dependsOn: '', type: 'task', scope: `任务${id}`,
    assigneeId: null, status: 'active', failureType: null, retryCount: 0,
    timeoutAt: null, channelId: 'ch-1', metadata: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    claimedAt: null, completedAt: null,
    ...over,
  };
}

function reqFixture(id: string, over: Partial<Requirement> = {}): Requirement {
  return {
    id, seq: 1, title: `需求${id}`, status: 'open',
    createdAt: '2026-09-01T00:00:00Z', createdBy: 'human',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useChannelWorkStore.getState().__resetForTests();
});

describe('channelWorkStore — wus slice', () => {
  it('同频道并发 ensure 共享单飞只发一次请求；TTL 内零重拉，过期重拉', async () => {
    mockWuList.mockImplementation(({ channelId }: { channelId: string }) =>
      Promise.resolve({ data: { success: true, data: [wuFixture('wu-1', { channelId })] } }));
    vi.useFakeTimers();
    try {
      await Promise.all([
        useChannelWorkStore.getState().ensureWus('ch-1'),
        useChannelWorkStore.getState().ensureWus('ch-1'),
      ]);
      expect(mockWuList).toHaveBeenCalledTimes(1);
      expect(mockWuList).toHaveBeenCalledWith({ channelId: 'ch-1', limit: 100 });
      expect(useChannelWorkStore.getState().wus['ch-1']).toHaveLength(1);
      await useChannelWorkStore.getState().ensureWus('ch-1');
      expect(mockWuList).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(CHANNEL_WORK_TTL_MS + 1);
      await useChannelWorkStore.getState().ensureWus('ch-1');
      expect(mockWuList).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('拉取失败静默：缺键不落锚点（下次重试），ensure 永不 reject', async () => {
    mockWuList.mockRejectedValueOnce(new Error('boom'));
    await expect(useChannelWorkStore.getState().ensureWus('ch-1')).resolves.toBeUndefined();
    expect(useChannelWorkStore.getState().wus['ch-1']).toBeUndefined();
    mockWuList.mockResolvedValue({ data: { success: true, data: [wuFixture('wu-1')] } });
    await useChannelWorkStore.getState().ensureWus('ch-1');
    expect(mockWuList).toHaveBeenCalledTimes(2);
    expect(useChannelWorkStore.getState().wus['ch-1']).toHaveLength(1);
  });
});
describe('channelWorkStore — reqs slice', () => {
  it('按频道各自拉取；TTL 内零重拉，maxAgeMs:0 强拉（重连语义）', async () => {
    mockReqList.mockImplementation(({ channelId }: { channelId: string }) =>
      Promise.resolve({ data: { success: true, data: [reqFixture('REQ-1', { channelId })] } }));
    await useChannelWorkStore.getState().ensureReqs('ch-1');
    await useChannelWorkStore.getState().ensureReqs('ch-2');
    expect(mockReqList).toHaveBeenCalledTimes(2);
    await useChannelWorkStore.getState().ensureReqs('ch-1');
    expect(mockReqList).toHaveBeenCalledTimes(2);
    await useChannelWorkStore.getState().ensureReqs('ch-1', { maxAgeMs: 0 });
    expect(mockReqList).toHaveBeenCalledTimes(3);
    expect(mockReqList).toHaveBeenLastCalledWith({ channelId: 'ch-1' });
  });

  it('拉取失败静默：缺键不落锚点（下次重试）', async () => {
    mockReqList.mockRejectedValueOnce(new Error('boom'));
    await expect(useChannelWorkStore.getState().ensureReqs('ch-1')).resolves.toBeUndefined();
    expect(useChannelWorkStore.getState().reqs['ch-1']).toBeUndefined();
    mockReqList.mockResolvedValue({ data: { success: true, data: [] } });
    await useChannelWorkStore.getState().ensureReqs('ch-1');
    expect(mockReqList).toHaveBeenCalledTimes(2);
  });
});

describe('channelWorkStore — suggestions slice', () => {
  const goodSuggestions = {
    suggestions: [
      { id: 's-1', kind: 'prompt', params: { wuId: 'wu-1' }, text: '继续' },
      { id: 'bad', kind: 123 }, // 畸形条目 → 过滤
    ],
    currentWuId: 'wu-1',
  };

  it('成功返回落 slice（畸形条目过滤 fail-closed）+ resolved 置位；currentWuId 非字符串 → null', async () => {
    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: goodSuggestions } });
    await useChannelWorkStore.getState().refreshSuggestions('ch-1');
    const slice = useChannelWorkStore.getState().suggestions['ch-1'];
    expect(slice?.resolved).toBe(true);
    expect(slice?.currentWuId).toBe('wu-1');
    expect(slice?.suggestions).toHaveLength(1);
    expect(slice?.suggestions[0].id).toBe('s-1');

    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: { suggestions: [], currentWuId: 42 } } });
    await useChannelWorkStore.getState().refreshSuggestions('ch-1');
    expect(useChannelWorkStore.getState().suggestions['ch-1']?.currentWuId).toBeNull();
  });

  it('degraded:true → console.warn + 留旧数据不置 resolved（不误显空闲）', async () => {
    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: goodSuggestions } });
    await useChannelWorkStore.getState().refreshSuggestions('ch-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: { degraded: true, suggestions: [] } } });
    await useChannelWorkStore.getState().refreshSuggestions('ch-1');
    const slice = useChannelWorkStore.getState().suggestions['ch-1'];
    expect(slice?.suggestions).toHaveLength(1); // 旧数据保留
    expect(slice?.currentWuId).toBe('wu-1');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('首拉 degraded → slice 缺键（resolved 缺省 = 加载态）；拉取失败静默留旧数据', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: { degraded: true, suggestions: [] } } });
    await useChannelWorkStore.getState().refreshSuggestions('ch-1');
    expect(useChannelWorkStore.getState().suggestions['ch-1']).toBeUndefined();
    warn.mockRestore();

    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: goodSuggestions } });
    await useChannelWorkStore.getState().refreshSuggestions('ch-1');
    mockGetSuggestions.mockRejectedValue(new Error('boom'));
    await expect(useChannelWorkStore.getState().refreshSuggestions('ch-1')).resolves.toBeUndefined();
    expect(useChannelWorkStore.getState().suggestions['ch-1']?.suggestions).toHaveLength(1);
  });

  it('markSuggestionsDirty 500ms trailing 防抖：连发合并为一次重拉', async () => {
    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: goodSuggestions } });
    vi.useFakeTimers();
    try {
      useChannelWorkStore.getState().markSuggestionsDirty('ch-1');
      vi.advanceTimersByTime(200);
      useChannelWorkStore.getState().markSuggestionsDirty('ch-1');
      vi.advanceTimersByTime(200);
      useChannelWorkStore.getState().markSuggestionsDirty('ch-1');
      expect(mockGetSuggestions).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(mockGetSuggestions).toHaveBeenCalledTimes(1);
      expect(mockGetSuggestions).toHaveBeenCalledWith('ch-1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('channelWorkStore — applyWorkunitSnapshot（status_changed 全量快照直替）', () => {
  beforeEach(() => {
    mockWuList.mockResolvedValue({ data: { success: true, data: [wuFixture('wu-1', { scope: '旧范围' })] } });
  });

  it('已知 WU：全量直替（服务端 updatedAt 原样落库，不用客户端时钟编造），数组顺序不变', async () => {
    await useChannelWorkStore.getState().ensureWus('ch-1');
    useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1', wuFixture('wu-1', {
      status: 'done', scope: '新范围', updatedAt: '2026-09-02T03:04:05Z', completedAt: '2026-09-02T03:04:05Z',
    }));
    const list = useChannelWorkStore.getState().wus['ch-1']!;
    expect(list).toHaveLength(1);
    expect(list[0].status).toBe('done');
    expect(list[0].scope).toBe('新范围');
    expect(list[0].updatedAt).toBe('2026-09-02T03:04:05Z'); // 服务端时间戳直替，非 new Date() 编造
    expect(list[0].completedAt).toBe('2026-09-02T03:04:05Z');
  });

  it('未知 WU：插入（createdAt/updatedAt 取快照原值，不编造）；未打底的频道 no-op', async () => {
    await useChannelWorkStore.getState().ensureWus('ch-1');
    useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1', wuFixture('wu-2', {
      createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z',
    }));
    const list = useChannelWorkStore.getState().wus['ch-1']!;
    expect(list).toHaveLength(2);
    expect(list[1].id).toBe('wu-2');
    expect(list[1].createdAt).toBe('2026-09-02T00:00:00Z');

    useChannelWorkStore.getState().applyWorkunitSnapshot('ch-9', wuFixture('wu-3', { channelId: 'ch-9' }));
    expect(useChannelWorkStore.getState().wus['ch-9']).toBeUndefined();
  });

  it('快照缺 dependsOn（快照契约无此字段）：既有条目保留旧值，新条目补空串', async () => {
    mockWuList.mockResolvedValue({ data: { success: true, data: [wuFixture('wu-1', { dependsOn: 'wu-0' })] } });
    await useChannelWorkStore.getState().ensureWus('ch-1');
    const snapshot: Partial<WorkUnit> = { ...wuFixture('wu-1', { status: 'done' }) };
    delete snapshot.dependsOn;
    useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1', snapshot as WorkUnit);
    expect(useChannelWorkStore.getState().wus['ch-1']![0].dependsOn).toBe('wu-0');

    const snapshot2: Partial<WorkUnit> = { ...wuFixture('wu-2') };
    delete snapshot2.dependsOn;
    useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1', snapshot2 as WorkUnit);
    expect(useChannelWorkStore.getState().wus['ch-1']![1].dependsOn).toBe('');
  });

  it('坏负载（缺 id/status）no-op', async () => {
    await useChannelWorkStore.getState().ensureWus('ch-1');
    useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1', null);
    useChannelWorkStore.getState().applyWorkunitSnapshot('ch-1', { id: 'wu-9' } as unknown as WorkUnit);
    expect(useChannelWorkStore.getState().wus['ch-1']).toHaveLength(1);
  });
});

describe('channelWorkStore — applyWorkunitRemoved（workunit:removed 删行分支，#538）', () => {
  beforeEach(() => {
    mockWuList.mockResolvedValue({ data: { success: true, data: [wuFixture('wu-1'), wuFixture('wu-2')] } });
  });

  it('已打底频道：按 id 删行，其余行不动', async () => {
    await useChannelWorkStore.getState().ensureWus('ch-1');
    useChannelWorkStore.getState().applyWorkunitRemoved('ch-1', 'wu-1');
    const list = useChannelWorkStore.getState().wus['ch-1']!;
    expect(list.map(w => w.id)).toEqual(['wu-2']);
  });

  it('未打底频道 / 未知 id：no-op', async () => {
    useChannelWorkStore.getState().applyWorkunitRemoved('ch-9', 'wu-1');
    expect(useChannelWorkStore.getState().wus['ch-9']).toBeUndefined();

    await useChannelWorkStore.getState().ensureWus('ch-1');
    useChannelWorkStore.getState().applyWorkunitRemoved('ch-1', 'wu-404');
    expect(useChannelWorkStore.getState().wus['ch-1']).toHaveLength(2);
  });

  it('坏负载（空 id）no-op', async () => {
    await useChannelWorkStore.getState().ensureWus('ch-1');
    useChannelWorkStore.getState().applyWorkunitRemoved('ch-1', '');
    expect(useChannelWorkStore.getState().wus['ch-1']).toHaveLength(2);
  });
});

describe('channelWorkStore — applyGateResult（闸门动作 write-through）', () => {
  it('直替命中条目；未打底频道 no-op 不建 slice', async () => {
    mockWuList.mockResolvedValue({ data: { success: true, data: [wuFixture('wu-1')] } });
    await useChannelWorkStore.getState().ensureWus('ch-1');
    useChannelWorkStore.getState().applyGateResult('ch-1', wuFixture('wu-1', { status: 'review' }));
    expect(useChannelWorkStore.getState().wus['ch-1']![0].status).toBe('review');
    useChannelWorkStore.getState().applyGateResult('ch-9', wuFixture('wu-1', { channelId: 'ch-9' }));
    expect(useChannelWorkStore.getState().wus['ch-9']).toBeUndefined();
  });
});

describe('channelWorkStore — applyRequirementEvent（envelope 解包就地 upsert，#415 修法）', () => {
  beforeEach(() => {
    mockReqList.mockResolvedValue({ data: { success: true, data: [reqFixture('REQ-1', { title: '旧标题' })] } });
  });

  it('created：列表没有则追加；同 id 已存在不重复（updater 内去重）', async () => {
    await useChannelWorkStore.getState().ensureReqs('ch-1');
    useChannelWorkStore.getState().applyRequirementEvent('ch-1', 'created', reqFixture('REQ-2'));
    expect(useChannelWorkStore.getState().reqs['ch-1']).toHaveLength(2);
    useChannelWorkStore.getState().applyRequirementEvent('ch-1', 'created', reqFixture('REQ-2', { title: '改' }));
    const list = useChannelWorkStore.getState().reqs['ch-1']!;
    expect(list).toHaveLength(2);
    expect(list[1].title).toBe('需求REQ-2'); // 不覆盖
  });

  it('updated：全量覆盖已有条目；列表没有则不动（交由重连 refetch）', async () => {
    await useChannelWorkStore.getState().ensureReqs('ch-1');
    useChannelWorkStore.getState().applyRequirementEvent('ch-1', 'updated', reqFixture('REQ-1', { title: '新标题', status: 'done' }));
    const list = useChannelWorkStore.getState().reqs['ch-1']!;
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('新标题');
    expect(list[0].status).toBe('done');

    useChannelWorkStore.getState().applyRequirementEvent('ch-1', 'updated', reqFixture('REQ-9'));
    expect(useChannelWorkStore.getState().reqs['ch-1']).toHaveLength(1);
  });

  it('未打底频道 no-op；坏负载（缺 id）no-op', async () => {
    useChannelWorkStore.getState().applyRequirementEvent('ch-9', 'created', reqFixture('REQ-1'));
    expect(useChannelWorkStore.getState().reqs['ch-9']).toBeUndefined();
    await useChannelWorkStore.getState().ensureReqs('ch-1');
    useChannelWorkStore.getState().applyRequirementEvent('ch-1', 'created', { title: '无 id' } as unknown as Requirement);
    expect(useChannelWorkStore.getState().reqs['ch-1']).toHaveLength(1);
  });
});

describe('channelWorkStore — ensureWuChangedFiles（per-wuId 文件集）', () => {
  it('并发 fanOut 一次落库；已拉过的 wuId 不重拉；失败记 [] 不重试', async () => {
    mockGetChangedFiles.mockImplementation((id: string) =>
      id === 'wu-bad'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ data: { success: true, data: { files: [`${id}.ts`] } } }));
    useChannelWorkStore.getState().ensureWuChangedFiles(['wu-1', 'wu-bad']);
    useChannelWorkStore.getState().ensureWuChangedFiles(['wu-1']); // 在途/已拉不重复
    await vi.waitFor(() => {
      expect(useChannelWorkStore.getState().wuChangedFiles['wu-1']).toEqual(['wu-1.ts']);
    });
    expect(useChannelWorkStore.getState().wuChangedFiles['wu-bad']).toEqual([]); // 失败记 [] 该 WU 走候选集词表
    useChannelWorkStore.getState().ensureWuChangedFiles(['wu-1', 'wu-bad']);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockGetChangedFiles).toHaveBeenCalledTimes(2); // 失败也不重试
  });
});

describe('channelWorkStore — ensureChannelWork（sync 接线聚合入口）', () => {
  it('缺省只刷 wus/reqs（TTL 门禁）；maxAgeMs:0 强刷三 slice 含 suggestions', async () => {
    mockWuList.mockResolvedValue({ data: { success: true, data: [] } });
    mockReqList.mockResolvedValue({ data: { success: true, data: [] } });
    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: { suggestions: [], currentWuId: null } } });
    await useChannelWorkStore.getState().ensureChannelWork('ch-1');
    expect(mockWuList).toHaveBeenCalledTimes(1);
    expect(mockReqList).toHaveBeenCalledTimes(1);
    expect(mockGetSuggestions).not.toHaveBeenCalled(); // suggestions 纯事件驱动不随轮询
    await useChannelWorkStore.getState().ensureChannelWork('ch-1', { maxAgeMs: 0 });
    expect(mockWuList).toHaveBeenCalledTimes(2);
    expect(mockReqList).toHaveBeenCalledTimes(2);
    expect(mockGetSuggestions).toHaveBeenCalledTimes(1); // 重连语义：全 slice 强刷
  });
});

describe('channelWorkStore — wuIdleOf 派生（#488 工作条占位三态）', () => {
  it('已 resolved 且 currentWuId=null → true；未拉取/未 resolved/有当前工单 → false', async () => {
    expect(wuIdleOf(undefined)).toBe(false); // 未拉到 = 加载态
    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: { suggestions: [], currentWuId: null } } });
    await useChannelWorkStore.getState().refreshSuggestions('ch-1');
    expect(wuIdleOf(useChannelWorkStore.getState().suggestions['ch-1'])).toBe(true); // 已返回且无当前工单 = 空闲
    mockGetSuggestions.mockResolvedValue({ data: { success: true, data: { suggestions: [], currentWuId: 'wu-1' } } });
    await useChannelWorkStore.getState().refreshSuggestions('ch-1');
    expect(wuIdleOf(useChannelWorkStore.getState().suggestions['ch-1'])).toBe(false);
  });
});
