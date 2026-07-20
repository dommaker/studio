// MonitoringPage — Agent Network MVP-6
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { monitoringApi, type MonitoringStats, type FlywheelStats, type OverheadStats } from '../api/monitoring';

export function MonitoringPage() {
  const [data, setData] = useState<MonitoringStats | null>(null);
  const [flywheel, setFlywheel] = useState<FlywheelStats | null>(null);
  const [overhead, setOverhead] = useState<OverheadStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  };

  useEffect(() => { load(); }, []);

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <h2 className="text-sm font-medium u-text-3 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: React.ReactNode; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-sm u-text-3">{label}</span>
    </div>
  );
}
