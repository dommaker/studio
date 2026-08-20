// WorkUnitDetailPage — /workunits/:id WU 详情页（全站跳转枢纽，2026-07 agents-pmo-flow-ux §5.4）
// 自上而下：Header（类型+状态+标题+时间+failureType）→ 归属条（PMO/REQ/频道/认领 agent 四回跳）
// → 证据台账 L1/L2/L3（与 WorkUnitDrawer 同一数据路径：deriveDisplayState / parseAttestations）
// → 执行过程（复用 ExecutionSteps，自带 REST 回放 + 实时流）→ 会话原文（#174 TranscriptViewer）→ 讨论区（复用 DiscussionPanel）
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deriveDisplayState, parseAttestations } from '@dommaker/studio-shared/web';
import { workunitApi, type Opportunity, type WorkUnit } from '../api/workunit';
import { requirementApi } from '../api/requirements';
import { projectApi } from '../api/index';
import { channelApi } from '../api/channel';
import { monitoringApi } from '../api/monitoring';
import { ExecutionSteps } from '../components/workunit/ExecutionSteps';
import { BlockedActions } from '../components/workunit/BlockedActions';
import { TranscriptViewer } from '../components/workunit/TranscriptViewer';
import { DiscussionPanel } from '../components/DiscussionPanel';
import { RequirementChainPanel } from '../components/requirement/RequirementChainPanel';
import { SelfReviewBadge } from '../components/workunit/SelfReviewBadge';
import { TreeTokenDrawer } from '../components/workunit/TreeTokenDrawer';
import { EvidenceLedger } from '../components/workunit/EvidenceLedger';
import { OpportunitiesPanel } from '../components/workunit/OpportunitiesPanel';
import { BlockedByList } from '../components/workunit/BlockedByList';
import { parseBlockedBy, buildMapOpeningPrefill } from '../components/pmo/mapUtils';
import { AnalysisApproveDialog } from '../components/pmo/AnalysisApproveDialog';

const statusLabels: Record<string, string> = {
  pending: '待确认',
  unassigned: '待分配',
  active: '执行中',
  in_review: '审查中',
  done: '已完成',
  closed: '已关闭',
  blocked: '阻塞',
};

const statusColors: Record<string, string> = {
  pending: 'u-warn-dim u-warn',
  unassigned: 'u-surface-2 u-text-3',
  active: 'u-accent-dim u-accent',
  in_review: 'u-warn-dim u-warn',
  done: 'u-ok-dim u-ok',
  closed: 'u-ok-dim u-ok',
  blocked: 'u-err-dim u-err',
};

const typeLabels: Record<string, string> = {
  task: '任务',
  monitor: '监控',
  analysis: '分析',
  discussion: '讨论',
};

interface PmoInfo {
  id: string;
  pmoNumber: string;
  title: string;
}

function parseMeta(metadata: string | null): Record<string, unknown> {
  try { return JSON.parse(metadata || '{}') as Record<string, unknown>; } catch { return {}; }
}

/** 归属条 PMO 解析（2026-08 归因统一）：① 创建期归因戳 metadata.pmoId（‖ deprecated legacy ownershipProjectId 同级）直查；② 否则 reqId → requirement.projectId（REQ 别名视图 projectId = PMO 自身 id） */
async function resolvePmo(wu: WorkUnit): Promise<PmoInfo | null> {
  const meta = parseMeta(wu.metadata);
  const stamp = meta.pmoId ?? meta.ownershipProjectId;
  let projectId = typeof stamp === 'string' && stamp ? stamp : null;
  if (!projectId && wu.reqId) {
    try {
      const reqRes = await requirementApi.get(wu.reqId);
      projectId = reqRes.data.data.projectId ?? null;
    } catch { return null; }
  }
  if (!projectId) return null;
  try {
    const res = await projectApi.get(projectId);
    const p = res.data as { id?: unknown; pmoNumber?: unknown; title?: unknown };
    if (typeof p.id !== 'string' || typeof p.pmoNumber !== 'string') return null;
    return { id: p.id, pmoNumber: p.pmoNumber, title: typeof p.title === 'string' ? p.title : '' };
  } catch { return null; }
}

