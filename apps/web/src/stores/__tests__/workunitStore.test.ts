// Contract test: workunitStore — MVP-3 Review UI
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module before importing store
vi.mock('../../api/workunit', () => ({
  workunitApi: {
    list: vi.fn().mockResolvedValue({ data: { data: [], pagination: { total: 0, page: 1, limit: 20, totalPages: 0 } } }),
    create: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn(),
  },
}));

import { useWorkUnitStore } from '../workunitStore';
import { workunitApi } from '../../api/workunit';

// #545：闸门三动作（reviewPassed/reviewRejected/confirmPending）已从 store 删除——
// 写路径唯一正本为 utils/gateWriter（WuGateActions 直消费），其契约由 gateWriter.test.ts 单点覆盖

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

// #318：SSE 负载驱动行更新——status_changed 直替/移除、created 插入，total 近似维护（本地 ±1，
// 页边界不追齐，靠兜底轮询与重连 refetch 自愈；取舍记录见 docs/plans/2026-08-24-wu-events-payload-consumers.md）
describe('workunitStore applyWorkunitEvent — SSE 负载驱动行更新（#318）', () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, scope: `scope-${id}`, type: 'task', status: 'active', metadata: null, ...overrides }) as unknown as import('../../api/workunit').WorkUnit;

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

  it('status_changed 直替已有行（负载字段全覆盖），total 不变', () => {
    useWorkUnitStore.setState({ workunits: [row('wu-1'), row('wu-2')], total: 2 });
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-2', { status: 'done', completedAt: '2026-08-24T00:00:00Z' }), { insertIfMissing: false });
    const s = useWorkUnitStore.getState();
    expect(s.workunits).toHaveLength(2);
    expect(s.workunits[1].status).toBe('done');
    expect(s.workunits[1].completedAt).toBe('2026-08-24T00:00:00Z');
    expect(s.total).toBe(2);
  });

  it('旧形状负载（无 claimable）直替时保留行原 claimable（ADR D2 回退）', () => {
    useWorkUnitStore.setState({ workunits: [row('wu-1', { status: 'unassigned', claimable: false })], total: 1 });
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1', { status: 'unassigned', scope: '改后' }), { insertIfMissing: false });
    const s = useWorkUnitStore.getState();
    expect(s.workunits[0].scope).toBe('改后');
    expect(s.workunits[0].claimable).toBe(false);
  });

  it('行变更后不符 statusFilter -> 移除且 total-1', () => {
    useWorkUnitStore.setState({ statusFilter: 'active', workunits: [row('wu-1'), row('wu-2')], total: 5 });
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1', { status: 'done' }), { insertIfMissing: false });
    const s = useWorkUnitStore.getState();
    expect(s.workunits.map(w => w.id)).toEqual(['wu-2']);
    expect(s.total).toBe(4);
  });

  it('created -> 新行插入头部且 total+1；status_changed 未知行不插入（防跨页重复）', () => {
    useWorkUnitStore.setState({ workunits: [row('wu-1')], total: 1 });
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-9'), { insertIfMissing: false });
    expect(useWorkUnitStore.getState().workunits).toHaveLength(1);
    expect(useWorkUnitStore.getState().total).toBe(1);
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-2'), { insertIfMissing: true });
    const s = useWorkUnitStore.getState();
    expect(s.workunits.map(w => w.id)).toEqual(['wu-2', 'wu-1']);
    expect(s.total).toBe(2);
  });

  it('created 不符 statusFilter / typeFilter 不插入', () => {
    useWorkUnitStore.setState({ statusFilter: 'active', workunits: [], total: 0 });
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1', { status: 'pending' }), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().workunits).toHaveLength(0);
    expect(useWorkUnitStore.getState().total).toBe(0);
    useWorkUnitStore.setState({ statusFilter: null, typeFilter: 'review' });
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-2', { status: 'active' }), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().workunits).toHaveLength(0);
  });
});

