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
 */

import { useState, useCallback } from 'react';
import { knowledgeApi, type KnowledgeGapType, type KnowledgeSearchResult, type UnifiedEntry } from '../api/knowledge';
import { maintenanceApi } from '../api/maintenance';
import { toast } from '../utils/toast';
import { serverErrorMessage } from '../utils/errorMessage';
import { useAsyncData } from '../hooks/useAsyncData';
import { Select, ManualTaskButton, Button } from '../components/ui';
import {
  PreferenceCard, BusinessRuleCard, EnvSnapshotCard,
  DecisionChainCard, InteractionPatternCard, ResolutionCard,
  MATURITY_BADGE_CLASSES,
} from '../components/knowledge/GapCards';
import { UnifiedEntryContent } from '../components/knowledge/UnifiedEntryContent';
import { CONSUMPTION_MODE_CHART } from '../utils/knowledgeContent';
import type {
  PreferenceGap, BusinessRuleGap, EnvSnapshotGap,
  DecisionChainGap, InteractionGap, ResolutionGap,
} from '../components/knowledge/GapCards';

type GapTab = 'preference' | 'business_rule' | 'environment' | 'decision_chain' | 'interaction' | 'resolution';

const gapLabels: Record<GapTab, string> = {
  preference: '偏好',
  business_rule: '规则',
  environment: '环境',
  decision_chain: '决策链',
  interaction: '交互模式',
  resolution: '解法库',
};

type ActiveTab = GapTab | 'unified';

