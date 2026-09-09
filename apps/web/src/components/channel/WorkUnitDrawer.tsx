// WorkUnitDrawer — Mission Control 右抽屉：WorkUnit 详情 / REQ 全链路
// 只展示真实 API 数据（workunitApi / requirementApi / monitoringApi / channelApi），无对应数据的维度不展示、不编造
// 2026-09 页面重设计 E2（docs/plans/2026-09-page-redesign.md）：列表页行点击同挂本抽屉（props 自包含自取数）；
// 闸门动作合一走 WuGateActions；ReviewHint（in_review 且频道无 reviewer）自列表展开区挪入闸门动作区上方；
// ExecutionSteps 后补「会话原文」折叠节（TranscriptViewer，原详情页独有）。
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  workunitApi,
  parseWorkunitTokenEvents,
  type WorkUnit,
  type WorkunitTokenEvent,
} from '../../api/workunit';
import { useRequirementChainStore } from '../../stores/requirementChainStore';
import { monitoringApi, type OverheadStats } from '../../api/monitoring';
import { channelApi, type AgentProfile } from '../../api/channel';
import { useWebSocketContext } from '../../api/websocketHooks';
import { ExecutionSteps } from '../workunit/ExecutionSteps';
import { BlockedActions } from '../workunit/BlockedActions';
import { TreeTokenDrawer } from '../workunit/TreeTokenDrawer';
import { SelfReviewBadge } from '../workunit/SelfReviewBadge';
import { EvidenceLedger } from '../workunit/EvidenceLedger';
import { ReviewHint } from '../workunit/ReviewHint';
import { WuGateActions } from '../workunit/WuGateActions';
import { TranscriptViewer } from '../workunit/TranscriptViewer';
import { deriveDisplayState, parseAttestations, WU_STATUS_LABELS, formatChannelName } from '@dommaker/studio-shared/web';
import { AssigneeLabel } from '../workunit/AssigneeLabel';
import { formatShortTime } from '../../utils/datetime';
import { parseWuMeta } from '../../utils/wuMeta';
import { errorMessage } from '../../utils/errorMessage';

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
        {/* #395（spec §4.6）：<768 抽屉全屏化的左上返回（≥768 CSS 隐藏，DOM 常驻） */}
        <button className="mc-drawer-back" aria-label="返回" onClick={onClose}>← 返回</button>
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
  // E2-1：ReviewHint 自列表展开区挪入——频道成员（in_review 时判断是否有人可认领评审）；
  // null = 未拉到（含 best-effort 失败）→ 不渲染提醒（空数组会误报「无人可认领」）
  const [channelMembers, setChannelMembers] = useState<AgentProfile[] | null>(null);
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
    setChannelMembers(null);
    setError('');
    setNotFound(false);
  }

  // 开抽屉一次性打底：WU 详情（+ 频道名/频道成员 best-effort）
  useEffect(() => {
    let alive = true;
    workunitApi.get(id)
      .then(r => {
        if (!alive) return;
        setWu(r.data);
        setError('');
        if (r.data.channelId) {
          // #275（#251 断点2）：频道名 best-effort（频道已删/无权限时保留 null，链接退回 id 截短）
          channelApi.get(r.data.channelId)
            .then(res => { if (alive) setChannelName(res.data.data.name); })
            .catch(() => { /* best-effort */ });
          // E2-1：ReviewHint 频道成员判断（best-effort；失败留 null 不渲染提醒，防误报）
          channelApi.listAgents(r.data.channelId)
            .then(res => { if (alive) setChannelMembers(res.data.data); })
            .catch(() => { /* best-effort */ });
        }
      })
      .catch(e => {
        if (!alive) return;
        if (axios.isAxiosError(e) && e.response?.status === 404) setNotFound(true);
        // 批次A 项6：错误文案走 errorMessage 正本（服务端 error.message 优先，不再直拼 axios 裸 message）
        else setError(errorMessage(e));
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
  const attestations = parseAttestations(wu.metadata);
  const injectedSum = (tokens ?? []).reduce((s, t) => s + t.injectedTokens, 0);
  const execKnown = (tokens ?? []).filter(t => t.executionTokens !== null);
  const execSum = execKnown.reduce((s, t) => s + (t.executionTokens ?? 0), 0);
  const totalSum = (tokens ?? []).reduce((s, t) => s + t.totalTokens, 0);
  const maxBar = Math.max(totalSum, 1);

  /** E2-4：闸门动作写路径 = 直调 API + 响应体直替本地 wu（决策 8；状态变化另有 status_changed SSE 兜底），
   *  分支/锁存/错误内联/弹窗全部在共享 WuGateActions（与列表行/详情页同一组件） */
  const gateActions = (
    <WuGateActions
      wu={wu}
      autoApprove={autoApprove}
      onReviewPassed={async (summary, assigneeId) => { const r = await workunitApi.reviewPassed(id, summary, assigneeId); setWu(r.data); }}
      onReviewRejected={async (reason) => { const r = await workunitApi.reviewRejected(id, reason); setWu(r.data); }}
      onConfirmPending={async () => { const r = await workunitApi.transitionStatus(id, 'unassigned'); setWu(r.data); }}
    />
  );

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
              {formatChannelName(channelName ?? `${wu.channelId.slice(0, 8)}…`)}
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
      {/* E2-1：ReviewHint（in_review 且频道无 reviewer 提醒）自列表展开区挪入闸门动作区上方；
          onSetupClick 按 E8-3 改链 /agents；成员未拉到（null）不渲染防误报 */}
      {channelMembers !== null && (
        <ReviewHint
          status={wu.status}
          channelMembers={channelMembers}
          onSetupClick={() => navigate('/agents')}
        />
      )}
      {/* E2-4：闸门动作 = 共享 WuGateActions（pending 确认 / in_review 通过+拒绝 / done 人工确认留痕） */}
      <div style={{ margin: '4px 0 8px' }}>{gateActions}</div>

      {/* #185（决策 #87 D4）：blocked 处置组件（继续执行/关闭任务），与详情页同一组件；
          动作成功后重拉一次详情兜底（状态变化另有 status_changed SSE 负载直更） */}
      <BlockedActions wu={wu} onChanged={() => {
        workunitApi.get(id).then(r => setWu(r.data)).catch(() => {});
      }} />

      {/* WU 过程可视化：执行步事件流（思考/工具调用/skill 注入/用量），SSE 步级刷新。
          频道只留里程碑，过程明细在这里。
          #182：传 wu 启用置顶「当前状态速览」节（决策 #61 速览档，与详情页同组件复用）。 */}
      <ExecutionSteps workUnitId={id} wu={wu} />

      {/* E2-2：「会话原文」折叠节（复用详情页 TranscriptViewer，默认折叠不请求）——
          处置 blocked/待验收时不再必须跳详情页看原文 */}
      <TranscriptViewer workUnitId={id} />

      {wu.status === 'blocked' && meta.waitingForInput && meta.waitingQuestion && (
        <>
          <div className="mc-block-label">等待人类回复</div>
          <div className="mc-need-q">{meta.waitingQuestion}</div>
        </>
      )}

      <div className="mc-block-label">token 开销（本任务）</div>
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
  // #412：链路读 requirementChainStore（与右栏/面板/项目页共享单份缓存；status_changed 就地更新）
  const chain = useRequirementChainStore((s) => s.chains[id]);
  const error = useRequirementChainStore((s) => s.errors[id]);

  useEffect(() => {
    void useRequirementChainStore.getState().ensureChain(id);
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

      <div className="mc-block-label">任务链路（{chain.workunits.length}）</div>
      {chain.workunits.length === 0 && <div className="mc-drawer-note">暂无关联任务</div>}
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
