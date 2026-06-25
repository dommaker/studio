// MonitoringPage — Agent Network MVP-6
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { monitoringApi, type MonitoringStats } from '../api/monitoring';

export function MonitoringPage() {
  const [data, setData] = useState<MonitoringStats | null>(null);
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
            <div className="mt-4 p-3 rounded bg-red-500/10 text-red-300 text-sm">{error}</div>
          )}

          {loading && !data ? (
            <div className="text-center py-20 text-gray-500">加载中...</div>
          ) : data ? (
            <div className="space-y-6 mt-4">
              {/* WorkUnit 状态分布 */}
              <Section title="WorkUnit 状态分布">
                <div className="grid grid-cols-4 gap-3">
                  <StatCard label="总数" value={data.workunits.total} color="text-blue-400" />
                  <StatCard label="待分配" value={data.workunits.unassigned} color="text-gray-400" />
                  <StatCard label="执行中" value={data.workunits.active} color="text-purple-400" />
                  <StatCard label="审查中" value={data.workunits.in_review} color="text-yellow-400" />
                  <StatCard label="已完成" value={data.workunits.done} color="text-green-400" />
                  <StatCard label="阻塞" value={data.workunits.blocked} color="text-red-400" />
                  <StatCard label="已关闭" value={data.workunits.closed} color="text-green-300" />
                </div>
              </Section>

              {/* Agent 状态 */}
              <Section title="Agent 状态">
                <div className="grid grid-cols-4 gap-3">
                  <StatCard label="总数" value={data.agents.total} color="text-blue-400" />
                  <StatCard label="空闲" value={data.agents.idle} color="text-gray-400" />
                  <StatCard label="执行中" value={data.agents.active} color="text-purple-400" />
                  <StatCard label="已终止" value={data.agents.terminated} color="text-red-400" />
                </div>
                {/* Agent 利用率 */}
                <div className="mt-3">
                  <span className="text-sm text-gray-400">利用率: </span>
                  <span className="text-sm font-bold text-purple-300">
                    {data.agents.total > 0
                      ? `${Math.round((data.agents.active / data.agents.total) * 100)}%`
                      : 'N/A'}
                  </span>
                  <span className="text-xs text-gray-500 ml-2">
                    ({data.agents.active} / {data.agents.total})
                  </span>
                </div>
              </Section>

              {/* 最近 24h */}
              <Section title="最近 24 小时">
                <div className="grid grid-cols-2 gap-3">
                  <StatCard label="完成" value={data.recent.completedLast24h} color="text-green-400" />
                  <StatCard label="失败/阻塞" value={data.recent.failedLast24h} color="text-red-400" />
                </div>
              </Section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <h2 className="text-sm font-medium text-gray-300 mb-3">{title}</h2>
      {children}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-sm text-gray-400">{label}</span>
    </div>
  );
}