/** Gap tab 条目：六类缺口形状各异（卡片自行解读字段），仅 id 用于列表 key */
type GapItem = { id?: string } & Record<string, unknown>;

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
  // E5-3：追加式分页——首页走 tabQ（切 tab/筛选渲染期重置），追加页本地累加
  const [moreEntries, setMoreEntries] = useState<UnifiedEntry[]>([]);
  const [moreLoading, setMoreLoading] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualForm, setManualForm] = useState({ type: 'guideline', title: '', content: '', consumptionMode: 'reference', tags: '' });
  // 工单 38: 新建条目提交中状态——Button loading 态防连点重复提交
  const [manualSaving, setManualSaving] = useState(false);
  // E5-1：draft 条目审批 pending 锁存
  const [actingIds, setActingIds] = useState<Set<string>>(new Set());

  // #350 useAsyncData 收一次性拉取样板：tab/mode/reviewOnly 变化渲染期重置重拉；
  // 手动任务成本（近 30 天 token；失败静默，不阻塞页面）
  const tabQ = useAsyncData(async (): Promise<TabPayload> => {
    if (activeTab === 'unified') {
      const res = await knowledgeApi.listUnified({
        limit: UNIFIED_PAGE_SIZE,
        offset: 0,
        consumptionMode: unifiedMode || undefined,
        maturity: reviewOnly ? 'draft' : undefined,
      });
      return { kind: 'unified', entries: res.data.entries || [], total: res.data.total || 0 };
    }
    if (activeTab === 'resolution') {
      const res = await knowledgeApi.listResolutions();
      return { kind: 'gap', items: (res.data.resolutions || []) as unknown as GapItem[] };
    }
    const res = await knowledgeApi.listGaps(activeTab as KnowledgeGapType);
    return { kind: 'gap', items: (res.data.data || []) as GapItem[] };
  }, [activeTab, unifiedMode, reviewOnly]);
  const costsQ = useAsyncData(() => maintenanceApi.getCosts().catch(() => null), []);

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
      console.error('Failed to create entry:', err);
      toast.error(err?.response?.data?.error || err?.message || '创建条目失败，请重试');
    } finally {
      setManualSaving(false);
    }
  };

  // 派生面（render 沿用原名）：unified / gap 形态按激活 tab 只有一侧有数据
  const unifiedLoading = tabQ.loading;
  const baseEntries = tabQ.data?.kind === 'unified' ? tabQ.data.entries : [];
  const unifiedTotal = tabQ.data?.kind === 'unified' ? tabQ.data.total : 0;
  const unifiedEntries = moreEntries.length > 0 ? [...baseEntries, ...moreEntries] : baseEntries;
  const gapLoading = tabQ.loading;
  const gapData = tabQ.data?.kind === 'gap' ? tabQ.data.items : [];
  const costs = costsQ.data;

  // E5-3: 真追加「加载更多」——offset = 已加载条数，按 id 去重拼接（对齐 E2 WU 列表 loadMoreWorkUnits 口径）
  const handleLoadMore = async () => {
    if (moreLoading) return;
    setMoreLoading(true);
    try {
      const res = await knowledgeApi.listUnified({
        limit: UNIFIED_PAGE_SIZE,
        offset: baseEntries.length + moreEntries.length,
        consumptionMode: unifiedMode || undefined,
        maturity: reviewOnly ? 'draft' : undefined,
      });
      const next = res.data.entries || [];
      setMoreEntries(prev => {
        const seen = new Set([...baseEntries, ...prev].map(e => e.id));
        return [...prev, ...next.filter(e => !seen.has(e.id))];
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
      setMoreEntries(prev => prev.filter(e => e.id !== entryId));
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
      setSearchResults(res.data.results || []);
    } catch { setSearchResults([]); }
    finally { setSearchLoading(false); }
  }, [globalSearch]);

  const clearSearch = () => { setSearchActive(false); setSearchResults([]); setGlobalSearch(''); };

  const tabs: Array<{ id: ActiveTab; label: string }> = [
    { id: 'unified', label: '统一视图' },
    ...(Object.entries(gapLabels) as [GapTab, string][]).map(([id, label]) => ({ id, label })),
  ];

  // ── Gap type detail rendering ──
  const renderGapItem = (item: GapItem) => {
    switch (activeTab as GapTab) {
      case 'preference':
        return <PreferenceCard item={item as PreferenceGap} />;
      case 'business_rule':
        return <BusinessRuleCard item={item as BusinessRuleGap} />;
      case 'environment':
        return <EnvSnapshotCard item={item as EnvSnapshotGap} />;
      case 'decision_chain':
        return <DecisionChainCard item={item as DecisionChainGap} />;
      case 'interaction':
        return <InteractionPatternCard item={item as InteractionGap} />;
      case 'resolution':
        return <ResolutionCard item={item as ResolutionGap} />;
      default:
        // 六类 GapTab 全覆盖后此分支不可达；兜底同样消化呈现，不裸 JSON.stringify
        return <UnifiedEntryContent content={JSON.stringify(item)} />;
    }
  };

  return (
    <div className="h-full flex flex-col u-page-bg">
      {/* Header */}
      <div className="u-page-head">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">知识库</h1>
            <p className="page-subtitle">七大知识类型 — 统一视图 / 偏好 / 规则 / 环境 / 决策链 / 交互模式 / 解法库</p>
          </div>
          <div className="flex gap-2">
            <ManualTaskButton
              label="🧪 质量审计"
              costNote={costs != null ? `近 30 天 ${costs.callsBySource['knowledge-maintenance'] ?? 0} 次调用` : undefined}
              onRun={async () => {
                const r = await maintenanceApi.runKnowledgeMaintenance();
                return `维护完成：合并 ${r.dedupMerged} / 归档 ${r.qualityArchived} / 更新 ${r.freshnessUpdated} / 解矛盾 ${r.contradictionsResolved}`;
              }}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
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
            <div className="card p-4 mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium u-text">
                  搜索结果 ({searchResults.length})
                </span>
                <button onClick={clearSearch} className="text-xs u-text-3">清除</button>
              </div>
              {searchResults.length === 0 ? (
                <div className="empty-state text-sm">无匹配结果</div>
              ) : (
                <div className="space-y-2">
                  {searchResults.map((r, i) => {
                    // E5-5：类型徽标去 emoji，与统一视图同源——类别色文字 + 中性底，无映射归中性
                    const chartIdx = CONSUMPTION_MODE_CHART[r.type];
                    return (
                    <div key={`${r.type}-${r.id}-${i}`} className="card p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3"
                          style={chartIdx != null ? { color: `var(--chart-${chartIdx})` } : undefined}>
                          {r.type}
                        </span>
                        <span className="font-medium text-sm u-text">{r.title}</span>
                      </div>
                      <p className="text-xs u-text-3">{r.snippet}</p>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
          <>
          {/* Tab bar — E5-4：去 emoji，激活态底线收进 .u-tab/.u-tab-active */}
          <div className="flex gap-1 mb-6 overflow-x-auto pb-1 border-b u-border">
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => { setActiveTab(tab.id); setMoreEntries([]); }}
                className={`u-tab px-4 py-2 text-sm rounded-t-lg whitespace-nowrap transition ${activeTab === tab.id ? 'u-tab-active u-surface u-accent' : 'u-text-3'}`}>
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── AS-022: Unified Knowledge Tab ── */}
          {activeTab === 'unified' && (
            <div>
              <div className="flex gap-2 mb-4">
                <Select value={unifiedMode} onChange={v => { setUnifiedMode(v); setMoreEntries([]); }}
                  options={[
                    { value: '', label: '全部类型' },
                    { value: 'rule', label: '规则 (rule)' },
                    { value: 'context', label: '上下文 (context)' },
                    { value: 'signal', label: '信号 (signal)' },
                    { value: 'reference', label: '参考 (reference)' },
                  ]} />
                {/* E5-1：「待审」筛选（maturity=draft） */}
                <button onClick={() => { setReviewOnly(v => !v); setMoreEntries([]); }}
                  className={`btn btn-sm ${reviewOnly ? 'btn-primary' : 'btn-secondary'}`}>
                  待审
                </button>
                <span className="text-sm self-center u-text-3">
                  {unifiedTotal} 条
                </span>
                <button onClick={() => setShowManualEntry(!showManualEntry)} className="ml-auto btn btn-primary">
                  {showManualEntry ? '取消' : '+ 新建'}
                </button>
              </div>
              {showManualEntry && (
                <div className="card p-4 mb-4">
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <Select value={manualForm.type} onChange={v => setManualForm({ ...manualForm, type: v })}
                      options={[
                        { value: 'guideline', label: '指南' },
                        { value: 'pitfall', label: '踩坑' },
                        { value: 'architecture', label: '架构' },
                        { value: 'process', label: '流程' },
                      ]} />
                    <Select value={manualForm.consumptionMode} onChange={v => setManualForm({ ...manualForm, consumptionMode: v })}
                      options={[
                        { value: 'reference', label: '参考 (reference)' },
                        { value: 'signal', label: '信号 (signal)' },
                        { value: 'rule', label: '规则 (rule)' },
                        { value: 'context', label: '上下文 (context)' },
                      ]} />
                  </div>
                  <input type="text" placeholder="标题" value={manualForm.title} onChange={e => setManualForm({ ...manualForm, title: e.target.value })}
                    className="input w-full mb-3" />
                  <textarea placeholder="内容" value={manualForm.content} onChange={e => setManualForm({ ...manualForm, content: e.target.value })} rows={4}
                    className="input w-full mb-3" />
                  <input type="text" placeholder="标签（逗号分隔）" value={manualForm.tags} onChange={e => setManualForm({ ...manualForm, tags: e.target.value })}
                    className="input w-full mb-3" />
                  <Button onClick={handleManualEntry} disabled={!manualForm.title || !manualForm.content}
                    loading={manualSaving} loadingLabel="保存中...">
                    保存
                  </Button>
                </div>
              )}
              {unifiedLoading ? (
                <div className="text-center py-8 u-text-3">加载中...</div>
              ) : unifiedEntries.length === 0 ? (
                <div className="empty-state">{reviewOnly ? '暂无待审条目' : '暂无数据'}</div>
              ) : (
                <div className="space-y-3">
                  {unifiedEntries.map((entry, i) => {
                    // #435：类别维度不占状态色（§6.5）——chart 类别色文字 + 中性底，无映射归中性
                    const chartIdx = CONSUMPTION_MODE_CHART[entry.consumptionMode ?? ''];
                    const isDraft = entry.maturity === 'draft';
                    return (
                    <div key={entry.id || i} className="card p-4">
                      <div className="flex items-center gap-2 mb-2">
                        {/* E5-1：成熟度徽标（词表复用 ResolutionCard 状态色 MATURITY_BADGE_CLASSES） */}
                        {entry.maturity && (
                          <span className={`text-xs px-2 py-0.5 rounded ${MATURITY_BADGE_CLASSES[entry.maturity] || 'u-surface-2 u-text-3'}`}>
                            {entry.maturity}
                          </span>
                        )}
                        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3"
                          style={chartIdx != null ? { color: `var(--chart-${chartIdx})` } : undefined}>
                          {entry.consumptionMode}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">
                          {entry.source}
                        </span>
                        <span className="font-medium text-sm u-text">{entry.title}</span>
                      </div>
                      {/* draft 条目不显全文——UnifiedEntryContent 默认截断/消化摘要，审批按钮在卡底 */}
                      <UnifiedEntryContent content={entry.content} />
                      {entry.tags?.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {entry.tags.map((tag: string) => (
                            <span key={tag} className="text-xs px-1.5 py-0.5 rounded u-surface-2 u-text-3">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {isDraft && (
                        <div className="flex gap-2 mt-2">
                          <button className="btn btn-primary btn-sm" disabled={actingIds.has(entry.id)}
                            onClick={() => reviewEntry(entry.id, 'approve')}>
                            {actingIds.has(entry.id) ? '处理中…' : '通过'}
                          </button>
                          <button className="btn btn-secondary btn-sm" disabled={actingIds.has(entry.id)}
                            onClick={() => reviewEntry(entry.id, 'reject')}>
                            {actingIds.has(entry.id) ? '处理中…' : '拒绝'}
                          </button>
                        </div>
                      )}
                    </div>
                    );
                  })}
                  {/* E5-3：追加式分页页脚（对齐 E2 WU 列表口径） */}
                  <div className="text-center mt-4">
                    {unifiedTotal > unifiedEntries.length && (
                      <button onClick={handleLoadMore} disabled={moreLoading} className="btn btn-secondary">
                        {moreLoading ? '加载中...' : '加载更多'}
                      </button>
                    )}
                    <div className="text-xs mt-2 u-text-3">已加载 {unifiedEntries.length} / 共 {unifiedTotal}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Gap Type Tabs ── */}
          {activeTab !== 'unified' && (
            <div>
              {gapLoading ? (
                <div className="text-center py-8 u-text-3">加载中...</div>
              ) : gapData.length === 0 ? (
                <div className="empty-state">
                  暂无{gapLabels[activeTab as GapTab]}数据。系统会自动从 Agent 执行/交互中积累。
                </div>
              ) : (
                <div className="space-y-3">
                  {gapData.map((item, i) => (
                    <div key={item.id || i}>{renderGapItem(item)}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          </>
          )}
        </div>
      </div>
    </div>
  );
}

export default KnowledgePage;
