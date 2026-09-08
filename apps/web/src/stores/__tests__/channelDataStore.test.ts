// channelDataStore 单测 — #403 频道数据面 store
// 三切片（词表 / current-pmo / members）按 (slice, channelId) 粒度的 TTL / single-flight / seq 守卫；
// setMembers 写穿、invalidateCurrentPmo 失效强刷、失败静默不落锚点。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetFileVocabulary, mockGetCurrentPmo, mockChannelGet } = vi.hoisted(() => ({
  mockGetFileVocabulary: vi.fn(),
  mockGetCurrentPmo: vi.fn(),
  mockChannelGet: vi.fn(),
}));

vi.mock('../../api/channel', () => ({
  channelApi: {
    getFileVocabulary: mockGetFileVocabulary,
    getCurrentPmo: mockGetCurrentPmo,
    get: mockChannelGet,
  },
}));

import { useChannelDataStore, parseChannelMembers, CHANNEL_DATA_TTL_MS } from '../channelDataStore';

const vocab = { repos: [{ repo: '/repo/a', files: ['src/index.ts'] }] };
const pmo = { id: 'proj-1', pmoNumber: 'PMO-1', title: '商城重构', gitRepos: ['/repo/a'] };

function resetStore() {
  useChannelDataStore.getState().__resetForTests();
}

