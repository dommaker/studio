/**
 * 知识库页面 — 累积知识浏览
 *
 * Tabs: 统一视图 | 偏好 | 规则 | 环境 | 决策链 | 交互模式 | 解法库
 * （R4: 行为模式写链路已整体删除，tab/标题残尸清理，共 7 个 tab）
 */

import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { knowledgeApi, type KnowledgeGapType, type KnowledgeSearchResult, type UnifiedEntry } from '../api/knowledge';
import { maintenanceApi } from '../api/maintenance';
import { toast } from '../utils/toast';
import { useAsyncData } from '../hooks/useAsyncData';
import { Select, ManualTaskButton, Button } from '../components/ui';
import {
  PreferenceCard, BusinessRuleCard, EnvSnapshotCard,
  DecisionChainCard, InteractionPatternCard, ResolutionCard,
} from '../components/knowledge/GapCards';
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
const gapIcons: Record<GapTab, string> = {
  preference: '👤', business_rule: '📏', environment: '🖥️',
  decision_chain: '🔗', interaction: '📊', resolution: '🔧',
};

type ActiveTab = GapTab | 'unified';

/** Gap tab 条目：六类缺口形状各异（卡片自行解读字段），仅 id 用于列表 key */
type GapItem = { id?: string } & Record<string, unknown>;

/** #350 useAsyncData 单通道按 tab 取数：unified / gap 两形态一次只拉激活 tab（对齐原 effect 分派） */
type TabPayload =
  | { kind: 'unified'; entries: UnifiedEntry[]; total: number }
  | { kind: 'gap'; items: GapItem[] };

