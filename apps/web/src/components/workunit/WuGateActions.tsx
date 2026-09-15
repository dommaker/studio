// WuGateActions — WU 审查闸门动作三处合一（2026-09 页面重设计 E2-4，docs/plans/2026-09-page-redesign.md）：
// WorkUnitListPage 行内 / WorkUnitDrawer / WorkUnitDetailPage 左栏挂同一组件，文案与视觉唯一。
// 分支：pending →「确认并开放领取」（#284 人闸）；in_review →「通过验收」+「拒绝」（带原因弹窗；
// #463 起 analysis/decision/spec 走各自结构化确认弹窗——评审表单+按钮，后端序列化进 l3.summary，
// 人不接触魔法行）；done 缺 l3 →「人工验收确认」（L3 台账不阻断流程）。
// #473：按钮说人话——内部机制词（审查闸门/留痕/进待领取）不上按钮。
// 反馈统一批次A 模式：pending 锁存防连点 + 失败 gateError 内联（errorMessage 服务端 error.message 优先）
// + 弹窗成功才关窗 + #468 成功 toast 说明后续走向（自动派工/进待领取/打回返工）。
// blocked 处置（BlockedActions）不在此列——属状态处置非审查闸门，各页自挂。
// 写路径内建（#545，ADR 2026-09-15-web-gate-write-module）：组件直接消费 utils/gateWriter
// （一次 API 调用 + 响应体快照双写落点）；宿主只经 onUpdated 登记本地落点（drawer/详情页 setWu），
// 列表行/工作条无需 sink（store 双写已覆盖）。
import { useState } from 'react';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import type { WorkUnit } from '../../api/workunit';
import { AnalysisApproveDialog } from '../pmo/AnalysisApproveDialog';
import { DecisionApproveDialog } from '../pmo/DecisionApproveDialog';
import { SpecApproveDialog } from '../pmo/SpecApproveDialog';
import { buildAnalysisConfirmPrefill, buildDecisionConfirmPrefill, buildSpecConfirmPrefill } from '../pmo/mapUtils';
import { createGateWriter, type GateUpdateSink } from '../../utils/gateWriter';
import { errorMessage } from '../../utils/errorMessage';
import { toast } from '../../utils/toast';

export interface WuGateActionsProps {
  wu: WorkUnit;
  /** #545：宿主本地快照落点（store 双写完成后由 gateWriter 调用）；缺省 = 无本地态宿主 */
  onUpdated?: GateUpdateSink;
  /** #284（决策 #250 D6）：接力卡「打开即弹」——挂载时 wu 为 in_review analysis 则自动弹确认弹窗（一次性） */
  autoApprove?: boolean;
}

