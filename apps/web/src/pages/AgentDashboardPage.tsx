// AgentDashboard — 角色（AgentProfile）作战视图（2026-07-31 全流程串联 UX 重构 §5.2）
// 数据/实时全部委托 useAgentRoster（名册合并 + SSE 事件路由 + 30s 轮询），本页只做组合与渲染。
// 渲染边界（#348）：执行动态下沉 rosterActivityStore，RoleCard 自订切片——stream chunk 只重渲
// 对应卡，不掀本页整树；stats useMemo，卡片 memo + 稳定 props（对齐 #322 三件套）。
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAgentRoster } from '../hooks/useAgentRoster';
import { RoleCard } from '../components/monitoring/RoleCard';
import { ConfirmDialog } from '../components/ui';

export function AgentDashboardPage() {
  const navigate = useNavigate();
  const { roles, lastDone, channelNames, loading, error, forbidden, terminate } = useAgentRoster();
  // 强制停止二次确认（ui/ConfirmDialog，替代原生 window.confirm）
  const [terminateTarget, setTerminateTarget] = useState<string | null>(null);

  const handleConfirmTerminate = () => {
    const id = terminateTarget;
    setTerminateTarget(null);
    if (id) void terminate(id);
  };

  const stats = useMemo(() => ({
    total: roles.length,
    online: roles.filter((r) => r.profile.isOnline).length,
    active: roles.filter((r) => r.runtime?.status === 'active').length,
    error: roles.filter((r) => r.runtime?.status === 'error').length,
    inactive: roles.filter((r) => r.profile.status !== 'active').length,
  }), [roles]);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="page-title">Agent 管理</h1>
            <p className="page-subtitle">角色清单（状态 / 当前任务 / 实时动态）</p>
          </div>
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={() => navigate('/setup/roles')}>创建角色</button>
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

          {forbidden ? (
            // #283：monitoring 接口 Admin-only，非 Admin 渲染「无权限」终态
            <div className="text-center py-20 u-text-2">
              <div className="text-4xl mb-4">🔒</div>
              <p>无权限查看 Agent 运行数据（需 Admin 权限）</p>
            </div>
          ) : loading && roles.length === 0 ? (
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
                <RoleCard
                  key={r.profile.id}
                  role={r}
                  lastDone={lastDone[r.profile.id] ?? null}
                  channelNames={channelNames}
                  onTerminate={setTerminateTarget}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={terminateTarget != null}
        title="强制停止"
        message="强制停止会将当前任务转人工处理，确认？"
        confirmLabel="确认停止"
        danger
        onConfirm={handleConfirmTerminate}
        onCancel={() => setTerminateTarget(null)}
      />
    </div>
  );
}

function StatBadge({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`font-bold ${color}`} style={{ fontSize: 'var(--fs-stat)' }}>{value}</span>
      <span className="text-sm u-text-3">{label}</span>
    </div>
  );
}