// #538（ADR 2026-09-15 决策 5）：workunit:removed 删行分支——GC/TTL 删除不再悬挂到重连 refetch
describe('workunitStore removeWorkunit — workunit:removed 删行（#538）', () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, scope: `scope-${id}`, type: 'task', status: 'active', metadata: null, ...overrides }) as unknown as import('../../api/workunit').WorkUnit;

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkUnitStore.setState({
      workunits: [row('wu-1'), row('wu-2')],
      total: 2,
      allTotal: 10,
      page: 1,
      limit: 20,
      statusFilter: null,
      typeFilter: null,
      loading: false,
      error: null,
    });
  });

  it('已知行：移除且 total/allTotal 各 -1', () => {
    useWorkUnitStore.getState().removeWorkunit('wu-1');
    const s = useWorkUnitStore.getState();
    expect(s.workunits.map(w => w.id)).toEqual(['wu-2']);
    expect(s.total).toBe(1);
    expect(s.allTotal).toBe(9);
  });

  it('未知行 / 空 id：no-op（计数不动）', () => {
    useWorkUnitStore.getState().removeWorkunit('wu-404');
    useWorkUnitStore.getState().removeWorkunit('');
    const s = useWorkUnitStore.getState();
    expect(s.workunits).toHaveLength(2);
    expect(s.total).toBe(2);
    expect(s.allTotal).toBe(10);
  });

  it('allTotal 未拉取（null）时不编造', () => {
    useWorkUnitStore.setState({ allTotal: null });
    useWorkUnitStore.getState().removeWorkunit('wu-1');
    expect(useWorkUnitStore.getState().allTotal).toBeNull();
  });
});

