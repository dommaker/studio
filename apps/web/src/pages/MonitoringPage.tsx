// MonitoringPage — Agent Network MVP-6
import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { monitoringApi, type MonitoringStats, type FlywheelStats, type OverheadStats, type EvidenceStats } from '../api/monitoring';
import { knowledgeApi, type KnowledgeEntryItem } from '../api/knowledge';
import { maintenanceApi, type TriggerCosts } from '../api/maintenance';
import { ManualTaskButton } from '../components/ui';

export function MonitoringPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<MonitoringStats | null>(null);
  const [flywheel, setFlywheel] = useState<FlywheelStats | null>(null);
  const [overhead, setOverhead] = useState<OverheadStats | null>(null);
  const [evidence, setEvidence] = useState<EvidenceStats | null>(null);
  // 审核闭环：proposal 待审列表（maturity=draft，与 proposalsPendingReview 计数同库口径）
  const [proposals, setProposals] = useState<KnowledgeEntryItem[] | null>(null);
  const [approvingIds, setApprovingIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 手动任务成本（近 30 天 token；失败静默）
  const [costs, setCosts] = useState<TriggerCosts | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await monitoringApi.getStats();
      setData(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load stats');
    } finally {
      setLoading(false);
    }
    // M1/M2 区块独立加载，失败不影响主面板
    monitoringApi.getFlywheel().then(r => setFlywheel(r.data)).catch(() => setFlywheel(null));
    monitoringApi.getOverhead().then(r => setOverhead(r.data)).catch(() => setOverhead(null));
    // F6 证据台账独立加载，失败不影响主面板
    monitoringApi.getOverview().then(r => setEvidence(r.data.evidence)).catch(() => setEvidence(null));
    // 待审列表独立加载，失败不阻塞其他区块
    knowledgeApi.listPendingReview().then(r => setProposals(r.data.entries)).catch(() => setProposals(null));
    // 手动任务成本独立加载，失败静默
    maintenanceApi.getCosts().then(r => setCosts(r)).catch(() => setCosts(null));
  };

  useEffect(() => { load(); }, []);

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
            <ManualTaskButton
              label="🩺 健康巡检"
              className="btn btn-secondary"
              costTokens={costs?.byTrigger['daily-health-check']}
              onRun={async () => {
                const r = await maintenanceApi.fireTrigger('daily-health-check');
                if (r.workUnit?.id) {
                  navigate(`/workunits/${r.workUnit.id}`);
                  return '已创建巡检任务，可在 WorkUnit 列表查看';
                }
                return '已创建巡检任务';
              }}
            />
            <button className="btn btn-secondary" onClick={load}>刷新</button>
            <Link to="/" className="btn btn-secondary">返回</Link>
          </div>
        </div>
      </div>

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
            </div>
          ) : null}
        </div>
      </div>
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
