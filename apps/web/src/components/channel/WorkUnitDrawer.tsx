// WorkUnitDrawer — Mission Control 右抽屉：WorkUnit 详情 / REQ 全链路
// 只展示真实 API 数据（workunitApi / requirementApi / monitoringApi / channelApi），无对应数据的维度不展示、不编造
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  workunitApi,
  parseWorkunitTokenEvents,
  type WorkUnit,
  type WorkunitTokenEvent,
} from '../../api/workunit';
import { requirementApi, type RequirementChain } from '../../api/requirements';
import { monitoringApi, type OverheadStats } from '../../api/monitoring';
import { channelApi } from '../../api/channel';
import { useWebSocketContext } from '../../api/websocketHooks';
import { ExecutionSteps } from '../workunit/ExecutionSteps';
import { BlockedActions } from '../workunit/BlockedActions';
import { TreeTokenDrawer } from '../workunit/TreeTokenDrawer';
import { SelfReviewBadge } from '../workunit/SelfReviewBadge';
import { EvidenceLedger } from '../workunit/EvidenceLedger';
import { AnalysisApproveDialog } from '../pmo/AnalysisApproveDialog';
import { buildMapOpeningPrefill } from '../pmo/mapUtils';
import { deriveDisplayState, parseAttestations, WU_STATUS_LABELS } from '@dommaker/studio-shared/web';
import { AssigneeLabel } from '../workunit/AssigneeLabel';
import { formatShortTime } from '../../utils/datetime';
import { parseWuMeta } from '../../utils/wuMeta';

export type DrawerState =
  // #284（决策 #250 D6）：autoApprove = analysis_confirm 接力卡「去确认」的「打开即弹」入参
  | { kind: 'wu'; id: string; autoApprove?: boolean }
  | { kind: 'req'; id: string }
  | null;

const REQ_STATUS_LABELS: Record<string, string> = {
  open: '未开始',
  'in-progress': '进行中',
  done: '已完成',
  archived: '已归档',
};

/** wu 状态 → 状态 chip 修饰类（active=执行中 pulse / blocked=待确认 / done|closed=完成 / 其余=待定） */
function wuStatusClass(status: string): string {
  if (status === 'active') return 'mc-status mc-status-running';
  if (status === 'blocked') return 'mc-status mc-status-need';
  if (status === 'done' || status === 'closed') return 'mc-status mc-status-done';
  return 'mc-status mc-status-pending';
}

