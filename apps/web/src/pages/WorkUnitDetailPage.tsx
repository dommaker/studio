// WorkUnitDetailPage — /workunits/:id WU 详情页（#396 重构，spec redesign-2026-08 §5 定稿变体 C）
// 骨架：Header（← 返回 + 类型/状态徽章 + 标题）→ 四站 stepper（待领取→进行中→待验收→完成，
// 生命周期关键事件 = stepper 下一行横排 chip）→ 左右两栏。
// 分栏标准（§5.1 核心决议）：左栏 260px = 判断/操作的输入（关键事实→证据台账→依赖与验收→巡检机会→闸门动作，
// 后三节按数据条件渲染）；右栏 = 过程/记录（执行过程 ExecutionFlow → 会话原文 → 讨论区）。
// 数据获取/派生/mutation handler 逻辑沿用重构前实现；「待验收」站时间戳口径见 utils/wuLifecycle.ts 注释（§5.6.2）。
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { deriveDisplayState, parseAttestations, WU_STATUS_COLORS, WU_STATUS_LABELS, WU_TYPE_LABELS } from '@dommaker/studio-shared/web';
import { workunitApi, type Opportunity, type WorkUnit } from '../api/workunit';
import { requirementApi } from '../api/requirements';
import { projectApi } from '../api/index';
import { channelApi } from '../api/channel';
import { AssigneeLabel } from '../components/workunit/AssigneeLabel';
import { ExecutionFlow } from '../components/workunit/ExecutionFlow';
import { BlockedActions } from '../components/workunit/BlockedActions';
import { TranscriptViewer } from '../components/workunit/TranscriptViewer';
import { DiscussionPanel } from '../components/DiscussionPanel';
import { RequirementChainPanel } from '../components/requirement/RequirementChainPanel';
import { SelfReviewBadge } from '../components/workunit/SelfReviewBadge';
import { EvidenceLedger } from '../components/workunit/EvidenceLedger';
import { OpportunitiesPanel } from '../components/workunit/OpportunitiesPanel';
import { BlockedByList } from '../components/workunit/BlockedByList';
import { StationStepper, LifecycleEventChips } from '../components/workunit/StationStepper';
import { TreeTokenEntry } from '../components/workunit/TreeTokenChart';
import { BackButton } from '../components/ui';
import { parseBlockedBy, buildMapOpeningPrefill } from '../components/pmo/mapUtils';
import { AnalysisApproveDialog } from '../components/pmo/AnalysisApproveDialog';
import { buildLifecycle } from '../utils/wuLifecycle';
import { formatShortTime } from '../utils/datetime';
import { parseWuMeta } from '../utils/wuMeta';
import '../styles/wu-detail.css';

interface PmoInfo {
  id: string;
  pmoNumber: string;
  title: string;
}

/** 归属条 PMO 解析（2026-08 归因统一）：① 创建期归因戳 metadata.pmoId（‖ deprecated legacy ownershipProjectId 同级）直查；② 否则 reqId → requirement.projectId（REQ 别名视图 projectId = PMO 自身 id） */
async function resolvePmo(wu: WorkUnit): Promise<PmoInfo | null> {
  const meta = parseWuMeta(wu.metadata);
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

/** 关键事实卡行：label + 值（值超长截断） */
function FactRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="wu-detail-fact">
      <span className="wu-detail-fact-k">{k}</span>
      <span className="wu-detail-fact-v">{children}</span>
    </div>
  );
}