// E2-5（承接批次 B-3）：追加式翻页——loadMoreWorkUnits 拉下一页拼接尾部（按 id 去重），page 随响应前进
describe('workunitStore loadMoreWorkUnits — 追加式分页（E2-5）', () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, scope: `scope-${id}`, type: 'task', status: 'active', metadata: null, ...overrides }) as unknown as import('../../api/workunit').WorkUnit;

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkUnitStore.setState({
      workunits: [row('wu-1'), row('wu-2')],
      total: 5,
      page: 1,
      limit: 2,
      statusFilter: null,
      typeFilter: null,
      unattributedOnly: false,
      unattributedTotal: null,
      loading: false,
      error: null,
    });
  });

  it('拉下一页追加拼接（不去重时含 SSE 插头部重叠行 → 按 id 去重），page/total 随响应前进', async () => {
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        // wu-2 重叠（SSE created 插头部顶位导致），应被去重
        data: [row('wu-2'), row('wu-3'), row('wu-4')],
        pagination: { total: 5, page: 2, limit: 2, totalPages: 3 },
      },
    });

    await useWorkUnitStore.getState().loadMoreWorkUnits();

    const s = useWorkUnitStore.getState();
    expect(workunitApi.list).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 2 }));
    expect(s.workunits.map(w => w.id)).toEqual(['wu-1', 'wu-2', 'wu-3', 'wu-4']);
    expect(s.page).toBe(2);
    expect(s.total).toBe(5);
    expect(s.loading).toBe(false);
  });

  it('携带当前过滤维度（statusFilter / unattributedOnly）请求下一页', async () => {
    useWorkUnitStore.setState({ statusFilter: 'active', unattributedOnly: true });
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-3')], pagination: { total: 5, page: 2, limit: 2, totalPages: 3 } },
    });

    await useWorkUnitStore.getState().loadMoreWorkUnits();

    expect(workunitApi.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', attributed: false, page: 2 }));
  });

  it('已到底（workunits.length >= total）或在途 → no-op 不发请求', async () => {
    useWorkUnitStore.setState({ workunits: [row('wu-1'), row('wu-2')], total: 2 });
    await useWorkUnitStore.getState().loadMoreWorkUnits();
    expect(workunitApi.list).not.toHaveBeenCalled();

    useWorkUnitStore.setState({ total: 5, loading: true });
    await useWorkUnitStore.getState().loadMoreWorkUnits();
    expect(workunitApi.list).not.toHaveBeenCalled();
  });

  it('请求失败 → error 置位、loading 复位、原列表不动', async () => {
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));

    await useWorkUnitStore.getState().loadMoreWorkUnits();

    const s = useWorkUnitStore.getState();
    expect(s.error).toBe('network down');
    expect(s.loading).toBe(false);
    expect(s.workunits.map(w => w.id)).toEqual(['wu-1', 'wu-2']);
    expect(s.page).toBe(1);
  });
});
// #405：未归属过滤（消费 #428 attributed=false 服务端过滤）——
// 请求带参、徽标计数取服务端 total（非当前页近似）、SSE 增量不混入不符行
describe('workunitStore 未归属过滤（#405）', () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, scope: `scope-${id}`, type: 'task', status: 'active', metadata: null, ...overrides }) as unknown as import('../../api/workunit').WorkUnit;

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkUnitStore.setState({
      workunits: [],
      total: 0,
      page: 1,
      limit: 20,
      statusFilter: null,
      typeFilter: null,
      unattributedOnly: false,
      unattributedTotal: null,
      loading: false,
      error: null,
    });
  });

  it('setUnattributedOnly(true)：请求带 attributed=false，徽标计数取 pagination.total（服务端口径）', async () => {
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        data: [row('wu-o1')],
        pagination: { total: 42, page: 1, limit: 20, totalPages: 3 },
      },
    });

    await useWorkUnitStore.getState().setUnattributedOnly(true);

    expect(workunitApi.list).toHaveBeenCalledWith(expect.objectContaining({ attributed: false }));
    const s = useWorkUnitStore.getState();
    expect(s.unattributedOnly).toBe(true);
    expect(s.unattributedTotal).toBe(42); // 服务端 total，非当前页条数 1
  });

  it('setUnattributedOnly(false)：取消过滤，请求不带 attributed，恢复原列表行为', async () => {
    useWorkUnitStore.setState({ unattributedOnly: true });

    await useWorkUnitStore.getState().setUnattributedOnly(false);

    expect(workunitApi.list).toHaveBeenCalledWith(expect.objectContaining({ attributed: undefined }));
    expect(useWorkUnitStore.getState().unattributedOnly).toBe(false);
  });

  it('loadUnattributedCount：limit=1 轻量查询取服务端 total 作徽标', async () => {
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-x')], pagination: { total: 42, page: 1, limit: 1, totalPages: 42 } },
    });

    await useWorkUnitStore.getState().loadUnattributedCount();

    expect(workunitApi.list).toHaveBeenCalledWith(expect.objectContaining({ attributed: false, limit: 1 }));
    expect(useWorkUnitStore.getState().unattributedTotal).toBe(42);
  });

  it('unattributedOnly 时 SSE created：有 reqId / 有戳（含 legacy）的行不插入，未归属行插入', () => {
    useWorkUnitStore.setState({ unattributedOnly: true, workunits: [], total: 0 });

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-a', { reqId: 'REQ-1' }), { insertIfMissing: true });
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-b', { metadata: JSON.stringify({ pmoId: 'PMO-1' }) }), { insertIfMissing: true });
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-c', { metadata: JSON.stringify({ ownershipProjectId: 'PMO-2' }) }), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().workunits).toHaveLength(0);

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-d'), { insertIfMissing: true });
    const s = useWorkUnitStore.getState();
    expect(s.workunits.map(w => w.id)).toEqual(['wu-d']);
    expect(s.total).toBe(1);
  });

  it('unattributedOnly 时行变更后获得归属 -> 移除且 total-1', () => {
    useWorkUnitStore.setState({ unattributedOnly: true, workunits: [row('wu-1')], total: 5 });

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1', { reqId: 'REQ-9' }), { insertIfMissing: false });

    const s = useWorkUnitStore.getState();
    expect(s.workunits).toHaveLength(0);
    expect(s.total).toBe(4);
  });

  it('unattributedOnly 与 statusFilter 组合（交集语义）', () => {
    useWorkUnitStore.setState({ unattributedOnly: true, statusFilter: 'active', workunits: [], total: 0 });

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1', { status: 'done' }), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().workunits).toHaveLength(0);

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-2', { status: 'active' }), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().workunits.map(w => w.id)).toEqual(['wu-2']);
  });

  it('组合过滤下徽标不被交集计数污染（code-review 回归：徽标 = 未归属总数，非 未归属∩状态）', async () => {
    // 先开未归属过滤：徽标 = 服务端总数 42
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-o1')], pagination: { total: 42, page: 1, limit: 20, totalPages: 3 } },
    });
    await useWorkUnitStore.getState().setUnattributedOnly(true);
    expect(useWorkUnitStore.getState().unattributedTotal).toBe(42);

    // 再叠加状态过滤：交集查询 total=3 不得覆盖徽标
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-o2')], pagination: { total: 3, page: 1, limit: 20, totalPages: 1 } },
    });
    useWorkUnitStore.getState().setStatusFilter('active');
    await new Promise(resolve => setTimeout(resolve, 0)); // 等 loadWorkUnits 落完

    const s = useWorkUnitStore.getState();
    expect(s.unattributedTotal).toBe(42); // 徽标保持未归属总数
    expect(s.total).toBe(3); // 列表计数是交集（各自口径正确）
  });
});

