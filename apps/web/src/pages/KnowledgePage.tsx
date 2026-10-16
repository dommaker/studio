/**
 * 知识库页面 — 知识资产浏览 + 检索 + 成熟度管理面
 *
 * Tabs: 统一视图 | 偏好 | 规则 | 环境 | 决策链 | 交互模式 | 解法库
 * （R4: 行为模式写链路已整体删除，tab/标题残尸清理，共 7 个 tab）
 * E5（2026-09 页面重设计，docs/plans/2026-09-page-redesign.md）：
 * ① 统一视图补成熟度徽标 + 工具行「待审」筛选（maturity=draft，后端原生参数）+ draft 条目卡底
 *   「通过 / 拒绝」（promote/demote，pending 锁存 + 失败 toast，对齐批次A MonitoringPage 提案审批模式）；
 * ② 搜索态替换 tab 内容区（原浮层压 tab 栏上方与内容并存），「清除」返回 tab 视图；
 * ③ 「加载更多」改真追加（原翻页替换），对齐 E2 WU 列表 loadMoreWorkUnits 口径；
 * ④ tab 去 emoji + 激活态 borderBottom 收进 .u-tab/.u-tab-active（批次 D-4 正本形态）；
 * ⑤ 空态归 .empty-state；页底「← 前往阅览室」删除（导航归 MoreDropdown）；搜索结果类型徽标去 emoji，
 *   与统一视图同源走 CONSUMPTION_MODE_CHART 类别色文字 + 中性底。
 * Step 2（2026-09 web-ux-optional-fixes）：订阅 SSE knowledge.entry_changed（agent 产出/审批/他端新建）
 * → 当前 tab 防抖重拉；页面不可见不拉（记脏回 visible 补拉），无轮询。
 * Phase 3 拆分（2026-10）：搜索结果卡/新建表单/统一视图工具行/条目卡列表/Gap 内容区抽
 * components/knowledge/ 子组件，tab 错误条收敛 ui/SectionError（拆分来源见各子组件头注释），
 * 本文件留数据接线 + tab 骨架。
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { knowledgeApi, type KnowledgeSearchResult, type UnifiedEntry } from '../api/knowledge';
import { maintenanceApi } from '../api/maintenance';
import { toast } from '../utils/toast';
import { serverErrorMessage } from '../utils/errorMessage';
import { useAsyncData } from '../hooks/useAsyncData';
import { useSseContext } from '../api/sseHooks';
import { ManualTaskButton, SectionError, SkeletonCard } from '../components/ui';
import { IconBook } from '../components/ui/icons';
import { KnowledgeSearchResults } from '../components/knowledge/KnowledgeSearchResults';
import { ManualEntryForm, type ManualEntryFormState } from '../components/knowledge/ManualEntryForm';
import { UnifiedViewToolbar } from '../components/knowledge/UnifiedViewToolbar';
import { UnifiedEntriesSection } from '../components/knowledge/UnifiedEntriesSection';
import { GapTabContent, type GapTab, type GapItem } from '../components/knowledge/GapTabContent';

const gapLabels: Record<GapTab, string> = {
  preference: '偏好',
  business_rule: '规则',
  environment: '环境',
  decision_chain: '决策链',
  interaction: '交互模式',
  resolution: '解法库',
};

type ActiveTab = GapTab | 'unified';

/** #350 useAsyncData 单通道按 tab 取数：unified / gap 两形态一次只拉激活 tab（对齐原 effect 分派） */
type TabPayload =
  | { kind: 'unified'; entries: UnifiedEntry[]; total: number }
  | { kind: 'gap'; items: GapItem[] };

/** 统一视图分页步长（E5-3 追加式「加载更多」每页步长） */
const UNIFIED_PAGE_SIZE = 50;