describe('channelDataStore 三切片拉取与去重', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    mockGetFileVocabulary.mockResolvedValue({ data: { success: true, data: vocab } });
    mockGetCurrentPmo.mockResolvedValue({ data: { success: true, data: pmo } });
    mockChannelGet.mockResolvedValue({ data: { success: true, data: { id: 'ch-1', members: '["a1","a2"]' } } });
  });

  it('三切片各拉一次，按 channelId 落库', async () => {
    await Promise.all([
      useChannelDataStore.getState().ensureVocabulary('ch-1'),
      useChannelDataStore.getState().ensureCurrentPmo('ch-1'),
      useChannelDataStore.getState().ensureMembers('ch-1'),
    ]);
    expect(mockGetFileVocabulary).toHaveBeenCalledWith('ch-1');
    expect(mockGetCurrentPmo).toHaveBeenCalledWith('ch-1');
    expect(mockChannelGet).toHaveBeenCalledWith('ch-1');
    const s = useChannelDataStore.getState();
    expect(s.vocabulary['ch-1']).toEqual(vocab);
    expect(s.currentPmo['ch-1']).toEqual(pmo);
    expect(s.members['ch-1']).toEqual(['a1', 'a2']);
  });

  it('切片按 channelId 隔离：同切片不同频道各自拉取', async () => {
    await useChannelDataStore.getState().ensureCurrentPmo('ch-1');
    await useChannelDataStore.getState().ensureCurrentPmo('ch-2');
    expect(mockGetCurrentPmo).toHaveBeenCalledTimes(2);
  });

  it('TTL 内重复调用零重拉；TTL 过期后重拉', async () => {
    vi.useFakeTimers();
    try {
      await useChannelDataStore.getState().ensureVocabulary('ch-1');
      await useChannelDataStore.getState().ensureVocabulary('ch-1');
      expect(mockGetFileVocabulary).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(CHANNEL_DATA_TTL_MS + 1);
      await useChannelDataStore.getState().ensureVocabulary('ch-1');
      expect(mockGetFileVocabulary).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('并发调用共享单飞：同屏多消费方只发一轮请求', async () => {
    let resolveVocab!: (v: unknown) => void;
    mockGetFileVocabulary.mockReturnValue(new Promise((r) => { resolveVocab = r; }));
    const p1 = useChannelDataStore.getState().ensureVocabulary('ch-1');
    const p2 = useChannelDataStore.getState().ensureVocabulary('ch-1');
    resolveVocab({ data: { success: true, data: vocab } });
    await Promise.all([p1, p2]);
    expect(mockGetFileVocabulary).toHaveBeenCalledTimes(1);
    expect(useChannelDataStore.getState().vocabulary['ch-1']).toEqual(vocab);
  });

  it('force（maxAgeMs 0）不被在途旧 fetch 吞掉：新结果落地，旧结果不回写', async () => {
    let resolveStale!: (v: unknown) => void;
    mockGetCurrentPmo.mockReturnValueOnce(new Promise((r) => { resolveStale = r; }));
    const stale = useChannelDataStore.getState().ensureCurrentPmo('ch-1');
    // 强拉返回新 PMO，随后旧 fetch 才落地（旧 PMO）
    mockGetCurrentPmo.mockResolvedValue({
      data: { success: true, data: { ...pmo, id: 'proj-2', title: '新派生' } },
    });
    const fresh = useChannelDataStore.getState().ensureCurrentPmo('ch-1', { maxAgeMs: 0 });
    resolveStale({ data: { success: true, data: pmo } });
    await Promise.all([stale, fresh]);
    expect(useChannelDataStore.getState().currentPmo['ch-1']?.id).toBe('proj-2');
    expect(mockGetCurrentPmo).toHaveBeenCalledTimes(2);
    // inflight 锚点已清，下一次强拉可正常发起
    await useChannelDataStore.getState().ensureCurrentPmo('ch-1', { maxAgeMs: 0 });
    expect(mockGetCurrentPmo).toHaveBeenCalledTimes(3);
  });
});

describe('channelDataStore 失败与写穿语义', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  it('拉取失败：静默不落数据不落 TTL 锚点（下次调用重试），ensure 永不 reject', async () => {
    mockGetFileVocabulary.mockRejectedValue(new Error('boom'));
    await expect(useChannelDataStore.getState().ensureVocabulary('ch-1')).resolves.toBeUndefined();
    expect(useChannelDataStore.getState().vocabulary['ch-1']).toBeUndefined();
    mockGetFileVocabulary.mockResolvedValue({ data: { success: true, data: vocab } });
    await useChannelDataStore.getState().ensureVocabulary('ch-1');
    expect(useChannelDataStore.getState().vocabulary['ch-1']).toEqual(vocab);
  });

  it('后端派生为空（data=null）→ currentPmo 落 null（区别于缺键未拉）', async () => {
    mockGetCurrentPmo.mockResolvedValue({ data: { success: true, data: null } });
    await useChannelDataStore.getState().ensureCurrentPmo('ch-1');
    const s = useChannelDataStore.getState();
    expect('ch-1' in s.currentPmo).toBe(true);
    expect(s.currentPmo['ch-1']).toBeNull();
  });

  it('setMembers 写穿：data + TTL 锚点一并更新（TTL 内 ensure 零请求）', async () => {
    useChannelDataStore.getState().setMembers('ch-1', ['a9']);
    await useChannelDataStore.getState().ensureMembers('ch-1');
    expect(mockChannelGet).not.toHaveBeenCalled();
    expect(useChannelDataStore.getState().members['ch-1']).toEqual(['a9']);
  });

  it('invalidateCurrentPmo：TTL 内仍强刷新数据（订阅方拿到最新派生）', async () => {
    mockGetCurrentPmo.mockResolvedValue({ data: { success: true, data: pmo } });
    await useChannelDataStore.getState().ensureCurrentPmo('ch-1');
    // TTL 内：普通 ensure 零重拉
    await useChannelDataStore.getState().ensureCurrentPmo('ch-1');
    expect(mockGetCurrentPmo).toHaveBeenCalledTimes(1);
    // REQ 变更 → 失效强刷：拿到新派生
    mockGetCurrentPmo.mockResolvedValue({
      data: { success: true, data: { ...pmo, id: 'proj-2', title: '新 PMO' } },
    });
    useChannelDataStore.getState().invalidateCurrentPmo('ch-1');
    await vi.waitFor(() => {
      expect(useChannelDataStore.getState().currentPmo['ch-1']?.id).toBe('proj-2');
    });
    expect(mockGetCurrentPmo).toHaveBeenCalledTimes(2);
  });

  it('词表驻留上限：超过 cap 驱逐最早插入的频道', async () => {
    for (let i = 0; i < 12; i++) {
      await useChannelDataStore.getState().ensureVocabulary(`ch-${i}`);
    }
    const keys = Object.keys(useChannelDataStore.getState().vocabulary);
    expect(keys).toHaveLength(10);
    expect(keys.includes('ch-0')).toBe(false);
    expect(keys.includes('ch-11')).toBe(true);
  });
});

describe('parseChannelMembers', () => {
  it('合法 JSON 数组 → string[]；坏 JSON → []；非字符串条目过滤', () => {
    expect(parseChannelMembers('["a1","a2"]')).toEqual(['a1', 'a2']);
    expect(parseChannelMembers('invalid')).toEqual([]);
    expect(parseChannelMembers('["a1",42,null]')).toEqual(['a1']);
    expect(parseChannelMembers(null)).toEqual([]);
    expect(parseChannelMembers(undefined)).toEqual([]);
  });
});