// 批次 D-2 项4：标题搜索 —— q 状态进 loadWorkUnits/loadMoreWorkUnits 参数，
// SSE 增量不匹配 q 就不插入（与 status 过滤同模式）
describe('workunitStore 标题搜索（批次 D-2 项4）', () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, scope: `scope-${id}`, type: 'task', status: 'active', metadata: null, ...overrides }) as unknown as import('../../api/workunit').WorkUnit;

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkUnitStore.setState({
      workunits: [],
      total: 0,
      page: 1,
      limit: 20,
      statusFilter: null,
      typeFilter: null,
      unattributedOnly: false,
      unattributedTotal: null,
      searchQuery: null,
      loading: false,
      error: null,
    });
  });

  it('setSearchQuery：请求带 q 且重置到第 1 页', async () => {
    await useWorkUnitStore.getState().setSearchQuery('登录');

    expect(workunitApi.list).toHaveBeenCalledWith(expect.objectContaining({ q: '登录', page: 1 }));
    expect(useWorkUnitStore.getState().searchQuery).toBe('登录');
  });

  it('setSearchQuery 空白 → null（清除搜索），请求不带 q', async () => {
    useWorkUnitStore.setState({ searchQuery: '登录' });

    await useWorkUnitStore.getState().setSearchQuery('   ');

    expect(workunitApi.list).toHaveBeenCalledWith(expect.objectContaining({ q: undefined }));
    expect(useWorkUnitStore.getState().searchQuery).toBeNull();
  });

  it('词未变 → no-op 不重拉（防抖尾抖/重复提交防护）', async () => {
    useWorkUnitStore.setState({ searchQuery: '登录' });

    await useWorkUnitStore.getState().setSearchQuery('登录');

    expect(workunitApi.list).not.toHaveBeenCalled();
  });

  it('loadMoreWorkUnits 携带当前 q 请求下一页', async () => {
    useWorkUnitStore.setState({ searchQuery: 'login', workunits: [row('wu-1')], total: 5 });
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-2')], pagination: { total: 5, page: 2, limit: 20, totalPages: 1 } },
    });

    await useWorkUnitStore.getState().loadMoreWorkUnits();

    expect(workunitApi.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'login', page: 2 }));
  });

  it('搜索态下 SSE created：不匹配 q 的行不插入，匹配（大小写不敏感）的插入', () => {
    useWorkUnitStore.setState({ searchQuery: 'login', workunits: [], total: 0 });

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-a', { scope: '实现登录功能' }), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().workunits).toHaveLength(0);

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-b', { scope: 'Fix Login redirect' }), { insertIfMissing: true });
    const s = useWorkUnitStore.getState();
    expect(s.workunits.map(w => w.id)).toEqual(['wu-b']);
    expect(s.total).toBe(1);
  });

  it('搜索态下行 scope 变更后不再匹配 q -> 移除且 total-1', () => {
    useWorkUnitStore.setState({ searchQuery: '登录', workunits: [row('wu-1', { scope: '登录功能' })], total: 5 });

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1', { scope: '登出功能' }), { insertIfMissing: false });

    const s = useWorkUnitStore.getState();
    expect(s.workunits).toHaveLength(0);
    expect(s.total).toBe(4);
  });

  it('搜索态下未归属徽标不被交集计数污染（同 #405 组合口径）', async () => {
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-o1')], pagination: { total: 42, page: 1, limit: 20, totalPages: 3 } },
    });
    await useWorkUnitStore.getState().setUnattributedOnly(true);
    expect(useWorkUnitStore.getState().unattributedTotal).toBe(42);

    // 叠加搜索：交集查询 total=3 不得覆盖徽标
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-o2')], pagination: { total: 3, page: 1, limit: 20, totalPages: 1 } },
    });
    await useWorkUnitStore.getState().setSearchQuery('登录');

    const s = useWorkUnitStore.getState();
    expect(s.unattributedTotal).toBe(42);
    expect(s.total).toBe(3);
  });
});