export function KnowledgePage() {
  // Tab state
  const [activeTab, setActiveTab] = useState<ActiveTab>('unified');

  // S11: Unified search state（E5-2：searchActive 时搜索结果替换 tab 内容区）
  const [globalSearch, setGlobalSearch] = useState('');
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchActive, setSearchActive] = useState(false);

  // AS-022: Unified knowledge view state（mode/reviewOnly 是用户输入，进 fetcher deps 驱动重拉）
  const [unifiedMode, setUnifiedMode] = useState('');
  // E5-1：「待审」筛选（maturity=draft，/knowledge/unified 原生支持 maturity 参数）
  const [reviewOnly, setReviewOnly] = useState(false);
  // E5-3 追加式分页（#692 单真相源）：追加页并进 tabQ 同一取数通道（见 handleLoadMore），
  // 本地只留请求中锁存；切 tab/筛选/reload 由 useAsyncData deps 重置与整份替换天然丢弃旧快照追加页
  const [moreLoading, setMoreLoading] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualForm, setManualForm] = useState<ManualEntryFormState>({ type: 'guideline', title: '', content: '', consumptionMode: 'reference', tags: '' });
  // 工单 38: 新建条目提交中状态——Button loading 态防连点重复提交
  const [manualSaving, setManualSaving] = useState(false);
  // E5-1：draft 条目审批 pending 锁存
  const [actingIds, setActingIds] = useState<Set<string>>(new Set());

  // #350 useAsyncData 收一次性拉取样板：tab/mode/reviewOnly 变化渲染期重置重拉；
  // 手动任务成本（近 30 天 token）——失败不再静默落 null（2026-09 web-ux-optional-fixes Step 1），
  // error 由 hook 承接，页头按钮旁渲染最小错误行 + 重试
  const tabQ = useAsyncData(async (): Promise<TabPayload> => {
    if (activeTab === 'unified') {
      const res = await knowledgeApi.listUnified({
        limit: UNIFIED_PAGE_SIZE,
        offset: 0,
        consumptionMode: unifiedMode || undefined,
        maturity: reviewOnly ? 'draft' : undefined,
      });
      // 契约驱动迁移（批次 4/7）：响应统一 `{ data }` 壳，res.data → res.data.data
      return { kind: 'unified', entries: res.data.data.entries || [], total: res.data.data.total || 0 };
    }
    if (activeTab === 'resolution') {
      const res = await knowledgeApi.listResolutions();
      return { kind: 'gap', items: (res.data.data.resolutions || []) as unknown as GapItem[] };
    }
    const res = await knowledgeApi.listGaps(activeTab);
    return { kind: 'gap', items: (res.data.data.data || []) as GapItem[] };
  }, [activeTab, unifiedMode, reviewOnly]);
  const costsQ = useAsyncData(() => maintenanceApi.getCosts(), []);

  // Step 2：SSE 实时刷新——knowledge.entry_changed（agent 产出/审批/他端新建）到达 → 当前 tab 重拉。
  // 载荷只带轻量元信息（action/entryId/title），不足以就地拼七种 tab 形状 → reload（保留旧数据重拉）。
  // 400ms trailing 防抖合并批量事件（review-adapter 逐条目审批会发一串）；
  // 页面不可见时不拉（零额外开销，useGatedPoll 精神），记脏待回 visible 补拉一次。无轮询。
  const { onEvent } = useSseContext();
  const sseDirtyRef = useRef(false);
  const sseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadTab = tabQ.reload; // 引用稳定（useAsyncData 内 useCallback）
  useEffect(() => {
    const flush = () => {
      reloadTab(); // 整份替换首页——旧快照的追加页随之失效（#692 单真相源，无需手动清）
    };
    const off = onEvent(msg => {
      if (msg.event_type !== 'knowledge.entry_changed') return;
      if (document.hidden) { sseDirtyRef.current = true; return; }
      if (sseTimerRef.current) clearTimeout(sseTimerRef.current);
      sseTimerRef.current = setTimeout(flush, 400);
    });
    const onVisible = () => {
      if (document.hidden || !sseDirtyRef.current) return;
      sseDirtyRef.current = false;
      flush();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisible);
      if (sseTimerRef.current) clearTimeout(sseTimerRef.current);
    };
  }, [onEvent, reloadTab]);

  // AS-022: Submit manual entry
  const handleManualEntry = async () => {
    if (manualSaving) return;
    setManualSaving(true);
    try {
      await knowledgeApi.createUnifiedEntry({
        ...manualForm,
        tags: manualForm.tags ? manualForm.tags.split(',').map(t => t.trim()) : [],
      });
      setShowManualEntry(false);
      setManualForm({ type: 'guideline', title: '', content: '', consumptionMode: 'reference', tags: '' });
      tabQ.reload(); // 提交后事件路径刷新（新建表单仅在 unified 视图打开）
    } catch (err) {
      // 工单 38: 失败不再静默——toast 反馈且保留表单内容，用户可修正后重试
      // 契约驱动迁移（批次 4/7）：错误壳 `{ error: { code, message } }`——serverErrorMessage 取 message
      console.error('Failed to create entry:', err);
      const m = serverErrorMessage(err);
      toast.error(m || (err instanceof Error ? err.message : '') || '创建条目失败，请重试');
    } finally {
      setManualSaving(false);
    }
  };

  // 派生面（render 沿用原名）：unified / gap 形态按激活 tab 只有一侧有数据
  const unifiedLoading = tabQ.loading;
  // #692 单真相源：首页 + 追加页都在 tabQ.data.entries（handleLoadMore 追加进同一通道）
  const unifiedEntries = tabQ.data?.kind === 'unified' ? tabQ.data.entries : [];
  const unifiedTotal = tabQ.data?.kind === 'unified' ? tabQ.data.total : 0;
  const gapLoading = tabQ.loading;
  const gapData = tabQ.data?.kind === 'gap' ? tabQ.data.items : [];
  const costs = costsQ.data;

  // E5-3: 真追加「加载更多」——offset = 已加载条数，按 id 去重拼接进 tabQ 同一通道（对齐 E2 WU 列表 loadMoreWorkUnits 口径）
  const handleLoadMore = async () => {
    if (moreLoading) return;
    const loaded = tabQ.data?.kind === 'unified' ? tabQ.data.entries : [];
    setMoreLoading(true);
    try {
      const res = await knowledgeApi.listUnified({
        limit: UNIFIED_PAGE_SIZE,
        offset: loaded.length,
        consumptionMode: unifiedMode || undefined,
        maturity: reviewOnly ? 'draft' : undefined,
      });
      const next = res.data.data.entries || [];
      tabQ.setData(prev => {
        if (prev?.kind !== 'unified') return prev;
        const seen = new Set(prev.entries.map(e => e.id));
        return { ...prev, entries: [...prev.entries, ...next.filter(e => !seen.has(e.id))] };
      });
    } catch (e) {
      // 批次A 模式：失败不静默（服务端 error.message 优先），已加载内容保留可重试
      const m = serverErrorMessage(e);
      toast.error(m ? `加载失败：${m}` : '加载失败，请重试');
    } finally {
      setMoreLoading(false);
    }
  };

  /** E5-1: draft 条目审批——approve=promote（draft→verified）/ reject=demote（draft→archived）；成功后移出当前列表 */
  const reviewEntry = async (entryId: string, action: 'approve' | 'reject') => {
    setActingIds(prev => new Set(prev).add(entryId));
    try {
      if (action === 'approve') await knowledgeApi.promote(entryId);
      else await knowledgeApi.demote(entryId);
      // 条目 maturity 已变，不再是当前视图成员——本地移除（total 近似 -1，口径同 E2 本地维护取舍）
      tabQ.setData(prev => (prev?.kind === 'unified'
        ? { ...prev, entries: prev.entries.filter(e => e.id !== entryId), total: Math.max(0, prev.total - 1) }
        : prev));
    } catch (e) {
      // 失败保留在列表中可重试 + toast 提示（服务端 error.message 优先）
      const m = serverErrorMessage(e);
      const verb = action === 'approve' ? '通过' : '拒绝';
      toast.error(m ? `${verb}失败：${m}` : `${verb}失败，请重试`);
    } finally {
      setActingIds(prev => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
    }
  };

  // S11: Unified search across all types
  const handleGlobalSearch = useCallback(async () => {
    if (!globalSearch.trim()) { setSearchResults([]); setSearchActive(false); return; }
    setSearchLoading(true);
    setSearchActive(true);
    try {
      const res = await knowledgeApi.search(globalSearch);
      setSearchResults(res.data.data.results || []);
    } catch (e) {
      // 批次 F-1：失败不再静默置空（假「无匹配结果」空态）——toast 反馈（对齐 handleLoadMore 批次A 模式），
      // 回 tab 视图保留输入词，再次点「搜索」即重试
      const m = serverErrorMessage(e);
      toast.error(m ? `搜索失败：${m}` : '搜索失败，请重试');
      setSearchResults([]);
      setSearchActive(false);
    }
    finally { setSearchLoading(false); }
  }, [globalSearch]);

  const clearSearch = () => { setSearchActive(false); setSearchResults([]); setGlobalSearch(''); };

  const tabs: Array<{ id: ActiveTab; label: string }> = [
    { id: 'unified', label: '统一视图' },
    ...(Object.entries(gapLabels) as [GapTab, string][]).map(([id, label]) => ({ id, label })),
  ];

  return (
    <div className="h-full flex flex-col u-page-bg">
      {/* Header */}
      <div className="u-page-head">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">知识库</h1>
            <p className="page-subtitle">七大知识类型 — 统一视图 / 偏好 / 规则 / 环境 / 决策链 / 交互模式 / 解法库</p>
          </div>
          <div className="flex gap-2 items-center">
            {/* 成本子拉取失败：最小错误行 + 重试（原 .catch(() => null) 静默，costNote 凭空消失） */}
            {costsQ.error && (
              <div className="p-2 rounded u-err-dim u-err text-sm flex items-center gap-2">
                <span>{costsQ.error}</span>
                <button onClick={costsQ.reload} className="btn btn-secondary btn-sm">重试</button>
              </div>
            )}
            <ManualTaskButton
              label="质量审计"
              costNote={costs != null ? `近 30 天 ${costs.callsBySource['knowledge-maintenance'] ?? 0} 次调用` : undefined}
              onRun={async () => {
                const r = await maintenanceApi.runKnowledgeMaintenance();
                return `维护完成：合并 ${r.dedupMerged} / 归档 ${r.qualityArchived} / 更新 ${r.freshnessUpdated} / 解矛盾 ${r.contradictionsResolved}`;
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto u-page-px pb-8">
        <div className="max-w-5xl">
          {/* S11: Unified search across all knowledge types */}
          <div className="mt-4 mb-4 flex gap-2">
            <input type="text" placeholder="全局搜索知识（解法 / 交互模式 / 规则）..."
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleGlobalSearch()}
              className="input flex-1" />
            <button onClick={handleGlobalSearch} className="btn btn-primary">
              搜索
            </button>
          </div>
          {searchLoading && <div className="text-center py-2 text-sm u-text-3">搜索中...</div>}

          {searchActive ? (
            /* E5-2: 搜索态替换 tab 内容区（tab 栏一并收起），「清除」返回 tab 视图 */
            <KnowledgeSearchResults results={searchResults} onClear={clearSearch} />
          ) : (
          <>
          {/* Tab bar — E5-4：去 emoji，激活态底线收进 .u-tab/.u-tab-active */}
          <div className="flex gap-1 mb-6 overflow-x-auto pb-1 border-b u-border">
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`u-tab px-4 py-2 text-sm rounded-t-lg whitespace-nowrap transition-colors ${activeTab === tab.id ? 'u-tab-active u-surface u-accent' : 'u-text-3'}`}>
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── AS-022: Unified Knowledge Tab ── */}
          {/* 批次 F-1：tab 拉取失败错误条（tabQ.error 原先全程未渲染，落「暂无数据」假空态）+ tabQ.reload 重试 */}
          {!tabQ.loading && tabQ.error && (
            <SectionError className="mb-3" error={tabQ.error} onRetry={tabQ.reload} />
          )}
          {activeTab === 'unified' && (
            <div>
              <UnifiedViewToolbar
                mode={unifiedMode}
                onModeChange={setUnifiedMode}
                reviewOnly={reviewOnly}
                onToggleReview={() => setReviewOnly(v => !v)}
                total={unifiedTotal}
                showForm={showManualEntry}
                onToggleForm={() => setShowManualEntry(!showManualEntry)}
              />
              {showManualEntry && (
                <ManualEntryForm form={manualForm} setForm={setManualForm} saving={manualSaving} onSubmit={() => void handleManualEntry()} />
              )}
              {unifiedLoading ? (
                // 批次 F-3：加载态骨架卡片行（批次 E-2 ui/Skeleton 正本）
                <div className="space-y-3">
                  <SkeletonCard height={88} />
                  <SkeletonCard height={88} />
                  <SkeletonCard height={88} />
                </div>
              ) : tabQ.error ? null : unifiedEntries.length === 0 ? (
                // 批次 F-4：空态归 .empty-state 正本（图标 + 文案 + CTA），真空挂「手动新建」入口
                <div className="empty-state">
                  <div className="empty-icon"><IconBook size={32} /></div>
                  {reviewOnly ? (
                    <>
                      <p>暂无待审条目</p>
                      <p className="text-sm mt-2">关闭「待审」筛选可查看全部条目</p>
                    </>
                  ) : (
                    <>
                      <p>暂无数据</p>
                      <p className="text-sm mt-2">知识由系统自动积累，也可以手动新建一条</p>
                      <button className="btn btn-primary mt-4" onClick={() => setShowManualEntry(true)}>手动新建</button>
                    </>
                  )}
                </div>
              ) : (
                <UnifiedEntriesSection
                  entries={unifiedEntries}
                  total={unifiedTotal}
                  actingIds={actingIds}
                  onReview={(entryId, action) => void reviewEntry(entryId, action)}
                  moreLoading={moreLoading}
                  onLoadMore={() => void handleLoadMore()}
                />
              )}
            </div>
          )}

          {/* ── Gap Type Tabs ── */}
          {activeTab !== 'unified' && (
            <GapTabContent
              loading={gapLoading}
              error={tabQ.error}
              activeTab={activeTab}
              tabLabel={gapLabels[activeTab]}
              items={gapData}
            />
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}
