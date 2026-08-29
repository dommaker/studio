// AgentDetailPage — /agents/:profileId（2026-07-31 全流程串联 UX 重构 §5.3）
// Header（角色/状态/频道/ID/强制停止）→「正在执行」大卡（当前 WU + ExecutionSteps 实时执行流）
// →「历史任务」（assigneeId=instance.id 最近 20 条）→ 统计行
// #346：profile/instance/channelName 读 rosterStore（三端点 TTL 去重 + SSE 就地更新单份 + useGatedPoll 兜底
// 在 store/useRosterStoreSync）；本页只保留页面私有面：历史任务窗口（workunit.status_changed 防抖重拉对齐）
// 与当前 WU 快照缺失时的单实例补查（写回 store 共享）。
import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { monitoringApi } from '../api/monitoring';
import { workunitApi, type WorkUnit } from '../api/workunit';
import { ExecutionSteps } from '../components/workunit/ExecutionSteps';
import { ConfirmDialog, BackButton } from '../components/ui';
import { useWebSocketContext } from '../api/websocketHooks';
import { useRosterStore } from '../stores/rosterStore';
import { useRosterStoreSync } from '../hooks/useRosterStoreSync';
import { useAsyncData } from '../hooks/useAsyncData';
import {
  deriveAgentStatus,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_COLORS,
  formatUptime,
} from '../utils/agentStatus';
import { formatFullTime } from '../utils/datetime';

const HISTORY_LIMIT = 20;
/** #318 取舍（b）：历史任务「最近 20 条 + total」窗口无事件语义（新完成 WU 进榜/排序/total），
    workunit.status_changed 命中本实例时先就地更新已有行，再低频防抖只重拉历史区 1 接口对齐窗口 */
const HISTORY_REFRESH_DEBOUNCE_MS = 800;

