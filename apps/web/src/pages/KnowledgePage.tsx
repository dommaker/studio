/**
 * 知识库页面 — 累积知识浏览
 *
 * Tabs: 统一视图 | 偏好 | 规则 | 环境 | 决策链 | 交互模式 | 解法库
 * （R4: 行为模式写链路已整体删除，tab/标题残尸清理，共 7 个 tab）
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { maintenanceApi, type TriggerCosts } from '../api/maintenance';
import { Select, ManualTaskButton } from '../components/ui';

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

export function KnowledgePage() {
  const navigate = useNavigate();

  // Tab state
  const [activeTab, setActiveTab] = useState<ActiveTab>('unified');
  const [gapData, setGapData] = useState<any[]>([]);
  const [gapLoading, setGapLoading] = useState(false);

  // S11: Unified search state
  const [globalSearch, setGlobalSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // AS-022: Unified knowledge view state
  const [unifiedEntries, setUnifiedEntries] = useState<any[]>([]);
  const [unifiedTotal, setUnifiedTotal] = useState(0);
  const [unifiedLoading, setUnifiedLoading] = useState(false);
  const [unifiedMode, setUnifiedMode] = useState('');
  const [unifiedOffset, setUnifiedOffset] = useState(0);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualForm, setManualForm] = useState({ type: 'guideline', title: '', content: '', consumptionMode: 'reference', tags: '' });

  // 手动任务成本（近 30 天 token；失败静默，不阻塞页面）
  const [costs, setCosts] = useState<TriggerCosts | null>(null);
  useEffect(() => {
    maintenanceApi.getCosts().then(setCosts).catch(() => setCosts(null));
  }, []);

  const loadGapData = useCallback(async (type: string) => {
    setGapLoading(true);
    try {
      if (type === 'resolution') {
        const res = await api.get('/knowledge/resolutions');
        setGapData(res.data.resolutions || []);
      } else {
        const res = await api.get(`/knowledge/gaps/${type}`);
        setGapData(res.data.data || []);
      }
    } catch { setGapData([]); }
    finally { setGapLoading(false); }
  }, []);

  // AS-022: Load unified knowledge entries
  const loadUnified = useCallback(async () => {
    setUnifiedLoading(true);
    try {
      const params = new URLSearchParams({ limit: '50', offset: String(unifiedOffset) });
      if (unifiedMode) params.set('consumptionMode', unifiedMode);
      const res = await api.get(`/knowledge/unified?${params}`);
      setUnifiedEntries(res.data.entries || []);
      setUnifiedTotal(res.data.total || 0);
    } catch { setUnifiedEntries([]); }
    finally { setUnifiedLoading(false); }
  }, [unifiedMode, unifiedOffset]);

  useEffect(() => {
    if (activeTab === 'unified') loadUnified();
    else loadGapData(activeTab);
  }, [activeTab, loadGapData, loadUnified]);

  // AS-022: Submit manual entry
  const handleManualEntry = async () => {
    try {
      await api.post('/knowledge/unified', {
        ...manualForm,
        tags: manualForm.tags ? manualForm.tags.split(',').map(t => t.trim()) : [],
      });
      setShowManualEntry(false);
      setManualForm({ type: 'guideline', title: '', content: '', consumptionMode: 'reference', tags: '' });
      loadUnified();
    } catch (err) { console.error('Failed to create entry:', err); }
  };

  // S11: Unified search across all types
  const handleGlobalSearch = useCallback(async () => {
    if (!globalSearch.trim()) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const res = await api.get(`/knowledge/search?q=${encodeURIComponent(globalSearch)}`);
      setSearchResults(res.data.results || []);
    } catch { setSearchResults([]); }
    finally { setSearchLoading(false); }
  }, [globalSearch]);

  const tabs: Array<{ id: ActiveTab; icon: string; label: string }> = [
    { id: 'unified', icon: '🔗', label: '统一视图' },
    ...(Object.entries(gapLabels) as [GapTab, string][]).map(([id, label]) => ({
      id, icon: gapIcons[id], label,
    })),
  ];

  // ── Gap type detail rendering ──
  const renderGapItem = (item: any) => {
    switch (activeTab as GapTab) {
      case 'preference':
        return <PreferenceCard item={item} />;
      case 'business_rule':
        return <BusinessRuleCard item={item} />;
      case 'environment':
        return <EnvSnapshotCard item={item} />;
      case 'decision_chain':
        return <DecisionChainCard item={item} />;
      case 'interaction':
        return <InteractionPatternCard item={item} />;
      case 'resolution':
        return <ResolutionCard item={item} />;
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
            <ManualTaskButton
              label="🧩 知识综合"
              costTokens={costs?.byTrigger['knowledge-synthesis']}
              onRun={async () => {
                const r = await maintenanceApi.fireTrigger('knowledge-synthesis');
                return r.workUnit
                  ? `已创建综合任务（WU ${r.workUnit.id.slice(0, 8)}…）`
                  : '已触发知识综合';
              }}
            />
            <ManualTaskButton
              label="📥 会话提取"
              costTokens={costs?.byTrigger['session-knowledge-extraction']}
              onRun={async () => {
                const r = await maintenanceApi.fireTrigger('session-knowledge-extraction');
                return r.workUnit
                  ? `已创建提取任务（WU ${r.workUnit.id.slice(0, 8)}…）`
                  : '已触发会话提取';
              }}
            />
            <button onClick={() => navigate('/knowledge/import')} className="btn btn-primary">📥 冷启动导入</button>
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
                  <button onClick={handleManualEntry} disabled={!manualForm.title || !manualForm.content}
                    className="btn btn-primary">
                    保存
                  </button>
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
            <button onClick={() => navigate('/wiki')} className="btn btn-secondary">← 前往文档</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Gap type card components ──

function PreferenceCard({ item }: { item: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>👤</span>
        <span className="font-medium u-text">用户偏好</span>
        {item.responseStyle && <span className="text-xs px-2 py-0.5 rounded u-accent-bg">{item.responseStyle}</span>}
        {item.preferredModel && <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.preferredModel}</span>}
        <span className="text-xs ml-auto u-text-3">置信度: {Math.round((item.confidence || 0) * 100)}%</span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        {item.activeHours?.length > 0 && <div><span className="u-text-3">活跃时段: </span><span className="u-text">{(item.activeHours || []).join(', ')}点</span></div>}
        {item.avgMessageLength && <div><span className="u-text-3">平均消息长度: </span><span className="u-text">{item.avgMessageLength} 字符</span></div>}
        {item.autoApproveThreshold !== undefined && <div><span className="u-text-3">自动审批阈值: </span><span className="u-text">{Math.round(item.autoApproveThreshold * 100)}%</span></div>}
      </div>
    </div>
  );
}

function BusinessRuleCard({ item }: { item: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>📏</span>
        <span className="font-medium u-text">{item.name}</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.category}</span>
        <span className="text-xs ml-auto u-text-3">v{item.version}</span>
      </div>
      <p className="text-sm mb-1 u-text">{item.description}</p>
      <p className="text-xs u-text-3">
        {item.condition} → {item.action}
        {item.defaultValue && ` (默认: ${item.defaultValue})`}
        {' · '}{item.source}
      </p>
    </div>
  );
}

function EnvSnapshotCard({ item }: { item: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>🖥️</span>
        <span className="font-medium u-text">环境快照</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.nodeEnv}</span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-sm">
        <div><span className="u-text-3">主机: </span><span className="u-text">{item.hostname}</span></div>
        <div><span className="u-text-3">平台: </span><span className="u-text">{item.platform}</span></div>
        <div><span className="u-text-3">Node: </span><span className="u-text">{item.nodeVersion}</span></div>
        <div><span className="u-text-3">端口: </span><span className="u-text">{item.apiPort}</span></div>
      </div>
      {(item.knownLimitations || []).length > 0 && (
        <div className="mt-2 text-xs u-warn">
          ⚠️ 已知限制: {(item.knownLimitations || []).map((l: any) => l.issue).join('; ')}
        </div>
      )}
      {item.diffFromPrev && <div className="mt-1 text-xs u-text-2">变更: {item.diffFromPrev}</div>}
    </div>
  );
}

function DecisionChainCard({ item }: { item: any }) {
  const options = typeof item.options === 'string' ? JSON.parse(item.options) : (item.options || []);
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>🔗</span>
        <span className="font-medium u-text">{item.topic}</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.category}</span>
        <span className="text-xs ml-auto u-text-3">{item.sourceType}</span>
      </div>
      <p className="text-sm mb-1 u-text-2">{item.context}</p>
      <div className="text-sm">
        <span className="u-text-3">选择: </span>
        <span className="font-medium u-accent">{item.chosen}</span>
        {options.length > 0 && <span className="u-text-3"> (共 {options.length} 个方案)</span>}
      </div>
      <p className="text-xs mt-1 u-text-3">{item.rationale}</p>
      {item.tradeoffs && <p className="text-xs u-warn">权衡: {item.tradeoffs}</p>}
    </div>
  );
}

function InteractionPatternCard({ item }: { item: any }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>📊</span>
        <span className="font-medium u-text">{item.name}</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">{item.category}</span>
        <span className="text-xs ml-auto u-text-3">
          频次: {item.frequency}/天 · 置信度: {Math.round((item.confidence || 0) * 100)}%
        </span>
      </div>
      <p className="text-sm mb-1 u-text">{item.description}</p>
      {item.insight && <p className="text-sm u-accent">💡 {item.insight}</p>}
      {item.suggestion && <p className="text-xs u-text-2">建议: {item.suggestion}</p>}
    </div>
  );
}

function ResolutionCard({ item }: { item: any }) {
  const statusClasses: Record<string, string> = {
    pending: 'u-warn-bg',
    verified: 'u-accent-bg',
    canonical: 'u-ok-bg',
    deprecated: 'u-surface-2 u-text-3',
  };
  const layerLabels: Record<string, string> = {
    L3_tool_behavior: 'L3 工具行为',
    L4_env_config: 'L4 环境配置',
    L5_error_fix: 'L5 错误解法',
    L6_causality: 'L6 因果关系',
  };

  let tags: string[] = [];
  try { tags = typeof item.tags === 'string' ? JSON.parse(item.tags) : (item.tags || []); } catch { /* ignore */ }

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-2">
        <span>🔧</span>
        <span className="font-medium u-text">{item.title}</span>
        <span className={`text-xs px-2 py-0.5 rounded ${statusClasses[item.status] || 'u-surface-2 u-text-3'}`}>{item.status}</span>
        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">
          {layerLabels[item.layer] || item.layer}
        </span>
        <span className="text-xs ml-auto u-text-3">
          验证: {item.verifyCount}x
        </span>
      </div>
      <p className="text-xs mb-1 u-text-3">
        模式: <code className="px-1 rounded u-surface-2">{item.pattern}</code>
      </p>
      <p className="text-sm mb-2 u-text">{item.fix}</p>
      {tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {tags.map((t: string) => (
            <span key={t} className="text-xs px-1.5 py-0.5 rounded u-surface-2 u-text-3">{t}</span>
          ))}
        </div>
      )}
      {item.errorClass && (
        <div className="text-xs mt-1 u-text-3">
          错误类型: {item.errorClass}
          {item.sourceGoalId && ` · 来源: ${item.sourceGoalId.slice(0, 8)}`}
        </div>
      )}
    </div>
  );
}

export default KnowledgePage;