export function WorkUnitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [wu, setWu] = useState<WorkUnit | null>(null);
  const [error, setError] = useState('');
  const [pmo, setPmo] = useState<PmoInfo | null>(null);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<{ name: string; roleId: string } | null>(null);
  const [chainReqId, setChainReqId] = useState<string | null>(null);
  const [showTreeTokens, setShowTreeTokens] = useState(false);
  // #185：blocked 处置动作成功后 +1 触发重拉详情
  const [actionTick, setActionTick] = useState(0);
  // #284（决策 #250 D1/F7-F9）：闸门入口补齐——pending 确认 / in_review 通过+拒绝（拒绝带原因）
  const [confirming, setConfirming] = useState(false);
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  // id 切换时在渲染期同步清空上一 WU 的全部展示数据（替代原 effect 顶部的五处同步重置）
  const [prevId, setPrevId] = useState(id);
  if (prevId !== id) {
    setPrevId(id);
    setWu(null);
    setError('');
    setPmo(null);
    setChannelName(null);
    setAssignee(null);
  }

  useEffect(() => {
    if (!id) return;
    let alive = true;
    workunitApi.get(id)
      .then(r => {
        if (!alive) return;
        const unit = r.data;
        setWu(unit);
        // 归属解析全部 best-effort 并行：解析不到就不显示对应 chip，不阻塞页面
        resolvePmo(unit).then(p => { if (alive) setPmo(p); });
        if (unit.channelId) {
          channelApi.list()
            .then(res => {
              if (!alive) return;
              setChannelName(res.data.data.find(c => c.id === unit.channelId)?.name ?? null);
            })
            .catch(() => { /* best-effort */ });
        }
        if (unit.assigneeId) {
          // assigneeId 是 instance id：按 id 匹配 /monitoring/agents 拿角色名与 roleId
          monitoringApi.getAgentSummary()
            .then(res => {
              if (!alive) return;
              const a = res.data.agents.find(a => a.id === unit.assigneeId);
              setAssignee(a ? { name: a.name, roleId: a.roleId } : null);
            })
            .catch(() => { /* best-effort */ });
        }
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id, actionTick]);

  const handleBack = () => {
    // 有站内历史则后退，否则回 /workunits（深链直达场景）
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof idx === 'number' && idx > 0) navigate(-1);
    else navigate('/workunits');
  };

  const meta = wu ? parseMeta(wu.metadata) : {};
  // #116：依赖（blockedBy）与验收标准（ac）展示数据
  const blockedByIds = wu ? parseBlockedBy(wu.metadata) : [];
  const acList = Array.isArray(meta.ac)
    ? (meta.ac as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  // #163 T8-E2: 采纳/忽略机会后重拉 WU（走与首屏相同的 workunitApi.get 路径，只刷新 wu 本体）
  const reloadWu = () => {
    if (!id) return;
    workunitApi.get(id)
      .then(r => setWu(r.data))
      .catch(() => { /* best-effort：失败时清单保持旧态，下轮手动刷新 */ });
  };
  const title = wu ? (typeof meta.title === 'string' && meta.title ? meta.title : wu.scope) : '';

  /** #284：闸门动作统一经 actionTick 重拉详情（与 BlockedActions.onChanged 同一路径） */
  const runGateAction = async (fn: () => Promise<unknown>) => {
    setConfirming(true);
    try {
      await fn();
      setActionTick(t => t + 1);
    } finally {
      setConfirming(false);
    }
  };
  // #126（T4）待确认人闸：确认 → unassigned 进 frontier 可认领（与频道抽屉同行为）
  const handleConfirmPending = () => id && runGateAction(() => workunitApi.transitionStatus(id, 'unassigned'));
  // 审查硬门：通过→done（analysis 走确认弹窗，预填待决问题清单随 summary 回传开图）
  const handleReviewPassed = (summary?: string, assigneeId?: string) =>
    id && runGateAction(() => workunitApi.reviewPassed(id, summary, assigneeId));
  const handleApprove = () => wu && (wu.type === 'analysis' ? setShowApproveModal(true) : handleReviewPassed());
  const handleReviewRejected = () => {
    if (!id) return;
    runGateAction(() => workunitApi.reviewRejected(id, rejectReason.trim() || undefined));
    setShowRejectModal(false);
    setRejectReason('');
  };
  // F6 派生（铁律：徽章/证据判断一律过 deriveDisplayState，不自行解释 attestations）
  const derived = wu ? deriveDisplayState({ status: wu.status, metadata: wu.metadata }) : null;
  const attestations = wu ? parseAttestations(wu.metadata) : undefined;

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-8 py-6" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            {wu && derived && (
              <>
                <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2 flex-shrink-0">
                  {typeLabels[wu.type] ?? wu.type}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${statusColors[derived.column] || 'u-surface-2 u-text-3'}`}>
                  {statusLabels[derived.column] ?? derived.column}
                </span>
                <SelfReviewBadge wu={wu} />
              </>
            )}
            <h1 className="page-title truncate">{wu ? title : 'WorkUnit 详情'}</h1>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {wu && (
              <button
                className="btn btn-secondary"
                onClick={() => setShowTreeTokens(true)}
                title="查看整条协作树各节点的 Token 消耗与预算剩余"
              >
                Token 开销
              </button>
            )}
            <button className="btn btn-secondary flex-shrink-0" onClick={handleBack}>返回</button>
          </div>
        </div>
        {wu && (
          <p className="page-subtitle">
            创建 {formatTime(wu.createdAt)}
            {wu.claimedAt && ` · 认领 ${formatTime(wu.claimedAt)}`}
            {wu.completedAt && ` · 完成 ${formatTime(wu.completedAt)}`}
          </p>
        )}
        {wu?.failureType && (
          <div className="mt-2 text-xs u-err">失败类型：{wu.failureType}</div>
        )}
      </div>

      <div className="flex-1 overflow-auto px-8 pb-8">
        <div className="max-w-5xl">
          {error ? (
            <div className="mt-4 p-3 rounded u-err-dim u-err text-sm">加载失败: {error}</div>
          ) : !wu || !derived ? (
            <div className="text-center py-20 u-text-2">加载中...</div>
          ) : (
            <>
              {/* 归属条（核心，四个跳转） */}
              {(pmo || wu.reqId || wu.channelId || wu.assigneeId) && (
                <div
                  className="card mt-4 p-3 flex items-center gap-2 flex-wrap"
                >
                  <span className="text-xs u-text-3">归属</span>
                  {pmo && (
                    <Link
                      to={`/pmo/project/${pmo.id}`}
                      className="text-xs px-2 py-0.5 rounded u-accent-dim u-accent u-hover-bg"
                      title="所属 PMO 项目"
                    >
                      {pmo.pmoNumber} · {pmo.title}
                    </Link>
                  )}
                  {wu.reqId && (
                    <button
                      className="text-xs px-2 py-0.5 rounded u-accent-dim u-accent u-hover-bg"
                      title="查看 REQ 全链路"
                      onClick={() => setChainReqId(wu.reqId ?? null)}
                    >
                      {wu.reqId}
                    </button>
                  )}
                  {wu.channelId && (
                    <Link
                      to={`/channels/${wu.channelId}`}
                      className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3 u-hover-bg"
                      title="所在频道"
                    >
                      # {channelName ?? `${wu.channelId.slice(0, 8)}...`}
                    </Link>
                  )}
                  {wu.assigneeId && (
                    assignee ? (
                      <Link
                        to={`/agents/${assignee.roleId}`}
                        className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3 u-hover-bg"
                        title="认领 Agent"
                      >
                        @{assignee.name}
                      </Link>
                    ) : (
                      <span
                        className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-3"
                        title="认领 Agent（实例不在当前运行列表，无法定位角色）"
                      >
                        @{wu.assigneeId.slice(0, 8)}
                      </span>
                    )
                  )}
                </div>
              )}

              {/* #163 T8-E2 巡检机会清单（metadata.opportunities 非空数组才渲染） */}
              {Array.isArray(meta.opportunities) && (meta.opportunities as Opportunity[]).length > 0 && (
                <OpportunitiesPanel
                  workUnitId={wu.id}
                  opportunities={meta.opportunities as Opportunity[]}
                  onChanged={reloadWu}
                />
              )}

              {/* #116：依赖与验收（blockedBy 依赖清单含各自状态 + ac 验收标准；两者皆无则不渲染） */}
              {(blockedByIds.length > 0 || acList.length > 0) && (
                <div className="card mt-4 p-3">
                  <h3 className="text-sm font-medium u-text-2 mb-2">依赖与验收</h3>
                  <BlockedByList metadata={wu.metadata} />
                  {acList.length > 0 && (
                    <div className={blockedByIds.length > 0 ? 'mt-2' : ''}>
                      <span className="text-xs u-text-2">验收标准（{acList.length}）</span>
                      <ul className="mt-1 space-y-1 text-xs u-text-3 list-disc pl-4">
                        {acList.map((ac, i) => <li key={i}>{ac}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* F6 证据台账：L1 自动验证 / L2 Agent 评审 / L3 人工验收（共享 EvidenceLedger，数据路径同 WorkUnitDrawer） */}
              <EvidenceLedger attestations={attestations} variant="card" />

              {/* #284（决策 #250 D1/F7-F9）：闸门类人审入口补齐详情页（「新页面打开」落点此前无任何审查操作），
                  与列表行/频道抽屉三处一致——pending 确认（进待认领）；in_review 通过/拒绝（拒绝带原因） */}
              {wu.status === 'pending' && (
                <div className="card mt-4 p-3">
                  <button
                    className="btn btn-primary"
                    disabled={confirming}
                    title="待确认人闸：扩范围单创建落待确认，确认后进入待认领（agent 可见可认领）"
                    onClick={handleConfirmPending}
                  >
                    {confirming ? '提交中…' : '确认（进待认领）'}
                  </button>
                </div>
              )}
              {wu.status === 'in_review' && (
                <div className="card mt-4 p-3 flex gap-2">
                  <button
                    className="btn btn-primary"
                    disabled={confirming}
                    title="审查硬门：通过→done（analysis 通过后按 TASK 拆分自动派工）"
                    onClick={handleApprove}
                  >
                    {confirming ? '提交中…' : '通过（审查闸门）'}
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={confirming}
                    title="审查硬门：拒绝→返工（附原因供 agent 修正）"
                    onClick={() => setShowRejectModal(true)}
                  >
                    拒绝
                  </button>
                </div>
              )}

              {/* #185（决策 #87 D4）：blocked 处置（继续执行/关闭任务），与 WorkUnitDrawer 同一组件；
                  动作成功后经 actionTick 重拉详情 */}
              <BlockedActions wu={wu} onChanged={() => setActionTick(t => t + 1)} />

              {/* 执行过程（思考/工具调用/用量；组件自带 REST 回放 + SSE 实时流，页面不接 SSE）。
                  #182：传 wu 启用置顶「当前状态速览」节（决策 #61，与 WorkUnitDrawer 同组件复用） */}
              <div
                className="card mt-4 p-3"
              >
                <ExecutionSteps workUnitId={wu.id} wu={wu} />
              </div>

              {/* 会话原文（#174）：归档 transcript 只读查看，默认折叠按需加载 */}
              <div
                className="card mt-4 p-3"
              >
                <TranscriptViewer workUnitId={wu.id} />
              </div>

              {/* 讨论区（WU 级消息，无需频道上下文） */}
              <DiscussionPanel workUnitId={wu.id} />
            </>
          )}
        </div>
      </div>

      {/* REQ 全链路弹窗（复用 RequirementChainPanel） */}
      {chainReqId && <RequirementChainPanel reqId={chainReqId} onClose={() => setChainReqId(null)} />}

      {/* #284：analysis 通过确认弹窗（共享件，预填逻辑 buildMapOpeningPrefill 不变） */}
      {showApproveModal && wu && (
        <AnalysisApproveDialog
          prefill={buildMapOpeningPrefill(wu.metadata)}
          channelId={wu.channelId}
          onConfirm={(summary, assigneeId) => { setShowApproveModal(false); handleReviewPassed(summary, assigneeId); }}
          onCancel={() => setShowApproveModal(false)}
        />
      )}

      {/* #284：审查拒绝弹窗（带原因），与列表行/抽屉同款 */}
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
              <button className="btn btn-danger" disabled={confirming} onClick={handleReviewRejected}>
                确认拒绝
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AC-5.6: 协作树 Token 开销弹窗 */}
      {showTreeTokens && wu && (
        <TreeTokenDrawer workUnitId={wu.id} onClose={() => setShowTreeTokens(false)} />
      )}
    </div>
  );
}

function formatTime(ts: string | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