export function WorkUnitDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [wu, setWu] = useState<WorkUnit | null>(null);
  const [error, setError] = useState('');
  const [pmo, setPmo] = useState<PmoInfo | null>(null);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [chainReqId, setChainReqId] = useState<string | null>(null);
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
  }

  useEffect(() => {
    if (!id) return;
    let alive = true;
    workunitApi.get(id)
      .then(r => {
        if (!alive) return;
        const unit = r.data;
        setWu(unit);
        // 归属解析全部 best-effort 并行：解析不到就不显示对应行，不阻塞页面
        resolvePmo(unit).then(p => { if (alive) setPmo(p); });
        if (unit.channelId) {
          channelApi.list()
            .then(res => {
              if (!alive) return;
              setChannelName(res.data.data.find(c => c.id === unit.channelId)?.name ?? null);
            })
            .catch(() => { /* best-effort */ });
        }
      })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [id, actionTick]);

  const meta = wu ? parseWuMeta(wu.metadata) : {};
  // #116：依赖（blockedBy）与验收标准（ac）展示数据
  const blockedByIds = wu ? parseBlockedBy(wu.metadata) : [];
  const acList = Array.isArray(meta.ac)
    ? (meta.ac as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : [];
  const opportunities = Array.isArray(meta.opportunities) && (meta.opportunities as Opportunity[]).length > 0
    ? (meta.opportunities as Opportunity[])
    : null;
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
  const life = wu && derived ? buildLifecycle(wu, derived, meta, attestations) : null;
  const hasGate = wu !== null && (wu.status === 'pending' || wu.status === 'in_review' || wu.status === 'blocked');

  return (
    <div className="wu-detail">
      {/* Header：← 返回（§4.4 统一组件）+ 类型/状态徽章 + 标题 */}
      <div className="wu-detail-header">
        <div className="wu-detail-header-back"><BackButton fallback="/workunits" /></div>
        <div className="flex items-center gap-2 min-w-0">
          {wu && derived && (
            <>
              <span className="text-xs px-2 py-0.5 rounded u-surface-2 u-text-2 flex-shrink-0">
                {WU_TYPE_LABELS[wu.type] ?? wu.type}
              </span>
              <span className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${WU_STATUS_COLORS[derived.column] || 'u-surface-2 u-text-3'}`}>
                {WU_STATUS_LABELS[derived.column] ?? derived.column}
              </span>
              <SelfReviewBadge wu={wu} />
            </>
          )}
          <h1 className="page-title truncate">{wu ? title : 'WorkUnit 详情'}</h1>
        </div>
      </div>

      {/* 四站 stepper 全页共享定位条 + 生命周期关键事件 chip 行（无事件不占行） */}
      {life && (
        <div className="wu-detail-stepperwrap">
          <StationStepper stations={life.stations} />
          <LifecycleEventChips events={life.events} />
        </div>
      )}

      {error ? (
        <div className="wu-detail-body-single">
          <div className="p-3 rounded u-err-dim u-err text-sm">加载失败: {error}</div>
        </div>
      ) : !wu || !derived || !life ? (
        <div className="wu-detail-body-single text-center py-20 u-text-2">加载中...</div>
      ) : (
        <div className="wu-detail-body">
          {/* 左栏 260px = 判断/操作的输入 */}
          <aside className="wu-detail-rail">
            <section className="wu-detail-sec">
              <h3 className="wu-detail-sec-title">关键事实</h3>
              <div className="wu-detail-card">
                <div className="wu-detail-facts">
                  {pmo && (
                    <FactRow k="PMO">
                      <Link to={`/pmo/project/${pmo.id}`} className="u-accent" title={`所属 PMO 项目：${pmo.title}`}>
                        {pmo.pmoNumber}
                      </Link>
                    </FactRow>
                  )}
                  {wu.reqId && (
                    <FactRow k="REQ">
                      <button className="u-accent wu-detail-fact-btn" title="查看 REQ 全链路" onClick={() => setChainReqId(wu.reqId ?? null)}>
                        {wu.reqId}
                      </button>
                    </FactRow>
                  )}
                  {wu.channelId && (
                    <FactRow k="频道">
                      <Link to={`/channels/${wu.channelId}`} className="u-text-2" title="所在频道">
                        # {channelName ?? `${wu.channelId.slice(0, 8)}...`}
                      </Link>
                    </FactRow>
                  )}
                  {wu.assigneeId && (
                    <FactRow k="认领人">
                      <AssigneeLabel assigneeId={wu.assigneeId} className="u-text-2" />
                    </FactRow>
                  )}
                  <FactRow k="创建"><span className="wu-detail-time">{formatShortTime(wu.createdAt)}</span></FactRow>
                  {wu.claimedAt && (
                    <FactRow k="认领"><span className="wu-detail-time">{formatShortTime(wu.claimedAt)}</span></FactRow>
                  )}
                  {wu.completedAt && (
                    <FactRow k="完成"><span className="wu-detail-time">{formatShortTime(wu.completedAt)}</span></FactRow>
                  )}
                  {wu.failureType && (
                    <FactRow k="失败类型"><span className="u-err">{wu.failureType}</span></FactRow>
                  )}
                  {/* §5.4：Token 行 = 图表面板入口（mono 总耗 + 迷你预算占比条，整行可点） */}
                  <FactRow k="Token"><TreeTokenEntry workUnitId={wu.id} /></FactRow>
                </div>
              </div>
            </section>

            {/* F6 证据台账：L1/L2/L3（drawer 紧凑变体适配窄栏；自带 mc-block-label 由 CSS 隐藏，区标题统一） */}
            <section className="wu-detail-sec">
              <h3 className="wu-detail-sec-title">证据台账</h3>
              <div className="wu-detail-card">
                <EvidenceLedger attestations={attestations} variant="drawer" />
              </div>
            </section>

            {/* #116：依赖与验收（blockedBy 依赖清单含各自状态 + ac 验收标准；两者皆无则不渲染） */}
            {(blockedByIds.length > 0 || acList.length > 0) && (
              <section className="wu-detail-sec">
                <h3 className="wu-detail-sec-title">依赖与验收</h3>
                <div className="wu-detail-card">
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
              </section>
            )}

            {/* #163 T8-E2 巡检机会清单（metadata.opportunities 非空数组才渲染） */}
            {opportunities && (
              <section className="wu-detail-sec">
                <h3 className="wu-detail-sec-title">巡检机会</h3>
                <div className="wu-detail-card">
                  <OpportunitiesPanel workUnitId={wu.id} opportunities={opportunities} onChanged={reloadWu} />
                </div>
              </section>
            )}

            {/* 闸门动作（#284 pending 确认 / in_review 通过+拒绝；#185 blocked 处置）——整节按状态条件渲染 */}
            {hasGate && (
              <section className="wu-detail-sec">
                <h3 className="wu-detail-sec-title">闸门动作</h3>
                <div className="wu-detail-card">
                  {wu.status === 'pending' && (
                    <button
                      className="btn btn-primary"
                      disabled={confirming}
                      title="待确认人闸：扩范围单创建落待确认，确认后进入待认领（agent 可见可认领）"
                      onClick={handleConfirmPending}
                    >
                      {confirming ? '提交中…' : '确认（进待认领）'}
                    </button>
                  )}
                  {wu.status === 'in_review' && (
                    <div className="flex gap-2">
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
                  <BlockedActions wu={wu} onChanged={() => setActionTick(t => t + 1)} />
                </div>
              </section>
            )}
          </aside>

          {/* 右栏 = 过程/记录纯叙事流：执行过程 → 会话原文 → 讨论区 */}
          <div className="wu-detail-content">
            <section className="wu-detail-sec">
              <h3 className="wu-detail-sec-title">执行过程</h3>
              <div className="wu-detail-card">
                <ExecutionFlow workUnitId={wu.id} wu={wu} />
              </div>
            </section>
            {/* 会话原文/讨论区：组件自带功能头（折叠 toggle / 讨论空间标题栏），不再叠区标题（§5.5 节容器规格由组件外壳承担） */}
            <section className="wu-detail-sec">
              <TranscriptViewer workUnitId={wu.id} />
            </section>
            <section className="wu-detail-sec">
              <DiscussionPanel workUnitId={wu.id} />
            </section>
          </div>
        </div>
      )}

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
    </div>
  );
}
