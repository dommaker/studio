// AgentDashboard — 角色（AgentProfile）中心的管理视图（2026-07 频道角色修复）
// 每行：名称 / 背后 CLI(provider) / 描述 / profile 状态 / 运行时状态（按 roleId 合并 /monitoring/agents）
// 未启动过的角色也可见；页头"创建角色"入口 → /setup/roles 向导
import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { monitoringApi, type AgentInfo } from '../api/monitoring';
import { channelApi, type AgentProfile } from '../api/channel';
import { api } from '../api/index';

const statusColors: Record<string, string> = {
  idle: 'u-surface-2 u-text-3',
  active: 'u-accent-dim u-accent',
  error: 'u-warn-dim u-warn',
  terminated: 'u-err-dim u-err',
  none: 'u-surface-2 u-text-3',
};

const statusLabels: Record<string, string> = {
  idle: '空闲',
  active: '执行中',
  error: '不可用',
  terminated: '已终止',
  none: '未启动',
};

interface MergedRole {
  profile: AgentProfile;
  runtime: AgentInfo | null;
}

export function AgentDashboardPage() {
  const navigate = useNavigate();
  const [roles, setRoles] = useState<MergedRole[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [profilesRes, summaryRes] = await Promise.all([
        channelApi.listAllAgents(),
        monitoringApi.getAgentSummary(),
      ]);
      // 运行时状态按 roleId 合并（同一角色可能有多条历史 state，接口已按 startedAt 降序，取最新一条）
      const runtimeByRole = new Map<string, AgentInfo>();
      for (const a of summaryRes.data.agents) {
        if (!runtimeByRole.has(a.roleId)) runtimeByRole.set(a.roleId, a);
      }
      setRoles(
        profilesRes.data.data.map((p) => ({ profile: p, runtime: runtimeByRole.get(p.id) ?? null })),
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load agents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleTerminate = async (instanceId: string) => {
    if (!window.confirm('确认强制释放该 Agent？当前 WorkUnit 将被释放回待分配状态。')) return;
    try {
      await api.post(`/agent-instances/${instanceId}/terminate`);
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to terminate agent');
    }
  };

  const stats = {
    total: roles.length,
    online: roles.filter((r) => r.profile.isOnline).length,
    active: roles.filter((r) => r.runtime?.status === 'active').length,
    error: roles.filter((r) => r.runtime?.status === 'error').length,
    inactive: roles.filter((r) => r.profile.status !== 'active').length,
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">Agent 管理</h1>
            <p className="page-subtitle">角色清单（名字 / 背后 CLI / 运行状态）</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => navigate('/setup/roles')}>创建角色</button>
            <button className="btn btn-secondary" onClick={load}>刷新</button>
            <Link to="/" className="btn btn-secondary">返回</Link>
          </div>
        </div>

        <div className="flex gap-6 mt-4">
          <StatBadge label="角色总数" value={stats.total} color="u-accent" />
          <StatBadge label="在线" value={stats.online} color="u-accent" />
          <StatBadge label="执行中" value={stats.active} color="u-accent" />
          <StatBadge label="不可用" value={stats.error} color="u-warn" />
          <StatBadge label="已停用" value={stats.inactive} color="u-err" />
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {error && (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
          )}

          {loading && roles.length === 0 ? (
            <div className="text-center py-20 u-text-2">加载中...</div>
          ) : roles.length === 0 ? (
            <div className="text-center py-20 u-text-2">
              <div className="text-4xl mb-4">🤖</div>
              <p>暂无角色</p>
              <p className="text-sm mt-2">点击右上角"创建角色"，从检测到的 CLI 创建第一个 Agent</p>
            </div>
          ) : (
            <div className="space-y-2 mt-4">
              {roles.map((r) => (
                <RoleCard key={r.profile.id} role={r} onTerminate={handleTerminate} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RoleCard({ role, onTerminate }: { role: MergedRole; onTerminate: (instanceId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { profile, runtime } = role;
  const isSystemRole = profile.name === 'studio';
  const runtimeStatus = profile.status !== 'active' ? '已停用' : (runtime?.status ?? 'none');
  const lastError = runtime?.lastError ?? profile.lastError;

  return (
    <div className="rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}>
      <div
        className="p-3 cursor-pointer flex items-center justify-between gap-4"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs px-2 py-0.5 rounded ${statusColors[runtimeStatus] || 'u-surface-2 u-text-3'}`}>
              {statusLabels[runtimeStatus] ?? runtimeStatus}
            </span>
            <span className="font-medium u-text">{profile.name}</span>
            {isSystemRole && (
              <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">系统</span>
            )}
            <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2" title="背后的 CLI">
              CLI: {profile.provider ?? '未配置'}
            </span>
          </div>
          <div className="flex items-center gap-4 mt-1 text-xs u-text-2">
            {profile.description && <span className="truncate" title={profile.description}>{profile.description}</span>}
            {runtime?.currentWorkUnitId && <span>WorkUnit: {runtime.currentWorkUnitId.slice(0, 8)}...</span>}
            {runtime && <span>运行: {formatUptime(runtime.startedAt)}</span>}
          </div>
          {lastError && (
            <div className="mt-1 text-xs u-warn truncate" title={lastError}>
              ⚠ {lastError}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {runtime && runtime.status !== 'terminated' && (
            <button
              className="text-xs px-2 py-1 rounded u-err-dim u-err u-hover-bg"
              onClick={e => { e.stopPropagation(); onTerminate(runtime.id); }}
            >
              强制释放
            </button>
          )}
          <span className="u-text-2 text-sm">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
            <div><span className="u-text-2">Profile ID:</span> <span className="u-text-3">{profile.id}</span></div>
            <div><span className="u-text-2">CLI Provider:</span> <span className="u-text-3">{profile.provider ?? '未配置'}</span></div>
            <div><span className="u-text-2">Profile Status:</span> <span className="u-text-3">{profile.status}</span></div>
            <div><span className="u-text-2">Online:</span> <span className="u-text-3">{profile.isOnline ? '是' : '否'}</span></div>
            {runtime && (
              <>
                <div><span className="u-text-2">Instance ID:</span> <span className="u-text-3">{runtime.id}</span></div>
                <div><span className="u-text-2">Runtime Status:</span> <span className="u-text-3">{runtime.status}</span></div>
                <div><span className="u-text-2">Current WorkUnit:</span> <span className="u-text-3">{runtime.currentWorkUnitId ?? 'none'}</span></div>
                <div><span className="u-text-2">Started:</span> <span className="u-text-3">{new Date(runtime.startedAt).toLocaleString('zh-CN')}</span></div>
              </>
            )}
            {lastError && (
              <div className="col-span-2">
                <span className="u-text-2">Last Error:</span>{' '}
                <span className="u-warn">{lastError}</span>
                {runtime?.lastErrorAt && (
                  <span className="u-text-2"> ({new Date(runtime.lastErrorAt).toLocaleString('zh-CN')})</span>
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
      <span className="text-sm u-text-3">{label}</span>
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