export function WuGateActions({ wu, onUpdated, autoApprove = false }: WuGateActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [gateError, setGateError] = useState('');
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // F6 派生（铁律：needsHuman 判断一律过 deriveDisplayState，不自行读 attestations）
  const derived = deriveDisplayState({ status: wu.status, metadata: wu.metadata });
  // #545：写路径唯一正本（API 调用 + store 双写 + onUpdated 回调全在 gateWriter）
  const gateWriter = createGateWriter(onUpdated);

  // autoApprove（#284 决策 #250 D6）：接力卡「打开即弹」一次性——渲染期派生（prevId 同款模式，
  // 组件仅在 wu 加载完成且命中闸门分支后挂载，id 切换经卸载重置）
  // #471：plan（一脉会话规划单）同走 analysis_confirm 接力卡，同样打开即弹
  const [autoPopupDone, setAutoPopupDone] = useState(false);
  if (!autoPopupDone && autoApprove && (wu.type === 'analysis' || wu.type === 'plan') && wu.status === 'in_review') {
    setAutoPopupDone(true);
    setShowApproveModal(true);
  }

  /** 统一入口：pending 锁存防连点 + 失败 gateError 内联并 rethrow（弹窗路径据此保持打开） */
  const run = async (fn: () => Promise<unknown>) => {
    if (confirming) return;
    setConfirming(true);
    setGateError('');
    try {
      await fn();
    } catch (e) {
      setGateError(errorMessage(e));
      throw e;
    } finally {
      setConfirming(false);
    }
  };

  /** #468：闸门动作成功后 toast 说明后续走向（配合行动中心——动作后用户知道「接下来系统会做什么」） */
  const approveFollowUp = () => {
    if (wu.status === 'done') return '已确认留痕，工单出审查列';
    return (wu.type === 'analysis' || wu.type === 'plan')
      ? '已通过，将按拆分结果自动派工'
      : '已通过审查闸门，工单收口';
  };

  // #463：analysis/plan/decision/spec 走各自结构化确认弹窗（评审表单+按钮，人不接触魔法行）；
  // #471：plan（一脉会话规划单）复用 AnalysisApproveDialog（confirm kind=plan，同形契约）；
  // 其余类型一键通过。按钮直触路径吞 rejection（原因已内联置位）
  const CONFIRM_DIALOG_TYPES = new Set(['analysis', 'plan', 'decision', 'spec']);
  const handleApprove = () => {
    if (CONFIRM_DIALOG_TYPES.has(wu.type)) {
      setShowApproveModal(true);
    } else {
      void run(() => gateWriter.reviewPassed(wu.id)).then(() => toast.success(approveFollowUp())).catch(() => {});
    }
  };

  /** 拒绝（含弹窗打回按钮）：成功才关弹窗；失败错误行同时进闸门区与弹窗（同源 gateError） */
  const handleReject = (reason?: string) => {
    void run(() => gateWriter.reviewRejected(wu.id, reason))
      .then(() => {
        setShowRejectModal(false); setRejectReason(''); setShowApproveModal(false);
        toast.info('已拒绝，工单打回返工'); // #468
      })
      .catch(() => {});
  };

  if (wu.status !== 'pending' && wu.status !== 'in_review' && !(wu.status === 'done' && derived.needsHuman)) {
    return null;
  }

  return (
    // 根节点吞点击冒泡：列表行整行可点（开抽屉），闸门按钮不得触发行点击；抽屉/详情页无害
    <div onClick={e => e.stopPropagation()}>
      <div className="flex gap-2 flex-wrap">
        {wu.status === 'pending' && (
          <button
            className="btn btn-primary btn-sm"
            disabled={confirming}
            title="待确认人闸：扩范围单创建落待确认，确认后进入待领取（agent 可见可领取）"
            onClick={() => {
              void run(() => gateWriter.confirmPending(wu.id))
                .then(() => toast.success('已确认，工单进入待领取队列（agent 可认领）')) // #468
                .catch(() => { /* 失败原因已内联 */ });
            }}
          >
            {confirming ? '提交中…' : '确认并开放领取'}
          </button>
        )}
        {wu.status === 'in_review' && (
          <>
            <button
              className="btn btn-primary btn-sm"
              disabled={confirming}
              title="审查硬门：通过→done（analysis 通过后按 TASK 拆分自动派工）"
              onClick={handleApprove}
            >
              {confirming ? '提交中…' : '通过验收'}
            </button>
            <button
              className="btn btn-danger btn-sm"
              disabled={confirming}
              title="审查硬门：拒绝→返工（附原因供 agent 修正）"
              onClick={() => setShowRejectModal(true)}
            >
              拒绝
            </button>
          </>
        )}
        {wu.status === 'done' && derived.needsHuman && (
          <button
            className="btn btn-primary btn-sm"
            disabled={confirming}
            title="流程已由 Agent 评审推进完成；此确认为人工确认留痕，不阻断流程，确认后出审查列"
            onClick={handleApprove}
          >
            {confirming ? '提交中…' : '人工验收确认'}
          </button>
        )}
      </div>
      {/* 批次A 项5：闸门动作失败内联错误行（BlockedActions run() 同模式） */}
      {gateError && <div className="text-xs u-err mt-1">{gateError}</div>}

      {showApproveModal && (wu.type === 'analysis' || wu.type === 'plan') && (
        <AnalysisApproveDialog
          prefill={buildAnalysisConfirmPrefill(wu.metadata)}
          channelId={wu.channelId}
          confirmKind={wu.type === 'plan' ? 'plan' : 'analysis'}
          onConfirm={async (confirm, assigneeId) => {
            // 批次A 项7：成功才关窗（失败由弹窗内联展示，gateError 亦已置位）
            await run(() => gateWriter.reviewPassed(wu.id, undefined, assigneeId, confirm));
            toast.success(approveFollowUp()); // #468
            setShowApproveModal(false);
          }}
          onReject={async reason => { await run(() => gateWriter.reviewRejected(wu.id, reason)); toast.info('已拒绝，工单打回返工'); setShowApproveModal(false); }}
          onCancel={() => setShowApproveModal(false)}
        />
      )}

      {showApproveModal && wu.type === 'decision' && (
        <DecisionApproveDialog
          question={(wu.scope ?? '').split('\n')[0] ?? ''}
          suggestion={buildDecisionConfirmPrefill(wu.metadata)}
          onConfirm={async confirm => {
            await run(() => gateWriter.reviewPassed(wu.id, undefined, undefined, confirm));
            toast.success(approveFollowUp()); // #468
            setShowApproveModal(false);
          }}
          onReject={async reason => { await run(() => gateWriter.reviewRejected(wu.id, reason)); toast.info('已拒绝，工单打回返工'); setShowApproveModal(false); }}
          onCancel={() => setShowApproveModal(false)}
        />
      )}

      {showApproveModal && wu.type === 'spec' && (
        <SpecApproveDialog
          prefill={buildSpecConfirmPrefill(wu.metadata)}
          onConfirm={async confirm => {
            await run(() => gateWriter.reviewPassed(wu.id, undefined, undefined, confirm));
            toast.success(approveFollowUp()); // #468
            setShowApproveModal(false);
          }}
          onReject={async reason => { await run(() => gateWriter.reviewRejected(wu.id, reason)); toast.info('已拒绝，工单打回返工'); setShowApproveModal(false); }}
          onCancel={() => setShowApproveModal(false)}
        />
      )}

      {/* #284：审查拒绝弹窗（带原因），三处同款 */}
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
              {/* 拒绝失败保持弹窗打开，错误行进弹窗（闸门区同步置位） */}
              {gateError && <p className="text-xs u-err" style={{ marginTop: 4 }}>{gateError}</p>}
            </div>
            <div className="modal-footer">
              <button
                className="btn btn-secondary"
                onClick={() => { setShowRejectModal(false); setRejectReason(''); }}
              >
                取消
              </button>
              <button className="btn btn-danger" disabled={confirming} onClick={() => handleReject(rejectReason.trim() || undefined)}>
                确认拒绝
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