export function AgentDetailPage() {
  const { profileId } = useParams<{ profileId: string }>();
  // 数据面接线：SSE 状态事件 → store + 兜底轮询 + 重连对齐（store 化后唯一接线点）
  useRosterStoreSync();
  const profiles = useRosterStore((s) => s.profiles);
  const agents = useRosterStore((s) => s.agents);
  const channels = useRosterStore((s) => s.channels);
  const loadedAt = useRosterStore((s) => s.loadedAt);
  const storeError = useRosterStore((s) => s.error);
  // terminate 等动作失败单独记（数据面错误在 store.error）
  const [actionError, setActionError] = useState<string | null>(null);
  // 强制停止二次确认（ui/ConfirmDialog，替代原生 window.confirm）
  const [confirmTerminate, setConfirmTerminate] = useState(false);

  const profile = useMemo(() => profiles.find((x) => x.id === profileId) ?? null, [profiles, profileId]);
  // 同一角色可能有多条历史 state，接口已按 startedAt 降序，取最新一条
  const instance = useMemo(() => agents.find((a) => a.roleId === profileId) ?? null, [agents, profileId]);
  const instanceId = instance?.id ?? null;
  const instanceIdRef = useRef<string | null>(null);
  useEffect(() => {
    instanceIdRef.current = instanceId;
  }, [instanceId]);
  const error = storeError ?? actionError;
  // loadedAt === null：首次数据尚未落地（403 终态/false 均已落地）
  const loading = loadedAt === null && !storeError;

  // 页面进入：TTL 门禁拉取（路由切换 TTL 内零重拉，#346 验收）
  useEffect(() => {
    void useRosterStore.getState().ensureFresh();
  }, [profileId]);

  // 后端聚合字段暂缺时按裸 ID 补查 WU 详情（store action：写回后 roster 左栏/仪表盘同享快照）
  useEffect(() => {
    if (!instance?.currentWorkUnitId || instance.currentWorkUnit) return;
    useRosterStore.getState().backfillCurrentWorkUnit(instance.id, instance.currentWorkUnitId);
  }, [instance]);

  // 所属频道名（store 缓存切片，查不到显示"频道"）
  const channelName = useMemo(() => {
    if (!instance?.channelId) return null;
    return channels.find((c) => c.id === instance.channelId)?.name ?? null;
  }, [channels, instance]);

  // 历史任务窗口（页面私有）：认领后 assigneeId = instance.id。
  // #350 useAsyncData：instanceId 变化渲染期清窗口重拉（SSE 就地更新不重拉历史区，语义不变）
  const historyQ = useAsyncData(async () => {
    if (!instanceId) return null;
    const hisRes = await workunitApi.list({ assigneeId: instanceId, limit: HISTORY_LIMIT });
    return { items: hisRes.data.data, total: hisRes.data.pagination.total };
  }, [instanceId]);
  const history = historyQ.data?.items ?? [];
  const historyTotal = historyQ.data?.total ?? 0;

  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
  }, []);

  // #318：workunit.status_changed 就地更新历史行 + 命中本实例防抖重拉历史区；
  // agent.instance.status_changed 与当前卡状态面已由 store 统一处理，本页不再重复订阅
  const { onEvent, onReconnect } = useWebSocketContext();

  // SSE 重连：store 数据面对齐由 useRosterStoreSync 负责（强制 ensureFresh）；
  // 历史任务窗口是页面私有面，断线期间的 status_changed 无事件语义，重连时重拉对齐（ADR D3）
  useEffect(() => onReconnect?.(() => {
    if (instanceIdRef.current) historyQ.reload();
  }), [onReconnect, historyQ]);

  useEffect(() => onEvent((msg) => {
    if (msg.event_type !== 'workunit.status_changed') return;
    const wu = (msg.data as { workunit?: WorkUnit } | null)?.workunit;
    if (!wu) return;
    // 历史行就地更新（负载为全量快照，claimable 与本页无关不覆盖）
    historyQ.setData(prev => prev && prev.items.some(h => h.id === wu.id)
      ? { ...prev, items: prev.items.map(h => (h.id === wu.id ? { ...wu, claimable: h.claimable } : h)) }
      : prev);
    // 本实例的 WU 状态变化 → 防抖重拉历史区（窗口排序/total 对齐；不重拉整页）
    if (wu.assigneeId && wu.assigneeId === instanceIdRef.current) {
      if (historyTimerRef.current) clearTimeout(historyTimerRef.current);
      historyTimerRef.current = setTimeout(() => {
        if (instanceIdRef.current) historyQ.reload();
      }, HISTORY_REFRESH_DEBOUNCE_MS);
    }
  }), [onEvent, historyQ]);

  const handleTerminate = async () => {
    setConfirmTerminate(false);
    if (!instance) return;
    try {
      await monitoringApi.terminateInstance(instance.id);
      await useRosterStore.getState().ensureFresh({ maxAgeMs: 0 });
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : 'Failed to terminate agent');
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
        {/* #393 §4.4：详情页统一左上返回（直开回落 /agents） */}
        <div className="mb-4"><BackButton fallback="/agents" /></div>
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
          </div>
        </div>
        <div className="flex gap-6 mt-3 text-xs u-text-2 flex-wrap">
          <span>Profile ID: <span className="u-text-3 font-mono">{profileId}</span></span>
          {instance && <span>Instance ID: <span className="u-text-3 font-mono">{instance.id}</span></span>}
          {instance && <span>Started: <span className="u-text-3 font-mono">{formatFullTime(instance.startedAt)}</span></span>}
          {instance && <span>运行: <span className="u-text-3" data-visual-ignore>{formatUptime(instance.startedAt)}</span></span>}
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
                        <span className="text-xs u-text-3" data-visual-ignore>已耗时 {formatUptime(wu.claimedAt)}</span>
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
                        <span className="u-text-3 shrink-0 font-mono">
                          {formatFullTime(w.completedAt ? w.completedAt : w.updatedAt)}
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
      <span className={`font-mono font-bold ${color}`} style={{ fontSize: 'var(--fs-stat)' }}>{value}</span>
      <span className="text-sm u-text-3">{label}</span>
    </div>
  );
}
