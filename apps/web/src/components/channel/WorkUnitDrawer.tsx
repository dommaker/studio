// WorkUnitDrawer — Mission Control 右抽屉：WorkUnit 详情 / REQ 全链路
// 只展示真实 API 数据（workunitApi / requirementApi / monitoringApi），无对应数据的维度不展示、不编造
import { useEffect, useState } from 'react';
import {
  workunitApi,
  parseWorkunitTokenEvents,
  type WorkUnit,
  type WorkunitTokenEvent,
} from '../../api/workunit';
import { requirementApi, type RequirementChain } from '../../api/requirements';
import { monitoringApi, type OverheadStats } from '../../api/monitoring';
import { useWorkUnitEvents } from '../../hooks/useWorkUnitEvents';
import { ExecutionSteps } from '../workunit/ExecutionSteps';
import { TreeTokenDrawer } from '../workunit/TreeTokenDrawer';
import { SelfReviewBadge } from '../workunit/SelfReviewBadge';
import { EvidenceLedger } from '../workunit/EvidenceLedger';
import { AnalysisApproveDialog } from '../pmo/AnalysisApproveDialog';
import { buildMapOpeningPrefill } from '../pmo/mapUtils';
import { deriveDisplayState, parseAttestations } from '@dommaker/studio-shared/web';

export type DrawerState = { kind: 'wu'; id: string } | { kind: 'req'; id: string } | null;

const REQ_STATUS_LABELS: Record<string, string> = {
  open: '未开始',
  'in-progress': '进行中',
  done: '已完成',
  archived: '已归档',
};

const WU_STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
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

function parseMeta(metadata: string | null): WuMeta {
  try { return JSON.parse(metadata || '{}'); } catch { return {}; }
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
          ? <WuDetail id={drawer.id} onOpenReq={onOpenReq} />
          : <ReqChain id={drawer.id} onOpenWu={onOpenWu} />}
      </div>
    </aside>
  );
}

// ── WorkUnit 详情 ──

function WuDetail({ id, onOpenReq }: { id: string; onOpenReq: (reqId: string) => void }) {
  const [wu, setWu] = useState<WorkUnit | null>(null);
  const [tokens, setTokens] = useState<WorkunitTokenEvent[] | null>(null);
  const [overhead, setOverhead] = useState<OverheadStats | null>(null);
  const [error, setError] = useState('');
  const [showTreeTokens, setShowTreeTokens] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // #106 M7：analysis 通过/确认弹窗（共享件），非 analysis 保持一键通过
  const [showApproveModal, setShowApproveModal] = useState(false);
  // WU 事件（SSE）：状态变化/执行步事件时重拉详情（认领/审查/完成/执行过程即时可见）
  const [eventTick, setEventTick] = useState(0);
  useWorkUnitEvents(() => setEventTick(t => t + 1));

  // 渲染期按 id 重置（替代原 effect 内同步重置）：SSE eventTick 触发的重拉不再重置，
  // 消除每次事件都闪"加载中…"的骨架闪烁——事件刷新静默进行，旧数据留到新数据到达
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setWu(null);
    setTokens(null);
    setError('');
  }

  useEffect(() => {
    let alive = true;
    workunitApi.get(id)
      .then(r => { if (alive) { setWu(r.data); setError(''); } })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    workunitApi.listTokenEvents()
      .then(r => { if (alive) setTokens(parseWorkunitTokenEvents(r.data.events || [], id)); })
      .catch(() => { if (alive) setTokens([]); });
    monitoringApi.getOverhead()
      .then(r => { if (alive) setOverhead(r.data); })
      .catch(() => {});
    return () => { alive = false; };
  }, [id, eventTick]);

  if (error) return <div className="mc-drawer-note">加载失败: {error}</div>;
  if (!wu) return <div className="mc-drawer-note">加载中…</div>;

  const meta = parseMeta(wu.metadata);
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
   *  done 缺 l3 = L3 人工验收留痕（不阻断流程）。同调 reviewPassed（服务端幂等）。 */
  const handleReviewPassed = async (summary?: string, assigneeId?: string) => {
    setConfirming(true);
    try {
      await workunitApi.reviewPassed(id, summary, assigneeId);
      setEventTick(t => t + 1);
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
      await workunitApi.transitionStatus(id, 'unassigned');
      setEventTick(t => t + 1);
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

      <div className="mc-kv"><span className="mc-kv-k">负责人</span><span className="mc-kv-v">{wu.assigneeId ? `@${wu.assigneeId}` : '—'}</span></div>
      <div className="mc-kv">
        <span className="mc-kv-k">所属 REQ</span>
        <span className="mc-kv-v">
          {wu.reqId
            ? <button className="mc-wu-link" onClick={() => onOpenReq(wu.reqId!)}>{wu.reqId} ›</button>
            : '—'}
        </span>
      </div>
      <div className="mc-kv"><span className="mc-kv-k">类型</span><span className="mc-kv-v">{wu.type}</span></div>
      {typeof meta.stepCount === 'number' && (
        <div className="mc-kv"><span className="mc-kv-k">已执行步数</span><span className="mc-kv-v">{meta.stepCount}</span></div>
      )}
      <div className="mc-kv"><span className="mc-kv-k">重试次数</span><span className="mc-kv-v">{wu.retryCount}</span></div>
      <div className="mc-kv"><span className="mc-kv-k">创建</span><span className="mc-kv-v">{formatTime(wu.createdAt)}</span></div>
      {wu.claimedAt && <div className="mc-kv"><span className="mc-kv-k">认领</span><span className="mc-kv-v">{formatTime(wu.claimedAt)}</span></div>}
      {wu.completedAt && <div className="mc-kv"><span className="mc-kv-k">完成</span><span className="mc-kv-v">{formatTime(wu.completedAt)}</span></div>}

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
        <div style={{ margin: '4px 0 8px' }}>
          <button
            className="mc-wu-link"
            disabled={confirming}
            title="审查硬门：通过→done（analysis 通过后按 TASK 拆分自动派工）；拒绝请在列表行操作"
            onClick={handleApprove}
          >
            {confirming ? '提交中…' : '通过（审查闸门）'}
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
      <div className="mc-kv"><span className="mc-kv-k">创建</span><span className="mc-kv-v">{formatTime(req.createdAt)}</span></div>
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
              {wu.assigneeId && <span className="mc-dim" style={{ marginLeft: 'auto' }}>@{wu.assigneeId.slice(0, 8)}</span>}
            </div>
            <div className="mc-chain-node-title">{wu.title}</div>
          </button>
        </div>
      ))}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}