export function KnowledgePage() {
  const navigate = useNavigate();

  // Tab state
  const [activeTab, setActiveTab] = useState<ActiveTab>('unified');

  // S11: Unified search state
  const [globalSearch, setGlobalSearch] = useState('');
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // AS-022: Unified knowledge view state（mode/offset 是用户输入，进 fetcher deps 驱动重拉）
  const [unifiedMode, setUnifiedMode] = useState('');
  const [unifiedOffset, setUnifiedOffset] = useState(0);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualForm, setManualForm] = useState({ type: 'guideline', title: '', content: '', consumptionMode: 'reference', tags: '' });
  // 工单 38: 新建条目提交中状态——Button loading 态防连点重复提交
  const [manualSaving, setManualSaving] = useState(false);

  // #350 useAsyncData 收一次性拉取样板：tab/mode/offset 变化渲染期重置重拉；
  // 手动任务成本（近 30 天 token；失败静默，不阻塞页面）
  const tabQ = useAsyncData(async (): Promise<TabPayload> => {
    if (activeTab === 'unified') {
      const res = await knowledgeApi.listUnified({
        limit: 50,
        offset: unifiedOffset,
        consumptionMode: unifiedMode || undefined,
      });
      return { kind: 'unified', entries: res.data.entries || [], total: res.data.total || 0 };
    }
    if (activeTab === 'resolution') {
      const res = await knowledgeApi.listResolutions();
      return { kind: 'gap', items: (res.data.resolutions || []) as unknown as GapItem[] };
    }
    const res = await knowledgeApi.listGaps(activeTab as KnowledgeGapType);
    return { kind: 'gap', items: (res.data.data || []) as GapItem[] };
  }, [activeTab, unifiedOffset, unifiedMode]);
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

  // S11: Unified search across all types
  const handleGlobalSearch = useCallback(async () => {
    if (!globalSearch.trim()) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const res = await knowledgeApi.search(globalSearch);
      setSearchResults(res.data.results || []);
    } catch { setSearchResults([]); }
    finally { setSearchLoading(false); }
  }, [globalSearch]);

  // 派生面（render 沿用原名）：unified / gap 形态按激活 tab 只有一侧有数据
  const unifiedLoading = tabQ.loading;
  const unifiedEntries = tabQ.data?.kind === 'unified' ? tabQ.data.entries : [];
  const unifiedTotal = tabQ.data?.kind === 'unified' ? tabQ.data.total : 0;
  const gapLoading = tabQ.loading;
  const gapData = tabQ.data?.kind === 'gap' ? tabQ.data.items : [];
  const costs = costsQ.data;

  const tabs: Array<{ id: ActiveTab; icon: string; label: string }> = [
    { id: 'unified', icon: '🔗', label: '统一视图' },
    ...(Object.entries(gapLabels) as [GapTab, string][]).map(([id, label]) => ({
      id, icon: gapIcons[id], label,
    })),
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
        return <pre className="text-xs u-text-3">{JSON.stringify(item, null, 2)}</pre>;
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
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
            <input type="text" placeholder="全局搜索知识（解法 / 行为模式 / 交互模式）..."
              value={globalSearch}
              onChange={e => setGlobalSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleGlobalSearch()}
              className="input flex-1" />
            <button onClick={handleGlobalSearch} className="btn btn-primary">
              搜索
            </button>
          </div>

          {/* Search results overlay */}
          {searchResults.length > 0 && (
            <div className="card p-4 mb-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium u-text">
                  搜索结果 ({searchResults.length})
                </span>
                <button onClick={() => { setSearchResults([]); setGlobalSearch(''); }}
                  className="text-xs u-text-3">清除</button>
              </div>
              <div className="space-y-2">
                {searchResults.map((r, i) => (
                  <div key={`${r.type}-${r.id}-${i}`} className="card p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">
                        {r.type === 'document' ? '📄' : r.type === 'resolution' ? '🔧' : r.type === 'behavior' ? '🧩' : '📊'} {r.type}
                      </span>
                      <span className="font-medium text-sm u-text">{r.title}</span>
                    </div>
                    <p className="text-xs u-text-3">{r.snippet}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
          {searchLoading && <div className="text-center py-2 text-sm u-text-3">搜索中...</div>}

          {/* Tab bar */}
          <div className="flex gap-1 mb-6 overflow-x-auto pb-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
            {tabs.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2 text-sm rounded-t-lg whitespace-nowrap transition ${activeTab === tab.id ? 'u-surface u-accent' : 'u-text-3'}`}
                style={{
                  borderBottom: activeTab === tab.id ? '2px solid var(--accent-primary)' : '2px solid transparent',
                  marginBottom: '-1px',
                }}>
                {tab.icon} {tab.label}
              </button>
            ))}
          </div>

          {/* ── AS-022: Unified Knowledge Tab ── */}
          {activeTab === 'unified' && (
            <div>
              <div className="flex gap-2 mb-4">
                <Select value={unifiedMode} onChange={v => { setUnifiedMode(v); setUnifiedOffset(0); }}
                  options={[
                    { value: '', label: '全部类型' },
                    { value: 'rule', label: '规则 (rule)' },
                    { value: 'context', label: '上下文 (context)' },
                    { value: 'signal', label: '信号 (signal)' },
                    { value: 'reference', label: '参考 (reference)' },
                  ]} />
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
                <div className="text-center py-8 u-text-3">暂无数据</div>
              ) : (
                <div className="space-y-3">
                  {unifiedEntries.map((entry, i) => (
                    <div key={entry.id || i} className="card p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`text-xs px-2 py-0.5 rounded ${
                          entry.consumptionMode === 'rule' ? 'u-err-bg' :
                            entry.consumptionMode === 'context' ? 'u-accent-bg' :
                              entry.consumptionMode === 'signal' ? 'u-warn-bg' : 'u-surface-2 u-text-3'
                        }`}>
                          {entry.consumptionMode}
                        </span>
                        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">
                          {entry.source}
                        </span>
                        <span className="font-medium text-sm u-text">{entry.title}</span>
                      </div>
                      <p className="text-xs mb-2 u-text-3">
                        {entry.content?.slice(0, 200)}{entry.content?.length > 200 ? '...' : ''}
                      </p>
                      {entry.tags?.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {entry.tags.map((tag: string) => (
                            <span key={tag} className="text-xs px-1.5 py-0.5 rounded u-surface-2 u-text-3">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {unifiedTotal > unifiedOffset + 50 && (
                    <div className="text-center mt-4">
                      <button onClick={() => setUnifiedOffset(unifiedOffset + 50)} className="btn btn-secondary">加载更多</button>
                    </div>
                  )}
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
                <div className="text-center py-8 u-text-3">
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

          <div className="mt-6">
            <button onClick={() => navigate('/library')} className="btn btn-secondary">← 前往阅览室</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default KnowledgePage;
