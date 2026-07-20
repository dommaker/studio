/**
 * 知识库页面 — 累积知识浏览
 *
 * Tabs: 统一视图 | 偏好 | 规则 | 环境 | 决策链 | 交互模式 | 解法库
 * （R4: 行为模式写链路已整体删除，tab/标题残尸清理，共 7 个 tab）
 */

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

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
        return <pre className="text-xs">{JSON.stringify(item, null, 2)}</pre>;
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>知识库</h1>
          <p style={{ color: 'var(--text-secondary)' }}>七大知识类型 — 统一视图 / 偏好 / 规则 / 环境 / 决策链 / 交互模式 / 解法库</p>
        </div>
        <button onClick={() => navigate('/knowledge/import')} className="btn btn-primary text-sm">📥 冷启动导入</button>
      </div>

      {/* S11: Unified search across all knowledge types */}
      <div className="mb-4 flex gap-2">
        <input type="text" placeholder="全局搜索知识（解法 / 行为模式 / 交互模式）..."
          value={globalSearch}
          onChange={e => setGlobalSearch(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleGlobalSearch()}
          className="flex-1 px-4 py-2 rounded-lg" style={{
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)',
            color: 'var(--text-primary)', outline: 'none',
          }} />
        <button onClick={handleGlobalSearch}
          className="px-4 py-2 rounded-lg text-sm" style={{ background: 'var(--accent-primary)', color: 'white' }}>
          搜索
        </button>
      </div>

      {/* Search results overlay */}
      {searchResults.length > 0 && (
        <div className="mb-4 p-4 rounded-lg" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              搜索结果 ({searchResults.length})
            </span>
            <button onClick={() => { setSearchResults([]); setGlobalSearch(''); }}
              className="text-xs" style={{ color: 'var(--text-tertiary)' }}>清除</button>
          </div>
          <div className="space-y-2">
            {searchResults.map((r, i) => (
              <div key={`${r.type}-${r.id}-${i}`} className="p-3 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>
                    {r.type === 'document' ? '📄' : r.type === 'resolution' ? '🔧' : r.type === 'behavior' ? '🧩' : '📊'} {r.type}
                  </span>
                  <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{r.title}</span>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{r.snippet}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {searchLoading && <div className="text-center py-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>搜索中...</div>}

      {/* Tab bar */}
      <div className="flex gap-1 mb-6 overflow-x-auto pb-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className="px-4 py-2 text-sm rounded-t-lg whitespace-nowrap transition"
            style={{
              background: activeTab === tab.id ? 'var(--bg-elevated)' : 'transparent',
              color: activeTab === tab.id ? 'var(--accent-primary)' : 'var(--text-tertiary)',
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
            <select value={unifiedMode} onChange={e => { setUnifiedMode(e.target.value); setUnifiedOffset(0); }}
              className="px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
              <option value="">全部类型</option>
              <option value="rule">规则 (rule)</option>
              <option value="context">上下文 (context)</option>
              <option value="signal">信号 (signal)</option>
              <option value="reference">参考 (reference)</option>
            </select>
            <span className="text-sm self-center" style={{ color: 'var(--text-tertiary)' }}>
              {unifiedTotal} 条
            </span>
            <button onClick={() => setShowManualEntry(!showManualEntry)} className="ml-auto px-3 py-2 rounded-lg text-sm" style={{ background: 'var(--accent-primary)', color: 'white' }}>
              {showManualEntry ? '取消' : '+ 新建'}
            </button>
          </div>
          {showManualEntry && (
            <div className="mb-4 p-4 rounded-lg" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <select value={manualForm.type} onChange={e => setManualForm({ ...manualForm, type: e.target.value })}
                  className="px-3 py-2 rounded text-sm" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
                  <option value="guideline">指南</option>
                  <option value="pitfall">踩坑</option>
                  <option value="architecture">架构</option>
                  <option value="process">流程</option>
                </select>
                <select value={manualForm.consumptionMode} onChange={e => setManualForm({ ...manualForm, consumptionMode: e.target.value })}
                  className="px-3 py-2 rounded text-sm" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
                  <option value="reference">参考 (reference)</option>
                  <option value="signal">信号 (signal)</option>
                  <option value="rule">规则 (rule)</option>
                  <option value="context">上下文 (context)</option>
                </select>
              </div>
              <input type="text" placeholder="标题" value={manualForm.title} onChange={e => setManualForm({ ...manualForm, title: e.target.value })}
                className="w-full px-3 py-2 rounded text-sm mb-3" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }} />
              <textarea placeholder="内容" value={manualForm.content} onChange={e => setManualForm({ ...manualForm, content: e.target.value })} rows={4}
                className="w-full px-3 py-2 rounded text-sm mb-3" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }} />
              <input type="text" placeholder="标签（逗号分隔）" value={manualForm.tags} onChange={e => setManualForm({ ...manualForm, tags: e.target.value })}
                className="w-full px-3 py-2 rounded text-sm mb-3" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }} />
              <button onClick={handleManualEntry} disabled={!manualForm.title || !manualForm.content}
                className="px-4 py-2 rounded text-sm disabled:opacity-50" style={{ background: 'var(--accent-primary)', color: 'white' }}>
                保存
              </button>
            </div>
          )}
          {unifiedLoading ? (
            <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>加载中...</div>
          ) : unifiedEntries.length === 0 ? (
            <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>暂无数据</div>
          ) : (
            <div className="space-y-3">
              {unifiedEntries.map((entry, i) => (
                <div key={entry.id || i} className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs px-2 py-0.5 rounded" style={{
                      background: entry.consumptionMode === 'rule' ? 'var(--accent-danger)' :
                        entry.consumptionMode === 'context' ? 'var(--accent-primary)' :
                          entry.consumptionMode === 'signal' ? 'var(--accent-warning)' : 'var(--bg-elevated)',
                      color: 'white',
                    }}>
                      {entry.consumptionMode}
                    </span>
                    <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>
                      {entry.source}
                    </span>
                    <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>{entry.title}</span>
                  </div>
                  <p className="text-xs mb-2" style={{ color: 'var(--text-tertiary)' }}>
                    {entry.content?.slice(0, 200)}{entry.content?.length > 200 ? '...' : ''}
                  </p>
                  {entry.tags?.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {entry.tags.map((tag: string) => (
                        <span key={tag} className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {unifiedTotal > unifiedOffset + 50 && (
                <div className="text-center mt-4">
                  <button onClick={() => setUnifiedOffset(unifiedOffset + 50)} className="px-4 py-2 rounded text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>加载更多</button>
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
            <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>加载中...</div>
          ) : gapData.length === 0 ? (
            <div className="text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
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
        <button onClick={() => navigate('/wiki')} className="px-4 py-2 rounded text-sm" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>← 前往文档</button>
      </div>
    </div>
  );
}

// ── Gap type card components ──

function PreferenceCard({ item }: { item: any }) {
  return (
    <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span>👤</span>
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>用户偏好</span>
        {item.responseStyle && <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--accent-primary)', color: 'white' }}>{item.responseStyle}</span>}
        {item.preferredModel && <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>{item.preferredModel}</span>}
        <span className="text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>置信度: {Math.round((item.confidence || 0) * 100)}%</span>
      </div>
      <div className="grid grid-cols-3 gap-3 text-sm">
        {item.activeHours?.length > 0 && <div><span style={{ color: 'var(--text-tertiary)' }}>活跃时段: </span><span style={{ color: 'var(--text-primary)' }}>{(item.activeHours || []).join(', ')}点</span></div>}
        {item.avgMessageLength && <div><span style={{ color: 'var(--text-tertiary)' }}>平均消息长度: </span><span style={{ color: 'var(--text-primary)' }}>{item.avgMessageLength} 字符</span></div>}
        {item.autoApproveThreshold !== undefined && <div><span style={{ color: 'var(--text-tertiary)' }}>自动审批阈值: </span><span style={{ color: 'var(--text-primary)' }}>{Math.round(item.autoApproveThreshold * 100)}%</span></div>}
      </div>
    </div>
  );
}

function BusinessRuleCard({ item }: { item: any }) {
  return (
    <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span>📏</span>
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{item.name}</span>
        <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>{item.category}</span>
        <span className="text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>v{item.version}</span>
      </div>
      <p className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}>{item.description}</p>
      <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
        {item.condition} → {item.action}
        {item.defaultValue && ` (默认: ${item.defaultValue})`}
        {' · '}{item.source}
      </p>
    </div>
  );
}

function EnvSnapshotCard({ item }: { item: any }) {
  return (
    <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span>🖥️</span>
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>环境快照</span>
        <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>{item.nodeEnv}</span>
      </div>
      <div className="grid grid-cols-4 gap-2 text-sm">
        <div><span style={{ color: 'var(--text-tertiary)' }}>主机: </span><span style={{ color: 'var(--text-primary)' }}>{item.hostname}</span></div>
        <div><span style={{ color: 'var(--text-tertiary)' }}>平台: </span><span style={{ color: 'var(--text-primary)' }}>{item.platform}</span></div>
        <div><span style={{ color: 'var(--text-tertiary)' }}>Node: </span><span style={{ color: 'var(--text-primary)' }}>{item.nodeVersion}</span></div>
        <div><span style={{ color: 'var(--text-tertiary)' }}>端口: </span><span style={{ color: 'var(--text-primary)' }}>{item.apiPort}</span></div>
      </div>
      {(item.knownLimitations || []).length > 0 && (
        <div className="mt-2 text-xs" style={{ color: 'var(--warning)' }}>
          ⚠️ 已知限制: {(item.knownLimitations || []).map((l: any) => l.issue).join('; ')}
        </div>
      )}
      {item.diffFromPrev && <div className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>变更: {item.diffFromPrev}</div>}
    </div>
  );
}

function DecisionChainCard({ item }: { item: any }) {
  const options = typeof item.options === 'string' ? JSON.parse(item.options) : (item.options || []);
  return (
    <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span>🔗</span>
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{item.topic}</span>
        <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>{item.category}</span>
        <span className="text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>{item.sourceType}</span>
      </div>
      <p className="text-sm mb-1" style={{ color: 'var(--text-secondary)' }}>{item.context}</p>
      <div className="text-sm">
        <span style={{ color: 'var(--text-tertiary)' }}>选择: </span>
        <span className="font-medium" style={{ color: 'var(--accent-primary)' }}>{item.chosen}</span>
        {options.length > 0 && <span style={{ color: 'var(--text-tertiary)' }}> (共 {options.length} 个方案)</span>}
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{item.rationale}</p>
      {item.tradeoffs && <p className="text-xs" style={{ color: 'var(--warning)' }}>权衡: {item.tradeoffs}</p>}
    </div>
  );
}

function InteractionPatternCard({ item }: { item: any }) {
  return (
    <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span>📊</span>
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{item.name}</span>
        <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>{item.category}</span>
        <span className="text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>
          频次: {item.frequency}/天 · 置信度: {Math.round((item.confidence || 0) * 100)}%
        </span>
      </div>
      <p className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}>{item.description}</p>
      {item.insight && <p className="text-sm" style={{ color: 'var(--accent-primary)' }}>💡 {item.insight}</p>}
      {item.suggestion && <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>建议: {item.suggestion}</p>}
    </div>
  );
}

function ResolutionCard({ item }: { item: any }) {
  const statusColors: Record<string, string> = {
    pending: 'var(--warning)',
    verified: 'var(--accent-primary)',
    canonical: 'var(--success, #22c55e)',
    deprecated: 'var(--text-tertiary)',
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
    <div className="p-4 rounded-lg" style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span>🔧</span>
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{item.title}</span>
        <span className="text-xs px-2 py-0.5 rounded" style={{
          background: statusColors[item.status] || 'var(--text-tertiary)',
          color: 'white',
        }}>{item.status}</span>
        <span className="text-xs px-2 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>
          {layerLabels[item.layer] || item.layer}
        </span>
        <span className="text-xs ml-auto" style={{ color: 'var(--text-tertiary)' }}>
          验证: {item.verifyCount}x
        </span>
      </div>
      <p className="text-xs mb-1" style={{ color: 'var(--text-tertiary)' }}>
        模式: <code className="px-1 rounded" style={{ background: 'var(--bg-elevated)' }}>{item.pattern}</code>
      </p>
      <p className="text-sm mb-2" style={{ color: 'var(--text-primary)' }}>{item.fix}</p>
      {tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {tags.map((t: string) => (
            <span key={t} className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)' }}>{t}</span>
          ))}
        </div>
      )}
      {item.errorClass && (
        <div className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
          错误类型: {item.errorClass}
          {item.sourceGoalId && ` · 来源: ${item.sourceGoalId.slice(0, 8)}`}
        </div>
      )}
    </div>
  );
}

export default KnowledgePage;