/** F6：WU 展示状态唯一派生口径（铁律：徽章/样式只准看派生列，禁止各自解释 attestations） */
function deriveWuColumn(wu: { status: string; metadata?: string | null }): string {
  return deriveDisplayState({ status: wu.status, metadata: wu.metadata }).column;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

interface Props {
  drawer: DrawerState;
  onClose: () => void;
  onOpenWu: (id: string) => void;
  onOpenReq: (id: string) => void;
}

/** WU metadata JSON 解析产物（只声明本抽屉消费字段，其余透传） */
interface WuMeta {
  title?: string;
  stepCount?: number;
  waitingForInput?: boolean;
  waitingQuestion?: string;
  [key: string]: unknown;
}

export function WorkUnitDrawer({ drawer, onClose, onOpenWu, onOpenReq }: Props) {
  if (!drawer) return null;
  return (
    <aside className="mc-drawer" aria-label="详情抽屉">
      <div className="mc-drawer-head">
        <h3 className="mc-drawer-title">
          {drawer.kind === 'wu' ? drawer.id : `${drawer.id} 全链路`}
        </h3>
        <button className="mc-drawer-close" aria-label="关闭抽屉" onClick={onClose}>×</button>
      </div>
      <div className="mc-drawer-body">
        {drawer.kind === 'wu'
          ? <WuDetail id={drawer.id} autoApprove={drawer.autoApprove === true} onOpenReq={onOpenReq} />
          : <ReqChain id={drawer.id} onOpenWu={onOpenWu} />}
      </div>
    </aside>
  );
}

// ── WorkUnit 详情 ──

function WuDetail({ id, autoApprove = false, onOpenReq }: { id: string; autoApprove?: boolean; onOpenReq: (reqId: string) => void }) {
  const navigate = useNavigate();
  const [wu, setWu] = useState<WorkUnit | null>(null);
  const [tokens, setTokens] = useState<WorkunitTokenEvent[] | null>(null);
  const [overhead, setOverhead] = useState<OverheadStats | null>(null);
  // #275（#251 断点2）：「#频道名」回频道入口的频道名（best-effort，失败退回 id 截短显示）
  const [channelName, setChannelName] = useState<string | null>(null);
  const [error, setError] = useState('');
  // #241: 悬空 WU 引用（历史清理后消息 footer 指向已不存在的 WU）——404 单列友好态
  const [notFound, setNotFound] = useState(false);
  const [showTreeTokens, setShowTreeTokens] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // #106 M7：analysis 通过/确认弹窗（共享件），非 analysis 保持一键通过
  const [showApproveModal, setShowApproveModal] = useState(false);
  // #284：in_review 拒绝入口（带原因弹窗，与列表行/详情页一致）
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // #284（决策 #250 D6）：接力卡「打开即弹」一次性哨兵（ref：避免 effect 内 setState 触发 lint；
  // 仅 id/autoApprove 变化时重新武装，SSE 事件更新不重复弹）
  const autoPopupDoneRef = useRef(!autoApprove);
  useEffect(() => {
    autoPopupDoneRef.current = !autoApprove;
  }, [id, autoApprove]);
  // 决策 8（2026-08 SSE 负载加深）：SSE 事件订阅——status_changed 负载 = 全量 WorkUnit
  // （同 workunitApi.get 形状）按 id 匹配直接替换本地 wu；workunit.tokens 复用
  // parseWorkunitTokenEvents 防御解析（他 WU / 缺字段负载跳过，聚合保持现有值）。
  // 替代原 eventTick（400ms 防抖）驱动的整组重拉。
  const { onEvent } = useWebSocketContext();

  // 渲染期按 id 重置（替代原 effect 内同步重置）：SSE 事件触发的更新不重置，
  // 消除每次事件都闪"加载中…"的骨架闪烁——事件刷新静默进行，旧数据留到新数据到达
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setWu(null);
    setTokens(null);
    setChannelName(null);
    setError('');
    setNotFound(false);
  }

  // 开抽屉一次性打底：WU 详情（+ 频道名 best-effort）
  useEffect(() => {
    let alive = true;
    workunitApi.get(id)
      .then(r => {
        if (!alive) return;
        setWu(r.data);
        setError('');
        // #284（决策 #250 D6）：接力卡「去确认」打开即弹——WU 加载完成自动弹 AnalysisApproveDialog
        // （仅 in_review analysis；其余情形仅打开抽屉。一次性，确认/取消后不重弹）
        if (!autoPopupDoneRef.current) {
          autoPopupDoneRef.current = true;
          if (r.data.type === 'analysis' && r.data.status === 'in_review') setShowApproveModal(true);
        }
        // #275（#251 断点2）：频道名 best-effort（频道已删/无权限时保留 null，链接退回 id 截短）
        if (r.data.channelId) {
          channelApi.get(r.data.channelId)
            .then(res => { if (alive) setChannelName(res.data.data.name); })
            .catch(() => { /* best-effort */ });
        }
      })
      .catch(e => {
        if (!alive) return;
        if (axios.isAxiosError(e) && e.response?.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => { alive = false; };
  }, [id]);

  // 开抽屉一次性打底：token 度量历史（此后增量走 workunit.tokens SSE）
  useEffect(() => {
    let alive = true;
    workunitApi.listTokenEvents()
      .then(r => { if (alive) setTokens(parseWorkunitTokenEvents(r.data.events || [], id)); })
      .catch(() => { if (alive) setTokens([]); });
    return () => { alive = false; };
  }, [id]);

  // 开抽屉一次性打底：全局 30 天封装开销（全局聚合，不随单 WU 事件变化，不随任何事件重拉）
  useEffect(() => {
    let alive = true;
    monitoringApi.getOverhead()
      .then(r => { if (alive) setOverhead(r.data); })
      .catch(() => {});
    return () => { alive = false; };
  }, [id]);

  // SSE 增量订阅（决策 8）
  useEffect(() => onEvent((msg) => {
    if (msg.event_type === 'workunit.status_changed') {
      const data = msg.data as { workunit?: WorkUnit } | null;
      if (data?.workunit && data.workunit.id === id) setWu(data.workunit);
    } else if (msg.event_type === 'workunit.tokens') {
      const [ev] = parseWorkunitTokenEvents([{ payload: msg.data }], id);
      if (ev) setTokens(prev => [...(prev ?? []), ev]);
    }
  }), [onEvent, id]);

  if (notFound) return <div className="mc-drawer-note">该任务不存在或已被清理（id：{id}）</div>;
  if (error) return <div className="mc-drawer-note">加载失败: {error}</div>;
  if (!wu) return <div className="mc-drawer-note">加载中…</div>;

  const meta = parseWuMeta<WuMeta>(wu.metadata);
  const title = meta.title || wu.scope;
  // F6 派生（铁律：needsHuman/证据判断一律过 deriveDisplayState，不自行读 attestations 字段）
  const derived = deriveDisplayState({ status: wu.status, metadata: wu.metadata });
  const attestations = parseAttestations(wu.metadata);
  const injectedSum = (tokens ?? []).reduce((s, t) => s + t.injectedTokens, 0);
  const execKnown = (tokens ?? []).filter(t => t.executionTokens !== null);
  const execSum = execKnown.reduce((s, t) => s + (t.executionTokens ?? 0), 0);
  const totalSum = (tokens ?? []).reduce((s, t) => s + t.totalTokens, 0);
  const maxBar = Math.max(totalSum, 1);

  /** 人工确认入口：in_review = 审查硬门（过→done；analysis 过后自动拆任务派工）；
   *  done 缺 l3 = L3 人工验收留痕（不阻断流程）。同调 reviewPassed（服务端幂等）。
   *  决策 8：动作成功后用响应体直接更新本地 wu（状态变化另有 status_changed SSE 兜底） */
  const handleReviewPassed = async (summary?: string, assigneeId?: string) => {
    setConfirming(true);
    try {
      const r = await workunitApi.reviewPassed(id, summary, assigneeId);
      setWu(r.data);
    } finally {
      setConfirming(false);
    }
  };
  // analysis 单走确认弹窗（待决问题清单审核，预填→人改→带 summary 提交）；其余类型保持一键通过
  const handleApprove = () => (wu.type === 'analysis' ? setShowApproveModal(true) : handleReviewPassed());

  /** #126（T4）待确认人闸：扩范围单（feature/task/spec）创建落 pending，人工确认 → unassigned 进 frontier 可认领 */
  const handleConfirmPending = async () => {
    setConfirming(true);
    try {
      const r = await workunitApi.transitionStatus(id, 'unassigned');
      setWu(r.data);
    } finally {
      setConfirming(false);
    }
  };

  /** #284：审查硬门拒绝（带原因），与列表行/详情页同一端点同一语义 */
  const handleReviewRejected = async () => {
    setConfirming(true);
    try {
      const r = await workunitApi.reviewRejected(id, rejectReason.trim() || undefined);
      setWu(r.data);
      setShowRejectModal(false);
      setRejectReason('');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div>
      <div className="mc-drawer-subject">
        <span className={wuStatusClass(deriveWuColumn(wu))}>
          {deriveWuColumn(wu) === 'active' ? <span className="mc-dot" /> : null}
          {WU_STATUS_LABELS[deriveWuColumn(wu)] ?? deriveWuColumn(wu)}
        </span>
        <SelfReviewBadge wu={wu} />
        <span className="mc-drawer-subject-title">{title}</span>
      </div>

      {/* #290（清单 #24）：负责人解析为角色名并链角色页（与详情页同一 hook 口径），查不到回退短 UUID */}
      <div className="mc-kv"><span className="mc-kv-k">负责人</span><span className="mc-kv-v">{wu.assigneeId ? <AssigneeLabel assigneeId={wu.assigneeId} className="mc-wu-link" /> : '—'}</span></div>
      <div className="mc-kv">
        <span className="mc-kv-k">所属 REQ</span>
        <span className="mc-kv-v">
          {wu.reqId
            ? <button className="mc-wu-link" onClick={() => onOpenReq(wu.reqId!)}>{wu.reqId} ›</button>
            : '—'}
        </span>
      </div>
      {/* #275（#251 断点2）：WU→频道 反向链路在抽屉侧补齐（与 WU 详情页归属条频道 chip 同语义，
          取数路径不同：详情页 list().find、此处 channelApi.get 单取）。
          跳频道页属页面级跳转，走 react-router，不走抽屉回调 */}
      {wu.channelId && (
        <div className="mc-kv">
          <span className="mc-kv-k">所属频道</span>
          <span className="mc-kv-v">
            <button
              className="mc-wu-link"
              onClick={() => navigate(`/channels/${wu.channelId}`)}
              title="回频道（需求讨论现场）"
            >
              #{channelName ?? `${wu.channelId.slice(0, 8)}…`}
            </button>
          </span>
        </div>
      )}
      <div className="mc-kv"><span className="mc-kv-k">类型</span><span className="mc-kv-v">{wu.type}</span></div>
      {typeof meta.stepCount === 'number' && (
        <div className="mc-kv"><span className="mc-kv-k">已执行步数</span><span className="mc-kv-v">{meta.stepCount}</span></div>
      )}
      <div className="mc-kv"><span className="mc-kv-k">重试次数</span><span className="mc-kv-v">{wu.retryCount}</span></div>
      <div className="mc-kv"><span className="mc-kv-k">创建</span><span className="mc-kv-v">{formatShortTime(wu.createdAt)}</span></div>
      {wu.claimedAt && <div className="mc-kv"><span className="mc-kv-k">认领</span><span className="mc-kv-v">{formatShortTime(wu.claimedAt)}</span></div>}
      {wu.completedAt && <div className="mc-kv"><span className="mc-kv-k">完成</span><span className="mc-kv-v">{formatShortTime(wu.completedAt)}</span></div>}

      {/* F6 证据台账：L1 自动验证 / L2 Agent 评审 / L3 人工验收 三层留痕（共享 EvidenceLedger，卡片变体见 WorkUnitDetailPage）。
          语义：L2 是流程硬门（过了即推进）；L3 是人工背书台账，不阻断流程（done 缺 l3 时展示回审查列）。 */}
      <EvidenceLedger attestations={attestations} variant="drawer" />
      {wu.status === 'pending' && (
        <div style={{ margin: '4px 0 8px' }}>
          <button
            className="mc-wu-link"
            disabled={confirming}
            title="待确认人闸：扩范围单创建落待确认，确认后进入待认领（agent 可见可认领）"
            onClick={handleConfirmPending}
          >
            {confirming ? '提交中…' : '确认（进待认领）'}
          </button>
        </div>
      )}
      {wu.status === 'in_review' && (
        <div style={{ margin: '4px 0 8px', display: 'flex', gap: 8 }}>
          <button
            className="mc-wu-link"
            disabled={confirming}
            title="审查硬门：通过→done（analysis 通过后按 TASK 拆分自动派工）"
            onClick={handleApprove}
          >
            {confirming ? '提交中…' : '通过（审查闸门）'}
          </button>
          {/* #284：拒绝入口补齐（带原因弹窗），与列表行/WU 详情页三处一致 */}
          <button
            className="mc-wu-link"
            disabled={confirming}
            title="审查硬门：拒绝→返工（附原因供 agent 修正）"
            onClick={() => setShowRejectModal(true)}
          >
            拒绝
          </button>
        </div>
      )}
      {wu.status === 'done' && derived.needsHuman && (
        <div style={{ margin: '4px 0 8px' }}>
          <button
            className="mc-wu-link"
            disabled={confirming}
            title="流程已由 Agent 评审推进完成；此确认为 L3 人工验收留痕，不阻断流程，确认后出审查列"
            onClick={handleApprove}
          >
            {confirming ? '提交中…' : '人工验收确认（L3 留痕）'}
          </button>
        </div>
      )}
      {showApproveModal && (
        <AnalysisApproveDialog
          prefill={buildMapOpeningPrefill(wu.metadata)}
          channelId={wu.channelId}
          onConfirm={(summary, assigneeId) => { setShowApproveModal(false); handleReviewPassed(summary, assigneeId); }}
          onCancel={() => setShowApproveModal(false)}
        />
      )}

      {/* #284：审查拒绝弹窗（带原因），与列表行同款 */}
      {showRejectModal && (
        <div className="modal-overlay" onClick={() => setShowRejectModal(false)}>
          <div className="modal" style={{ maxWidth: '24rem' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">拒绝原因</h3>
              <button className="modal-close" onClick={() => setShowRejectModal(false)} aria-label="关闭">×</button>
            </div>
            <div className="modal-body">
              <textarea
                className="input w-full"
                rows={3}
                placeholder="输入拒绝原因（可选）"
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
              />
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
              >
                取消
              </button>
              <button
                className="btn btn-danger"
                disabled={confirming}
                onClick={handleReviewRejected}
              >
                确认拒绝
              </button>
            </div>
          </div>
        </div>
      )}

      {/* #185（决策 #87 D4）：blocked 处置组件（继续执行/关闭任务），与详情页同一组件；
          动作成功后重拉一次详情兜底（状态变化另有 status_changed SSE 负载直更） */}
      <BlockedActions wu={wu} onChanged={() => {
        workunitApi.get(id).then(r => setWu(r.data)).catch(() => {});
      }} />

      {/* WU 过程可视化：执行步事件流（思考/工具调用/skill 注入/用量），SSE 步级刷新。
          频道只留里程碑，过程明细在这里；完整 transcript（会话原文）见 WU 详情页 TranscriptViewer（#174）。
          #182：传 wu 启用置顶「当前状态速览」节（决策 #61 速览档，与详情页同组件复用）。 */}
      <ExecutionSteps workUnitId={id} wu={wu} />

      {wu.status === 'blocked' && meta.waitingForInput && meta.waitingQuestion && (
        <>
          <div className="mc-block-label">等待人类回复</div>
          <div className="mc-need-q">{meta.waitingQuestion}</div>
        </>
      )}

      <div className="mc-block-label">token 开销（本 WorkUnit）</div>
      {tokens === null && <div className="mc-drawer-note">加载中…</div>}
      {tokens !== null && tokens.length === 0 && (
        <div className="mc-drawer-note">窗口内无 token 度量事件</div>
      )}
      {tokens !== null && tokens.length > 0 && (
        <div className="mc-tokenbar">
          <div className="mc-tokenbar-row">
            <span className="mc-tokenbar-label">注入</span>
            <span className="mc-tokenbar-track">
              <span className="mc-tokenbar-fill" style={{ display: 'block', width: `${(injectedSum / maxBar) * 100}%`, background: 'var(--warning)' }} />
            </span>
            <span className="mc-tokenbar-val">{formatTokens(injectedSum)}</span>
          </div>
          <div className="mc-tokenbar-row">
            <span className="mc-tokenbar-label">执行</span>
            <span className="mc-tokenbar-track">
              <span className="mc-tokenbar-fill" style={{ display: 'block', width: `${(execSum / maxBar) * 100}%`, background: 'var(--accent-primary)' }} />
            </span>
            <span className="mc-tokenbar-val">
              {execKnown.length > 0 ? formatTokens(execSum) : '—'}
            </span>
          </div>
          <div className="mc-tokenbar-row">
            <span className="mc-tokenbar-label">合计</span>
            <span className="mc-tokenbar-track">
              <span className="mc-tokenbar-fill" style={{ display: 'block', width: '100%', background: 'var(--border-default)' }} />
            </span>
            <span className="mc-tokenbar-val">{formatTokens(totalSum)}</span>
          </div>
          <div className="mc-drawer-note">
            {tokens.length} 次执行
            {execKnown.length < tokens.length ? ` · ${tokens.length - execKnown.length} 次 CLI 未回报 usage` : ''}
          </div>
        </div>
      )}

      <div className="mc-block-label">
        树级 token 开销
        <button
          className="mc-wu-link"
          style={{ marginLeft: 'auto' }}
          onClick={() => setShowTreeTokens(s => !s)}
        >
          {showTreeTokens ? '收起' : '展开'}
        </button>
      </div>
      {showTreeTokens && <TreeTokenDrawer workUnitId={id} onClose={() => setShowTreeTokens(false)} />}

      {overhead && (
        <>
          <div className="mc-block-label">封装开销 vs 直连（近 {overhead.windowDays} 天全局）</div>
          {overhead.source === 'insufficient-data' ? (
            <div className="mc-drawer-note">窗口内度量数据不足</div>
          ) : (
            <div className="mc-tokenbar">
              <div className="mc-redline">
                <span>
                  封装开销 {overhead.avgOverheadRatio !== null ? `${overhead.avgOverheadRatio.toFixed(2)}x` : '—'}（直连 1.0x）
                </span>
                <span className={overhead.avgOverheadRatio !== null && overhead.avgOverheadRatio <= overhead.overheadBudget ? 'mc-redline-ok' : 'mc-redline-breach'}>
                  红线 {overhead.overheadBudget}x {overhead.avgOverheadRatio !== null && overhead.avgOverheadRatio <= overhead.overheadBudget ? '✓' : '✗'}
                </span>
              </div>
              <div className="mc-redline">
                <span>注入均值 {formatTokens(Math.round(overhead.avgInjectedTokens))}</span>
                <span className={overhead.injectedBudgetUsedPct <= 100 ? 'mc-redline-ok' : 'mc-redline-breach'}>
                  预算 {formatTokens(overhead.injectedBudget)}（{Math.round(overhead.injectedBudgetUsedPct)}%）
                </span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── REQ 全链路 ──

function ReqChain({ id, onOpenWu }: { id: string; onOpenWu: (wuId: string) => void }) {
  const [chain, setChain] = useState<RequirementChain | null>(null);
  const [error, setError] = useState('');

  // id 切换时在渲染期同步清空旧链路（替代原 effect 顶部的同步重置）
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setChain(null);
    setError('');
  }

  useEffect(() => {
    let alive = true;
    requirementApi.getChain(id)
      .then(r => { if (alive) setChain(r.data.data); })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id]);

  if (error) return <div className="mc-drawer-note">加载失败: {error}</div>;
  if (!chain) return <div className="mc-drawer-note">加载中…</div>;

  const req = chain.requirement;
  return (
    <div>
      <div className="mc-drawer-subject">
        <span className="mc-status mc-status-need">{REQ_STATUS_LABELS[req.status] ?? req.status}</span>
        <span className="mc-drawer-subject-title">{req.title}</span>
      </div>
      <div className="mc-kv"><span className="mc-kv-k">编号</span><span className="mc-kv-v">{req.id}</span></div>
      <div className="mc-kv"><span className="mc-kv-k">创建</span><span className="mc-kv-v">{formatShortTime(req.createdAt)}</span></div>
      <div className="mc-kv"><span className="mc-kv-k">来源</span><span className="mc-kv-v">{req.createdBy}</span></div>
      {req.description && <p className="mc-drawer-desc">{req.description}</p>}
      {req.docs && req.docs.length > 0 && (
        <>
          <div className="mc-block-label">关联文档</div>
          <ul className="mc-docs">
            {req.docs.map(d => <li key={d} className="mc-doc-item">{d}</li>)}
          </ul>
        </>
      )}

      <div className="mc-block-label">WorkUnit 链路（{chain.workunits.length}）</div>
      {chain.workunits.length === 0 && <div className="mc-drawer-note">暂无关联 WorkUnit</div>}
      {chain.workunits.map((wu, i) => (
        <div key={wu.id}>
          {i > 0 && <div className="mc-chain-arrow">↓</div>}
          <button className="mc-chain-node" onClick={() => onOpenWu(wu.id)}>
            <div className="mc-chain-node-top">
              <span className={wuStatusClass(deriveWuColumn(wu))}>
                {deriveWuColumn(wu) === 'active' ? <span className="mc-dot" /> : null}
                {WU_STATUS_LABELS[deriveWuColumn(wu)] ?? deriveWuColumn(wu)}
              </span>
              <span className="mc-mono">{wu.id}</span>
              {wu.assigneeId && <AssigneeLabel assigneeId={wu.assigneeId} className="mc-dim" style={{ marginLeft: 'auto' }} />}
            </div>
            <div className="mc-chain-node-title">{wu.title}</div>
          </button>
        </div>
      ))}
    </div>
  );
}
