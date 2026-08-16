// MonitoringPage — Agent Network MVP-6；#180 Tab 化「概览 / 事件检索」（#60 决策 Q3a）
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { monitoringApi, type MonitoringStats, type FlywheelStats, type OverheadStats, type EvidenceStats, type EfficiencyStats } from '../api/monitoring';
import { knowledgeApi, type KnowledgeEntryItem } from '../api/knowledge';
import { EventSearchPanel } from '../components/monitoring/EventSearchPanel';

type MonitoringTab = 'overview' | 'events';

export function MonitoringPage() {
  const [activeTab, setActiveTab] = useState<MonitoringTab>('overview');
  const [data, setData] = useState<MonitoringStats | null>(null);
  const [flywheel, setFlywheel] = useState<FlywheelStats | null>(null);
  const [overhead, setOverhead] = useState<OverheadStats | null>(null);
  const [evidence, setEvidence] = useState<EvidenceStats | null>(null);
  const [efficiency, setEfficiency] = useState<EfficiencyStats | null>(null);
  // 审核闭环：proposal 待审列表（maturity=draft，与 proposalsPendingReview 计数同库口径）
  const [proposals, setProposals] = useState<KnowledgeEntryItem[] | null>(null);
  const [approvingIds, setApprovingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    // promise 链写法：setState 全部在回调里，符合 set-state-in-effect 规则的外部同步口径
    monitoringApi.getStats()
      .then((res) => {
        setData(res.data);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load stats');
      })
      .finally(() => {
        setLoading(false);
      });
    // M1/M2 区块独立加载，失败不影响主面板
    monitoringApi.getFlywheel().then(r => setFlywheel(r.data)).catch(() => setFlywheel(null));
    monitoringApi.getOverhead().then(r => setOverhead(r.data)).catch(() => setOverhead(null));
    // F6 证据台账独立加载，失败不影响主面板
    monitoringApi.getOverview().then(r => setEvidence(r.data.evidence)).catch(() => setEvidence(null));
    // #120 输入缓存命中率 + 段 trim 率独立加载，失败不影响主面板
    monitoringApi.getEfficiency().then(r => setEfficiency(r.data)).catch(() => setEfficiency(null));
    // 待审列表独立加载，失败不阻塞其他区块
    knowledgeApi.listPendingReview().then(r => setProposals(r.data.entries)).catch(() => setProposals(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  // 一键 approve：draft → verified（参与注入）；成功后移出列表
  const approveProposal = async (entryId: string) => {
    setApprovingIds(prev => new Set(prev).add(entryId));
    try {
      await knowledgeApi.promote(entryId);
      setProposals(prev => prev ? prev.filter(p => p.id !== entryId) : prev);
      monitoringApi.getFlywheel().then(r => setFlywheel(r.data)).catch(() => {});
    } catch { /* 保留在列表中，可重试 */ } finally {
      setApprovingIds(prev => {
        const next = new Set(prev);
        next.delete(entryId);
        return next;
      });
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">监控</h1>
            <p className="page-subtitle">Agent Network 运营度量</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={load}>刷新</button>
            <Link to="/" className="btn btn-secondary">返回</Link>
          </div>
        </div>
      </div>

      {/* #180：概览 / 事件检索 Tab（IA：行动信号 > 健康度量 > 参考资料） */}
      <div className="px-8 pt-3 flex gap-1" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        {([['overview', '概览'], ['events', '事件检索']] as Array<[MonitoringTab, string]>).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`px-4 py-2 text-sm rounded-t-lg transition ${activeTab === id ? 'u-surface u-accent' : 'u-text-3'}`}
            style={{ borderBottom: activeTab === id ? '2px solid var(--accent-primary)' : '2px solid transparent' }}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'events' ? (
        <div className="flex-1 overflow-auto px-8 pb-8">
          <div className="max-w-5xl">
            <EventSearchPanel />
          </div>
        </div>
      ) : (
      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {error && (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
          )}

          {loading && !data ? (
            <div className="text-center py-20 u-text-2">加载中...</div>
          ) : data ? (
            <div className="space-y-6 mt-4">
              {/* WorkUnit 状态分布 */}
              <Section title="WorkUnit 状态分布">
                <div className="grid grid-cols-4 gap-3">
                  <StatCard label="总数" value={data.workunits.total} color="u-accent" />
                  <StatCard label="待分配" value={data.workunits.unassigned} color="u-text-3" />
                  <StatCard label="执行中" value={data.workunits.active} color="u-accent" />
                  <StatCard label="审查中" value={data.workunits.in_review} color="u-warn" />
                  <StatCard label="已完成" value={data.workunits.done} color="u-ok" />
                  <StatCard label="阻塞" value={data.workunits.blocked} color="u-err" />
                  <StatCard label="已关闭" value={data.workunits.closed} color="u-ok" />
                </div>
              </Section>

              {/* Agent 状态 */}
              <Section title="Agent 状态">
                <div className="grid grid-cols-4 gap-3">
                  <StatCard label="总数" value={data.agents.total} color="u-accent" />
                  <StatCard label="空闲" value={data.agents.idle} color="u-text-3" />
                  <StatCard label="执行中" value={data.agents.active} color="u-accent" />
                  <StatCard label="已终止" value={data.agents.terminated} color="u-err" />
                </div>
                {/* Agent 利用率 */}
                <div className="mt-3">
                  <span className="text-sm u-text-3">利用率: </span>
                  <span className="text-sm font-bold u-accent">
                    {data.agents.total > 0
                      ? `${Math.round((data.agents.active / data.agents.total) * 100)}%`
                      : 'N/A'}
                  </span>
                  <span className="text-xs u-text-2 ml-2">
                    ({data.agents.active} / {data.agents.total})
                  </span>
                </div>
              </Section>

              {/* 最近 24h */}
              <Section title="最近 24 小时">
                <div className="grid grid-cols-2 gap-3">
                  <StatCard label="完成" value={data.recent.completedLast24h} color="u-ok" />
                  <StatCard label="失败/阻塞" value={data.recent.failedLast24h} color="u-err" />
                </div>
              </Section>

              {/* F6 证据台账（决策 1）：信任分层达成 + 双轨比对 */}
              {evidence && (
                <Section title="证据台账（信任分层）">
                  <div className="grid grid-cols-4 gap-3">
                    <StatCard label="L1 自动验证" value={evidence.l1Approved} color="u-ok" />
                    <StatCard label="L2 agent 评审" value={evidence.l2Approved} color="u-ok" />
                    <StatCard label="L3 人工确认" value={evidence.l3Approved} color="u-ok" />
                    <StatCard label="自评（L2）" value={evidence.selfReviewCount} color="u-warn" />
                    <StatCard label="待人工确认" value={evidence.needsHuman} color="u-err" />
                    <StatCard label="双轨偏差" value={evidence.derivedMismatch} color="u-warn" />
                    <StatCard label="已介入 WU" value={evidence.engaged} color="u-accent" />
                  </div>
                  <p className="text-xs u-text-3 mt-2">
                    双轨偏差 = 派生列与存储状态不一致的 WU 数（验证期指标，持续为 0 才可停止手写 in_review）
                  </p>
                </Section>
              )}

              {/* M1: 飞轮指标 */}
              <Section title="飞轮指标">
                {flywheel ? (
                  <>
                    <div className="grid grid-cols-4 gap-3">
                      <StatCard label="知识命中率" value={`${flywheel.hitRate}%`} color="u-accent" />
                      <StatCard
                        label="成功率变化"
                        value={`${flywheel.improvement > 0 ? '+' : ''}${flywheel.improvement}pp`}
                        color={flywheel.improvement > 0 ? 'u-ok' : flywheel.improvement < 0 ? 'u-err' : 'u-text-3'}
                      />
                      <StatCard label="质量分" value={flywheel.quality} color="u-accent" />
                      <StatCard label="新鲜度" value={`${flywheel.freshness}%`} color="u-ok" />
                      <StatCard
                        label="proposal 待审"
                        value={flywheel.proposalsPendingReview}
                        color={flywheel.proposalsPendingReview > 0 ? 'u-warn' : 'u-text-3'}
                      />
                      <StatCard label={`提取次数 (${flywheel.windowDays}d)`} value={flywheel.extraction.count30d} color="u-accent" />
                      <StatCard label={`提取 tokens (${flywheel.windowDays}d)`} value={flywheel.extraction.totalTokens30d} color="u-accent" />
                    </div>
                    {flywheel.source === 'insufficient-data' && (
                      <div className="mt-2 text-xs u-text-2">事件数据不足：hitRate / 成功率变化为 0 占位而非实测</div>
                    )}
                  </>
                ) : (
                  <div className="text-sm u-text-2">飞轮指标不可用</div>
                )}
              </Section>

              {/* 审核闭环：proposal 待审列表（计数升级为列表：标题/年龄/一键 approve） */}
              <Section title="知识提案待审">
                {proposals === null ? (
                  <div className="text-sm u-text-2">待审列表不可用</div>
                ) : proposals.length === 0 ? (
                  <div className="text-sm u-text-2">无待审提案（提取产物以 draft 入库，审核通过后才参与注入）</div>
                ) : (
                  <div className="space-y-2">
                    {proposals.map(p => (
                      <div key={p.id} className="flex items-center gap-3 text-sm">
                        <span className="u-text" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.title}
                        </span>
                        <span className="text-xs u-text-3">{formatAge(p.created)}</span>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '2px 10px', fontSize: 12 }}
                          disabled={approvingIds.has(p.id)}
                          onClick={() => approveProposal(p.id)}
                        >
                          {approvingIds.has(p.id) ? '处理中…' : '通过'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              {/* M2: 封装开销 */}
              <Section title="封装开销">
                {overhead && overhead.source === 'events' ? (
                  <>
                    <div className="grid grid-cols-4 gap-3">
                      <StatCard
                        label={`平均注入 tokens (红线 ${overhead.injectedBudget})`}
                        value={overhead.avgInjectedTokens}
                        color={budgetColor(overhead.injectedBudgetUsedPct)}
                      />
                      <StatCard
                        label="注入预算占用"
                        value={`${overhead.injectedBudgetUsedPct}%`}
                        color={budgetColor(overhead.injectedBudgetUsedPct)}
                      />
                      <StatCard
                        label={`封装开销比 (红线 ${Math.round(overhead.overheadBudget * 100)}%)`}
                        value={overhead.avgOverheadRatio !== null ? `${Math.round(overhead.avgOverheadRatio * 1000) / 10}%` : 'N/A'}
                        color={overhead.avgOverheadRatio !== null
                          ? budgetColor((overhead.avgOverheadRatio / overhead.overheadBudget) * 100)
                          : 'u-text-3'}
                      />
                      <StatCard
                        label="平均执行 tokens"
                        value={overhead.avgExecutionTokens ?? 'N/A'}
                        color="u-accent"
                      />
                      <StatCard label={`提取 tokens (${overhead.windowDays}d)`} value={overhead.extractionTokens} color="u-accent" />
                      <StatCard label="统计执行数" value={overhead.executions} color="u-text-3" />
                    </div>
                    <div className="mt-2 text-xs u-text-2">
                      开销比 = 注入估算 / 执行 tokens（仅统计 CLI 回报 usage 的执行，覆盖率 {overhead.executionCoveragePct}%）；提取开销单独核算，不计入注入红线
                    </div>
                  </>
                ) : (
                  <div className="text-sm u-text-2">暂无 workunit:tokens 事件，开销数据不足</div>
                )}
              </Section>

              {/* #120: 输入缓存命中率（步/WU/角色/天；趋势面，现序即基线） */}
              {efficiency && (
                <Section title="输入缓存命中率">
                  {efficiency.cacheHitRate.source === 'events' ? (
                    <>
                      <div className="grid grid-cols-4 gap-3">
                        <StatCard
                          label="命中率"
                          value={efficiency.cacheHitRate.overall.hitRatePct !== null
                            ? `${efficiency.cacheHitRate.overall.hitRatePct}%`
                            : 'N/A'}
                          color="u-accent"
                        />
                        <StatCard label="缓存读取 tokens" value={efficiency.cacheHitRate.overall.cacheReadTokens} color="u-accent" />
                        <StatCard label="输入 tokens" value={efficiency.cacheHitRate.overall.inputTokens} color="u-accent" />
                        <StatCard label="覆盖事件" value={efficiency.cacheHitRate.overall.events} color="u-text-3" />
                        <StatCard label="WU 数" value={efficiency.cacheHitRate.overall.workUnits} color="u-text-3" />
                        <StatCard label="覆盖率" value={`${efficiency.cacheHitRate.coveragePct}%`} color="u-text-3" />
                      </div>
                      {efficiency.cacheHitRate.byDay.length > 0 && (
                        <div className="mt-3">
                          <div className="text-sm u-text-3 mb-1">按天趋势</div>
                          <div className="flex flex-wrap gap-2">
                            {efficiency.cacheHitRate.byDay.map(d => (
                              <div key={d.day} className="px-2 py-1 rounded" style={{ border: '1px solid var(--border-subtle)' }}>
                                <span className="text-xs u-text-3">{d.day.slice(5)}</span>{' '}
                                <span className="text-sm font-bold u-accent">{d.hitRatePct !== null ? `${d.hitRatePct}%` : 'N/A'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {efficiency.cacheHitRate.byRole.length > 0 && (
                        <div className="mt-3">
                          <div className="text-sm u-text-3 mb-1">按角色</div>
                          <div className="space-y-1">
                            {efficiency.cacheHitRate.byRole.map(r => (
                              <div key={r.profileId} className="flex items-center justify-between text-sm">
                                <span className="u-text">{r.profileName}</span>
                                <span className="font-bold u-accent">{r.hitRatePct !== null ? `${r.hitRatePct}%` : 'N/A'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {efficiency.cacheHitRate.byWorkUnit.length > 0 && (
                        <div className="mt-3">
                          <div className="text-sm u-text-3 mb-1">按 WU（事件数降序，top 5）</div>
                          <div className="space-y-1">
                            {efficiency.cacheHitRate.byWorkUnit.slice(0, 5).map(w => (
                              <div key={w.workUnitId} className="flex items-center justify-between text-sm">
                                <span className="u-text" style={{ maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.workUnitId}</span>
                                <span className="font-bold u-accent">{w.hitRatePct !== null ? `${w.hitRatePct}%` : 'N/A'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {efficiency.cacheHitRate.coveragePct < 100 && (
                        <div className="mt-2 text-xs u-text-2">覆盖率 &lt;100%：部分执行无 CLI usage 回报，命中率口径不含这些事件</div>
                      )}
                    </>
                  ) : (
                    <div className="text-sm u-text-2">暂无带缓存字段的 workunit:tokens 事件，命中率数据不足</div>
                  )}
                </Section>
              )}

              {/* #120: 段 trim 率（按段计数） */}
              {efficiency && (
                <Section title="段 trim 率">
                  {efficiency.sectionTrim.source === 'events' ? (
                    <>
                      <div className="grid grid-cols-4 gap-3">
                        <StatCard label="trim 事件总数" value={efficiency.sectionTrim.totals.trimEvents} color="u-accent" />
                        <StatCard label="原始 tokens" value={efficiency.sectionTrim.totals.totalOriginalTokens} color="u-text-3" />
                        <StatCard label="裁剪后 tokens" value={efficiency.sectionTrim.totals.totalTrimmedTokens} color="u-text-3" />
                      </div>
                      <div className="mt-3">
                        <div className="text-sm u-text-3 mb-1">按段计数</div>
                        <div className="space-y-1">
                          {efficiency.sectionTrim.bySection.map(s => (
                            <div key={s.section} className="flex items-center justify-between text-sm">
                              <span className="u-text">{s.section}</span>
                              <span className="text-xs u-text-3">trim {s.trimCount} 次 · 平均裁 {s.avgTrimPct}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="text-sm u-text-2">暂无 prompt:section_trimmed 事件，trim 数据不足</div>
                  )}
                </Section>
              )}
            </div>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

/** 阈值着色：绿 = 预算内，黄 = 接近红线（≥70%），红 = 越线（>100%） */
function budgetColor(usedPct: number): string {
  if (usedPct > 100) return 'u-err';
  if (usedPct >= 70) return 'u-warn';
  return 'u-ok';
}

/** 待审提案年龄：created → 「N 分钟/小时/天前」 */
function formatAge(iso?: string): string {
  if (!iso) return '时间未知';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-4">
      <h2 className="mc-block-label" style={{ margin: '0 0 10px' }}>{title}</h2>
      {children}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: React.ReactNode; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`font-bold ${color}`} style={{ fontSize: 'var(--fs-title)' }}>{value}</span>
      <span className="text-sm u-text-2">{label}</span>
    </div>
  );
}
