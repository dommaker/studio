// AgentDetailPage — /agents/:profileId（2026-07-31 全流程串联 UX 重构 §5.3）
// Header（角色/状态/频道/ID/强制停止）→「正在执行」大卡（当前 WU + ExecutionSteps 实时执行流）
// →「历史任务」（assigneeId=instance.id 最近 20 条）→ 统计行
// #433 信息密度重构：内容区 ≥1280 双栏（左 正在执行+历史任务 / 右 统计卡，样式 agent-detail.css），
// ID 短显+复制（shortWuId/copyText），状态词走 CARD_STATUS_LABELS/WU_STATUS_LABELS 正词，空态消费 .empty-state。
// #346：profile/instance/channelName 读 rosterStore（三端点 TTL 去重 + SSE 就地更新单份 + useGatedPoll 兜底
// 在 store/useRosterStoreSync）；本页只保留页面私有面：历史任务窗口（workunit.status_changed 防抖重拉对齐）
// 与当前 WU 快照缺失时的单实例补查（写回 store 共享）。
import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatChannelName, WU_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { monitoringApi } from '../api/monitoring';
import { workunitApi, type WorkUnit } from '../api/workunit';
import { ExecutionSteps } from '../components/workunit/ExecutionSteps';
import { AgentAvatar } from '../components/channel/AgentAvatar';
import { RoleSkillsModal } from '../components/monitoring/RoleSkillsModal';
import { ConfirmDialog, BackButton, SkeletonCard } from '../components/ui';
import { useWebSocketContext } from '../api/websocketHooks';
import { useRosterStore } from '../stores/rosterStore';
import { useRosterStoreSync } from '../hooks/useRosterStoreSync';
import { useAsyncData } from '../hooks/useAsyncData';
import {
  resolveCardStatusKey,
  CARD_STATUS_LABELS,
  CARD_TO_DISPLAY_STATUS,
  DISPLAY_STATUS_LABELS,
  DISPLAY_STATUS_COLORS,
  formatUptime,
} from '../utils/agentStatus';
import { formatFullTime } from '../utils/datetime';
import { shortWuId } from '../utils/id';
import { copyText } from '../utils/clipboard';
import { errorMessage } from '../utils/errorMessage';
import '../styles/agent-detail.css';

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
  // 批次A 项7：提交期间 ConfirmDialog loading（防连点 + 遮罩关闭屏蔽）
  const [terminating, setTerminating] = useState(false);
  // #462：技能编辑弹框（role.skills 多选，候选 = skills MANIFEST）
  const [skillsOpen, setSkillsOpen] = useState(false);

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
    if (!instance) return;
    setTerminating(true);
    try {
      await monitoringApi.terminateInstance(instance.id);
      await useRosterStore.getState().ensureFresh({ maxAgeMs: 0 });
      setConfirmTerminate(false);
    } catch (e: unknown) {
      // 失败关窗 + 页顶错误条（批次A 项6：服务端 error.message 优先）
      setActionError(errorMessage(e));
      setConfirmTerminate(false);
    } finally {
      setTerminating(false);
    }
  };

  const wu = instance?.currentWorkUnit ?? null;
  // 状态 pill 走 4 态展示口径（与仪表盘卡面 pill 同词同色同源）；细分态（7+1）以小字保留在 pill 旁
  const statusKey = profile
    ? resolveCardStatusKey(profile.status, instance?.status ?? null, wu?.status)
    : null;
  const displayKey = statusKey ? CARD_TO_DISPLAY_STATUS[statusKey] : null;
  const statusPillColor = displayKey ? DISPLAY_STATUS_COLORS[displayKey] : '';
  const stats = {
    total: historyTotal,
    done: history.filter((w) => w.status === 'done' || w.status === 'completed' || w.status === 'closed').length,
    inFlight: history.filter((w) => w.status === 'active' || w.status === 'in_review').length,
    failed: history.filter((w) => w.status === 'failed' || w.failureType).length,
  };

  return (
    <div className="h-full flex flex-col u-page-bg">
      <div className="u-page-head">
        {/* #393 §4.4：详情页统一左上返回（直开回落 /agents） */}
        <div className="mb-4"><BackButton fallback="/agents" /></div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 flex-wrap">
            {/* #440 Phase 4：per-agent identicon 头像（与频道消息气泡同一生成逻辑）；2026-09-10 第二轮放大到 40 作头部锚点 */}
            {profile && <AgentAvatar name={profile.name} size={40} />}
            <h1 className="page-title">{profile?.name ?? 'Agent 详情'}</h1>
            {statusKey && displayKey && (
              <span className={`text-xs px-2 py-0.5 rounded ${statusPillColor}`}>
                {DISPLAY_STATUS_LABELS[displayKey]}
              </span>
            )}
            {/* 细分态小字（如「待处理 · 阻塞」「离线 · 已停用」）；与 4 态词同词时不重复显示 */}
            {statusKey && displayKey && CARD_STATUS_LABELS[statusKey] !== DISPLAY_STATUS_LABELS[displayKey] && (
              <span className="text-xs u-text-3">{`· ${CARD_STATUS_LABELS[statusKey]}`}</span>
            )}
            {profile && (
              <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2" title="背后的 CLI">
                CLI: {profile.provider ?? '未配置'}
              </span>
            )}
            {instance?.channelId && (
              <Link to={`/channels/${instance.channelId}`} className="text-xs u-text-2 u-hover-accent">
                {formatChannelName(channelName ?? '频道')}
              </Link>
            )}
          </div>
          <div className="flex gap-2">
            {instance && instance.status !== 'terminated' && (
              <button
                className="btn btn-danger btn-sm"
                onClick={() => setConfirmTerminate(true)}
              >
                强制停止
              </button>
            )}
          </div>
        </div>
        <div className="flex gap-6 mt-3 text-xs u-text-2 flex-wrap">
          {profileId && <IdWithCopy label="Profile ID" value={profileId} />}
          {instance && <IdWithCopy label="Instance ID" value={instance.id} />}
          {instance && <span>Started: <span className="u-text-3 font-mono">{formatFullTime(instance.startedAt)}</span></span>}
          {instance && <span>运行: <span className="u-text-3" data-visual-ignore>{formatUptime(instance.startedAt)}</span></span>}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="agent-detail-wrap">
          {error && (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">{error}</div>
          )}

          {loading && !profile ? (
            // 批次 F-3：加载态骨架（批次 E-2 ui/Skeleton 正本）——双栏卡形态
            <div className="agent-detail-grid">
              <div className="space-y-3">
                <SkeletonCard height={120} />
                <SkeletonCard height={200} />
              </div>
              <div className="space-y-3">
                <SkeletonCard height={160} />
              </div>
            </div>
          ) : !profile ? (
            <div className="text-center py-20 u-text-2">
              <p>未找到该角色</p>
              <p className="text-sm mt-2"><Link to="/agents" className="u-accent">返回 /agents</Link></p>
            </div>
          ) : (
            /* #433：≥1280 双栏（左主栏 / 右统计栏），<1280 单栏堆叠 */
            <div className="agent-detail-grid">
              <div>
                {/* 正在执行 */}
                <div className="card p-3">
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
                        <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2">{WU_STATUS_LABELS[wu.status] ?? wu.status}</span>
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
                            {formatChannelName(channelName ?? '频道')}
                          </Link>
                        )}
                      </div>
                      <div className="mt-2">
                        <ExecutionSteps workUnitId={wu.id} />
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">空闲 · 等待派活</div>
                  )}
                </div>

                {/* 历史任务 */}
                <div className="card mt-4">
                  <div className="mc-block-label px-3 pt-3">历史任务</div>
                  {history.length === 0 ? (
                    <div className="empty-state">暂无历史任务</div>
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
                          <span className="u-text-2 shrink-0">{WU_STATUS_LABELS[w.status] ?? w.status}</span>
                          <span className="u-text-3 shrink-0 font-mono">
                            {formatFullTime(w.completedAt ? w.completedAt : w.updatedAt)}
                          </span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* 统计栏（由历史列表推导） */}
              <div>
                {/* #462：技能卡（role.skills = 注入索引候选；编辑走 MANIFEST 多选弹框） */}
                <div className="card p-3">
                  <div className="flex items-center justify-between">
                    <div className="mc-block-label">技能</div>
                    <button className="btn btn-secondary btn-sm" onClick={() => setSkillsOpen(true)}>编辑技能</button>
                  </div>
                  {profile.skills && profile.skills.length > 0 ? (
                    <div className="flex gap-1 mt-2 flex-wrap">
                      {profile.skills.map((s) => (
                        <span key={s} className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2">{s}</span>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm u-text-3 mt-2">未声明</div>
                  )}
                </div>

                <div className="card p-3 mt-4">
                  <div className="mc-block-label">统计</div>
                  <div className="flex flex-col gap-2 mt-2">
                    <StatBadge label="历史总数" value={stats.total} color="u-accent" />
                    <StatBadge label="完成" value={stats.done} color="u-ok" />
                    <StatBadge label="在途" value={stats.inFlight} color="u-accent" />
                    <StatBadge label="失败" value={stats.failed} color="u-err" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* #462：技能编辑弹框（保存后强制刷新名册） */}
      {profile && (
        <RoleSkillsModal
          open={skillsOpen}
          profile={profile}
          onClose={() => setSkillsOpen(false)}
          onSaved={() => void useRosterStore.getState().ensureFresh({ maxAgeMs: 0 })}
        />
      )}

      <ConfirmDialog
        open={confirmTerminate}
        title="强制停止"
        message="强制停止会将当前任务转人工处理，确认？"
        confirmLabel="确认停止"
        danger
        loading={terminating}
        onConfirm={() => void handleTerminate()}
        onCancel={() => setConfirmTerminate(false)}
      />
    </div>
  );
}

/** #433：ID 短显（shortWuId，title 承载全量）+ 复制钮（copyText 复制全量原值，「✓ 已复制」反馈 2s） */
function IdWithCopy({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);
  return (
    <span>
      {label}: <span className="u-text-3 font-mono" title={value}>{shortWuId(value)}</span>
      <button
        className="u-btn-reset u-text-3 u-hover-accent ml-1"
        onClick={() => {
          void copyText(value).then(() => {
            setCopied(true);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? '✓ 已复制' : '复制'}
      </button>
    </span>
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
