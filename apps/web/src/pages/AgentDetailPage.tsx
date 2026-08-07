// AgentDetailPage — /agents/:profileId（2026-07-31 全流程串联 UX 重构 §5.3）
// Header（角色/状态/频道/ID/强制停止）→「正在执行」大卡（当前 WU + ExecutionSteps 实时执行流）
// →「历史任务」（assigneeId=instance.id 最近 20 条）→ 统计行
// 数据：profile 用 channelApi.listAllAgents() 按 id 匹配；instance 用 monitoringApi.getAgentSummary() 按 roleId 取最新一条
import { useState, useEffect, useCallback } from 'react';
import { Link, useParams } from 'react-router-dom';
import { monitoringApi, type AgentInfo, type AgentCurrentWorkUnit } from '../api/monitoring';
import { channelApi, type AgentProfile } from '../api/channel';
import { workunitApi, type WorkUnit } from '../api/workunit';
import { ExecutionSteps } from '../components/workunit/ExecutionSteps';
import { ConfirmDialog } from '../components/ui';
import { useWorkUnitEvents } from '../hooks/useWorkUnitEvents';
import {
  deriveAgentStatus,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_COLORS,
  formatUptime,
} from '../utils/agentStatus';

const HISTORY_LIMIT = 20;

export function AgentDetailPage() {
  const { profileId } = useParams<{ profileId: string }>();
  const [profile, setProfile] = useState<AgentProfile | null>(null);
  const [instance, setInstance] = useState<AgentInfo | null>(null);
  const [history, setHistory] = useState<WorkUnit[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 强制停止二次确认（ui/ConfirmDialog，替代原生 window.confirm）
  const [confirmTerminate, setConfirmTerminate] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!profileId) return;
    if (!silent) setLoading(true);
    try {
      const [profilesRes, summaryRes] = await Promise.all([
        channelApi.listAllAgents(),
        monitoringApi.getAgentSummary(),
      ]);
      const p = profilesRes.data.data.find((x) => x.id === profileId) ?? null;
      setProfile(p);
      // 同一角色可能有多条历史 state，接口已按 startedAt 降序，取最新一条
      const inst = summaryRes.data.agents.find((a) => a.roleId === profileId) ?? null;
      let currentWorkUnit: AgentCurrentWorkUnit | null = inst?.currentWorkUnit ?? null;
      // 后端聚合字段暂缺时按裸 ID 补查 WU 详情
      if (inst?.currentWorkUnitId && !currentWorkUnit) {
        try {
          const wuRes = await workunitApi.get(inst.currentWorkUnitId);
          const wu = wuRes.data;
          currentWorkUnit = { id: wu.id, title: wu.scope, type: wu.type, status: wu.status, claimedAt: wu.claimedAt };
        } catch {
          currentWorkUnit = null;
        }
      }
      setInstance(inst ? { ...inst, currentWorkUnit } : null);
      // 所属频道名（缓存查询，查不到显示"频道"）
      if (inst?.channelId) {
        try {
          const chRes = await channelApi.list();
          setChannelName(chRes.data.data.find((c) => c.id === inst.channelId)?.name ?? null);
        } catch {
          setChannelName(null);
        }
      } else {
        setChannelName(null);
      }
      // 历史任务：认领后 assigneeId = instance.id
      if (inst) {
        try {
          const hisRes = await workunitApi.list({ assigneeId: inst.id, limit: HISTORY_LIMIT });
          setHistory(hisRes.data.data);
          setHistoryTotal(hisRes.data.total);
        } catch {
          setHistory([]);
          setHistoryTotal(0);
        }
      } else {
        setHistory([]);
        setHistoryTotal(0);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load agent');
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => { void load(); }, [load]);
  // WU 事件（SSE）：认领/状态变化/执行步时刷新当前任务与历史（防抖 400ms，与列表页同模式）
  useWorkUnitEvents(useCallback(() => { void load(true); }, [load]));

  const handleTerminate = async () => {
    setConfirmTerminate(false);
    if (!instance) return;
    try {
      await monitoringApi.terminateInstance(instance.id);
      await load(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to terminate agent');
    }
  };

  const wu = instance?.currentWorkUnit ?? null;
  const statusKey = profile?.status !== 'active'
    ? null
    : deriveAgentStatus(instance?.status ?? null, wu?.status);
  const stats = {
    total: historyTotal,
    done: history.filter((w) => w.status === 'done' || w.status === 'completed' || w.status === 'closed').length,
    inFlight: history.filter((w) => w.status === 'active' || w.status === 'in_review').length,
    failed: history.filter((w) => w.status === 'failed' || w.failureType).length,
  };

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="page-title">{profile?.name ?? 'Agent 详情'}</h1>
            {profile && (
              <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2" title="背后的 CLI">
                CLI: {profile.provider ?? '未配置'}
              </span>
            )}
            {statusKey && (
              <span className={`text-xs px-2 py-0.5 rounded ${AGENT_STATUS_COLORS[statusKey]}`}>
                {AGENT_STATUS_LABELS[statusKey]}
              </span>
            )}
            {profile?.status !== 'active' && profile && (
              <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3">已停用</span>
            )}
            {instance?.channelId && (
              <Link to={`/channels/${instance.channelId}`} className="text-xs u-text-2 u-hover-accent">
                #{channelName ?? '频道'}
              </Link>
            )}
          </div>
          <div className="flex gap-2">
            {instance && instance.status !== 'terminated' && (
              <button
                className="text-xs px-2 py-1 rounded u-err-dim u-err u-hover-bg"
                onClick={() => setConfirmTerminate(true)}
              >
                强制停止
              </button>
            )}
            <Link to="/agents" className="btn btn-secondary">返回 /agents</Link>
          </div>
        </div>
        <div className="flex gap-6 mt-3 text-xs u-text-2 flex-wrap">
          <span>Profile ID: <span className="u-text-3">{profileId}</span></span>
          {instance && <span>Instance ID: <span className="u-text-3">{instance.id}</span></span>}
          {instance && <span>Started: <span className="u-text-3">{new Date(instance.startedAt).toLocaleString('zh-CN')}</span></span>}
          {instance && <span>运行: <span className="u-text-3">{formatUptime(instance.startedAt)}</span></span>}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {error && (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
          )}

          {loading && !profile ? (
            <div className="text-center py-20 u-text-2">加载中...</div>
          ) : !profile ? (
            <div className="text-center py-20 u-text-2">
              <p>未找到该角色</p>
              <p className="text-sm mt-2"><Link to="/agents" className="u-accent">返回 /agents</Link></p>
            </div>
          ) : (
            <>
              {/* 正在执行 */}
              <div className="mt-4 rounded-lg p-3" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                <div className="mc-block-label">正在执行</div>
                {wu ? (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      {wu.type && (
                        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2">{wu.type}</span>
                      )}
                      <Link to={`/workunits/${wu.id}`} className="text-sm u-text u-hover-accent">
                        {wu.title || wu.id}
                      </Link>
                      <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2">{wu.status}</span>
                      {wu.claimedAt && (
                        <span className="text-xs u-text-3">已耗时 {formatUptime(wu.claimedAt)}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs u-text-2 flex-wrap">
                      {instance?.pmo && (
                        <Link to={`/pmo/project/${instance.pmo.id}`} className="u-text-2 u-hover-accent">
                          {instance.pmo.pmoNumber} · {instance.pmo.title}
                        </Link>
                      )}
                      {instance?.channelId && (
                        <Link to={`/channels/${instance.channelId}`} className="u-text-2 u-hover-accent">
                          #{channelName ?? '频道'}
                        </Link>
                      )}
                    </div>
                    <div className="mt-2">
                      <ExecutionSteps workUnitId={wu.id} />
                    </div>
                  </>
                ) : (
                  <div className="py-6 text-center u-text-3 text-sm">当前空闲</div>
                )}
              </div>

              {/* 统计行（由历史列表推导） */}
              <div className="flex gap-6 mt-4">
                <StatBadge label="历史总数" value={stats.total} color="u-accent" />
                <StatBadge label="完成" value={stats.done} color="u-ok" />
                <StatBadge label="在途" value={stats.inFlight} color="u-accent" />
                <StatBadge label="失败" value={stats.failed} color="u-err" />
              </div>

              {/* 历史任务 */}
              <div className="mt-4 rounded-lg" style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)' }}>
                <div className="mc-block-label px-3 pt-3">历史任务</div>
                {history.length === 0 ? (
                  <div className="px-3 pb-3 text-xs u-text-3">暂无历史任务</div>
                ) : (
                  <div className="pb-2">
                    {history.map((w) => (
                      <Link
                        key={w.id}
                        to={`/workunits/${w.id}`}
                        className="flex items-center gap-3 px-3 py-2 u-hover-bg text-xs"
                      >
                        <span className="px-2 py-0.5 rounded u-surface-2 u-text-2 shrink-0">{w.type}</span>
                        <span className="u-text truncate flex-1">{w.scope}</span>
                        <span className="u-text-2 shrink-0">{w.status}</span>
                        <span className="u-text-3 shrink-0">
                          {w.completedAt
                            ? new Date(w.completedAt).toLocaleString('zh-CN')
                            : new Date(w.updatedAt).toLocaleString('zh-CN')}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmTerminate}
        title="强制停止"
        message="强制停止会将当前任务转人工处理，确认？"
        confirmLabel="确认停止"
        danger
        onConfirm={() => void handleTerminate()}
        onCancel={() => setConfirmTerminate(false)}
      />
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