// 全量总数徽标 allTotal（「总数」chip 专用）：total 是过滤态计数，切 tab 后不得冒充全量——
// 无过滤 loadWorkUnits 顺带同步；过滤态由 loadAllCount（limit=1）补齐；SSE created 全局 +1
describe('workunitStore 全量总数徽标 allTotal', () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, scope: `scope-${id}`, type: 'task', status: 'active', metadata: null, ...overrides }) as unknown as import('../../api/workunit').WorkUnit;

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkUnitStore.setState({
      workunits: [],
      total: 0,
      page: 1,
      limit: 20,
      statusFilter: null,
      typeFilter: null,
      unattributedOnly: false,
      unattributedTotal: null,
      allTotal: null,
      searchQuery: null,
      loading: false,
      error: null,
    });
  });

  it('无过滤 loadWorkUnits 顺带同步 allTotal；带 status 过滤的加载不覆盖 allTotal', async () => {
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-1')], pagination: { total: 47, page: 1, limit: 20, totalPages: 3 } },
    });
    await useWorkUnitStore.getState().loadWorkUnits();
    expect(useWorkUnitStore.getState().allTotal).toBe(47);

    // 切 tab：过滤计数 total=3，allTotal 保持 47（chip 不变脸）
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-2', { status: 'pending' })], pagination: { total: 3, page: 1, limit: 20, totalPages: 1 } },
    });
    useWorkUnitStore.getState().setStatusFilter('pending');
    await new Promise(resolve => setTimeout(resolve, 0));
    const s = useWorkUnitStore.getState();
    expect(s.total).toBe(3);
    expect(s.allTotal).toBe(47);
  });

  it('loadAllCount：limit=1 无过滤轻量查询取服务端 total；失败留旧值', async () => {
    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { data: [row('wu-x')], pagination: { total: 47, page: 1, limit: 1, totalPages: 47 } },
    });
    await useWorkUnitStore.getState().loadAllCount();
    expect(workunitApi.list).toHaveBeenCalledWith({ page: 1, limit: 1 });
    expect(useWorkUnitStore.getState().allTotal).toBe(47);

    (workunitApi.list as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network down'));
    await useWorkUnitStore.getState().loadAllCount();
    expect(useWorkUnitStore.getState().allTotal).toBe(47); // 留旧值
  });

  it('SSE created：全局新增 allTotal+1（不符当前过滤也计）；status_changed 移出列表不影响 allTotal', () => {
    useWorkUnitStore.setState({ statusFilter: 'active', workunits: [row('wu-1')], total: 5, allTotal: 47 });

    // created 不符过滤：不插入列表，但全局总数仍 +1
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-9', { status: 'pending' }), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().workunits).toHaveLength(1);
    expect(useWorkUnitStore.getState().allTotal).toBe(48);

    // created 符合过滤：插头部 + total/allTotal 各 +1
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-2'), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().total).toBe(6);
    expect(useWorkUnitStore.getState().allTotal).toBe(49);

    // 状态迁移移出过滤集：total-1，allTotal 不变（全局总量未变）
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1', { status: 'done' }), { insertIfMissing: false });
    const s = useWorkUnitStore.getState();
    expect(s.workunits.map(w => w.id)).toEqual(['wu-2']);
    expect(s.total).toBe(5);
    expect(s.allTotal).toBe(49);
  });

  it('SSE created 时 allTotal 未拉取（null）保持 null（不凭空造数）', () => {
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1'), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().allTotal).toBeNull();
  });
});

