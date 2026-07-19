// AgentDashboard — Agent Network MVP-2
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { monitoringApi, type AgentInfo, type AgentSummary } from '../api/monitoring';
import { api } from '../api/index';

const statusColors: Record<string, string> = {
  idle: 'bg-gray-500/20 text-gray-300',
  active: 'bg-purple-500/20 text-purple-300',
  error: 'bg-orange-500/20 text-orange-300',
  terminated: 'bg-red-500/20 text-red-300',
};

const statusLabels: Record<string, string> = {
  idle: '空闲',
  active: '执行中',
  error: '不可用',
  terminated: '已终止',
};

export function AgentDashboardPage() {
  const [data, setData] = useState<AgentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await monitoringApi.getAgentSummary();
      setData(res.data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleTerminate = async (id: string) => {
    if (!window.confirm('确认强制释放该 Agent？当前 WorkUnit 将被释放回待分配状态。')) return;
    try {
      await api.post(`/agent-instances/${id}/terminate`);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to terminate agent');
    }
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">Agent Dashboard</h1>
            <p className="page-subtitle">Agent Network 运行时状态</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={load}>刷新</button>
            <Link to="/" className="btn btn-secondary">返回</Link>
          </div>
        </div>

        {data && (
          <div className="flex gap-6 mt-4">
            <StatBadge label="总数" value={data.summary.total} color="text-blue-400" />
            <StatBadge label="空闲" value={data.summary.idle} color="text-gray-400" />
            <StatBadge label="执行中" value={data.summary.active} color="text-purple-400" />
            <StatBadge label="不可用" value={data.summary.error} color="text-orange-400" />
            <StatBadge label="已终止" value={data.summary.terminated} color="text-red-400" />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {error && (
            <div className="mt-4 p-3 rounded bg-red-500/10 text-red-300 text-sm">{error}</div>
          )}

          {loading && !data ? (
            <div className="text-center py-20 text-gray-500">加载中...</div>
          ) : !data || data.agents.length === 0 ? (
            <div className="text-center py-20 text-gray-500">
              <div className="text-4xl mb-4">🤖</div>
              <p>暂无运行中的 Agent</p>
              <p className="text-sm mt-2">AgentProfile 启动后会自动注册</p>
            </div>
          ) : (
            <div className="space-y-2 mt-4">
              {data.agents.map(agent => (
                <AgentCard key={agent.id} agent={agent} onTerminate={handleTerminate} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentCard({ agent, onTerminate }: { agent: AgentInfo; onTerminate: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const uptime = formatUptime(agent.startedAt);

  return (
    <div className="rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div
        className="p-3 cursor-pointer flex items-center justify-between gap-4"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded ${statusColors[agent.status] || 'bg-gray-500/20 text-gray-300'}`}>
              {statusLabels[agent.status] ?? agent.status}
            </span>
            <span className="font-medium text-white">{agent.name}</span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
            <span>ID: {agent.id.slice(0, 8)}...</span>
            {agent.currentWorkUnitId && <span>WorkUnit: {agent.currentWorkUnitId.slice(0, 8)}...</span>}
            <span>运行: {uptime}</span>
          </div>
          {agent.lastError && (
            <div className="mt-1 text-xs text-orange-400 truncate" title={agent.lastError}>
              ⚠ {agent.lastError}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {agent.status !== 'terminated' && (
            <button
              className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30"
              onClick={e => { e.stopPropagation(); onTerminate(agent.id); }}
            >
              强制释放
            </button>
          )}
          <span className="text-gray-500 text-sm">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
            <div><span className="text-gray-500">ID:</span> <span className="text-gray-300">{agent.id}</span></div>
            <div><span className="text-gray-500">Status:</span> <span className="text-gray-300">{agent.status}</span></div>
            <div><span className="text-gray-500">Current WorkUnit:</span> <span className="text-gray-300">{agent.currentWorkUnitId ?? 'none'}</span></div>
            <div><span className="text-gray-500">Started:</span> <span className="text-gray-300">{new Date(agent.startedAt).toLocaleString('zh-CN')}</span></div>
            {agent.lastError && (
              <div className="col-span-2">
                <span className="text-gray-500">Last Error:</span>{' '}
                <span className="text-orange-300">{agent.lastError}</span>
                {agent.lastErrorAt && (
                  <span className="text-gray-500"> ({new Date(agent.lastErrorAt).toLocaleString('zh-CN')})</span>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-sm text-gray-400">{label}</span>
    </div>
  );
}

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