// #549（B5 收口）：detail slice（byId 快照区）——drawer 打开即 REST 打底（不做 TTL 门禁），
// status_changed 经 applyWorkunitEvent 就地 upsert；未打开过的 WU 事件 no-op（ADR 决策 2 口径）。
describe('workunitStore detail slice（#549）', () => {
  const row = (id: string, overrides: Record<string, unknown> = {}) =>
    ({ id, scope: `scope-${id}`, type: 'task', status: 'active', metadata: null, ...overrides }) as unknown as import('../../api/workunit').WorkUnit;

  beforeEach(() => {
    vi.clearAllMocks();
    useWorkUnitStore.getState().__resetForTests();
  });

  it('loadWorkUnitDetail：REST 打底落 detailById（wu 快照，error/notFound 复位）', async () => {
    (workunitApi.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: row('wu-1') });

    await useWorkUnitStore.getState().loadWorkUnitDetail('wu-1');

    expect(workunitApi.get).toHaveBeenCalledWith('wu-1');
    const d = useWorkUnitStore.getState().detailById['wu-1'];
    expect(d.wu?.id).toBe('wu-1');
    expect(d.error).toBeNull();
    expect(d.notFound).toBe(false);
  });

  it('loadWorkUnitDetail 404 → notFound 友好态（无 error 文案）', async () => {
    (workunitApi.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 404'), { isAxiosError: true, response: { status: 404 } }),
    );

    await useWorkUnitStore.getState().loadWorkUnitDetail('wu-gone');

    const d = useWorkUnitStore.getState().detailById['wu-gone'];
    expect(d.notFound).toBe(true);
    expect(d.error).toBeNull();
    expect(d.wu).toBeNull();
  });

  it('loadWorkUnitDetail 非 404 → error 文案（服务端 error.message 优先）', async () => {
    (workunitApi.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 500'), {
        isAxiosError: true,
        response: { status: 500, data: { error: { message: '服务端挂了' } } },
      }),
    );

    await useWorkUnitStore.getState().loadWorkUnitDetail('wu-1');

    const d = useWorkUnitStore.getState().detailById['wu-1'];
    expect(d.notFound).toBe(false);
    expect(d.error).toBe('服务端挂了');
  });

  it('applyWorkunitEvent：已打开的 detail 就地 upsert（含 status_changed 与 created）；未打开 no-op', async () => {
    (workunitApi.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: row('wu-1') });
    await useWorkUnitStore.getState().loadWorkUnitDetail('wu-1');

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-1', { status: 'done' }), { insertIfMissing: false });
    expect(useWorkUnitStore.getState().detailById['wu-1'].wu?.status).toBe('done');

    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-2'), { insertIfMissing: true });
    expect(useWorkUnitStore.getState().detailById['wu-2']).toBeUndefined();

    // 未知行 status_changed（insertIfMissing: false）不动 detail
    useWorkUnitStore.getState().applyWorkunitEvent(row('wu-9'), { insertIfMissing: false });
    expect(useWorkUnitStore.getState().detailById['wu-9']).toBeUndefined();
  });
});

// #549：fresh 高亮集合——created 事件路由驱动 markWuFresh，per-id 2s 自清（机制 = utils/freshIds 共享件）
describe('workunitStore fresh 集合（#549）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useWorkUnitStore.getState().__resetForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('markWuFresh → id 进 freshWuIds，2s 后自清', () => {
    useWorkUnitStore.getState().markWuFresh('wu-1');
    expect(useWorkUnitStore.getState().freshWuIds.has('wu-1')).toBe(true);

    vi.advanceTimersByTime(2100);
    expect(useWorkUnitStore.getState().freshWuIds.has('wu-1')).toBe(false);
  });

  it('per-id 语义：后到的 id 不重计先到 id 的计时', () => {
    useWorkUnitStore.getState().markWuFresh('wu-1');
    vi.advanceTimersByTime(1500);
    useWorkUnitStore.getState().markWuFresh('wu-2');
    vi.advanceTimersByTime(600); // wu-1 到 2s
    expect(useWorkUnitStore.getState().freshWuIds.has('wu-1')).toBe(false);
    expect(useWorkUnitStore.getState().freshWuIds.has('wu-2')).toBe(true);
  });
});


// #557：listOnScreen —— 列表页在屏信号（useWorkUnitStoreSync 重连兜底的真实门槛，
// 替代「空列表代理不在屏」：过滤无结果/首拉失败留空时重连照刷）
describe('workunitStore listOnScreen（#557）', () => {
  it('默认 false；setListOnScreen 双向切换', () => {
    useWorkUnitStore.setState({ listOnScreen: false });
    expect(useWorkUnitStore.getState().listOnScreen).toBe(false);

    useWorkUnitStore.getState().setListOnScreen(true);
    expect(useWorkUnitStore.getState().listOnScreen).toBe(true);

    useWorkUnitStore.getState().setListOnScreen(false);
    expect(useWorkUnitStore.getState().listOnScreen).toBe(false);
  });
});
