// WuGateActions — WU 审查闸门动作三处合一（2026-09 页面重设计 E2-4，docs/plans/2026-09-page-redesign.md）：
// WorkUnitListPage 行内 / WorkUnitDrawer / WorkUnitDetailPage 左栏挂同一组件，文案与视觉唯一。
// 分支：pending →「确认（进待领取）」（#284 人闸）；in_review →「通过（审查闸门）」+「拒绝」（带原因弹窗，
// analysis 走 AnalysisApproveDialog 预填待决清单，#106 M7）；done 缺 l3 →「人工确认（留痕）」（L3 台账不阻断流程）。
// 反馈统一批次A 模式：pending 锁存防连点 + 失败 gateError 内联（errorMessage 服务端 error.message 优先）
// + 弹窗成功才关窗。blocked 处置（BlockedActions）不在此列——属状态处置非审查闸门，各页自挂。
// 变更写路径留在调用方经 props 注入（列表=store 动作后重拉 / 抽屉=响应体直替本地 wu / 详情页=actionTick 重拉）。
import { useState } from 'react';
import { deriveDisplayState } from '@dommaker/studio-shared/web';
import type { WorkUnit } from '../../api/workunit';
import { AnalysisApproveDialog } from '../pmo/AnalysisApproveDialog';
import { buildMapOpeningPrefill } from '../pmo/mapUtils';
import { errorMessage } from '../../utils/errorMessage';

export interface WuGateActionsProps {
  wu: WorkUnit;
  /** 审查硬门通过（analysis 由弹窗带 summary/assigneeId 回传）；失败须 reject——弹窗据此保持打开 */
  onReviewPassed: (summary?: string, assigneeId?: string) => Promise<unknown>;
  /** 审查硬门拒绝（reason 可选） */
  onReviewRejected: (reason?: string) => Promise<unknown>;
  /** #284 pending 人闸确认（→ unassigned 进 frontier 可认领） */
  onConfirmPending: () => Promise<unknown>;
  /** #284（决策 #250 D6）：接力卡「打开即弹」——挂载时 wu 为 in_review analysis 则自动弹确认弹窗（一次性） */
  autoApprove?: boolean;
}

export function WuGateActions({ wu, onReviewPassed, onReviewRejected, onConfirmPending, autoApprove = false }: WuGateActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [gateError, setGateError] = useState('');
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // F6 派生（铁律：needsHuman 判断一律过 deriveDisplayState，不自行读 attestations）
  const derived = deriveDisplayState({ status: wu.status, metadata: wu.metadata });

  // autoApprove（#284 决策 #250 D6）：接力卡「打开即弹」一次性——渲染期派生（prevId 同款模式，
  // 组件仅在 wu 加载完成且命中闸门分支后挂载，id 切换经卸载重置）
  const [autoPopupDone, setAutoPopupDone] = useState(false);
  if (!autoPopupDone && autoApprove && wu.type === 'analysis' && wu.status === 'in_review') {
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

  // analysis 单走确认弹窗（待决问题清单审核）；其余类型一键通过。按钮直触路径吞 rejection（原因已内联置位）
  const handleApprove = () => {
    if (wu.type === 'analysis') {
      setShowApproveModal(true);
    } else {
      void run(() => onReviewPassed()).catch(() => {});
    }
  };

  /** 成功才关弹窗；失败错误行同时进闸门区与弹窗（同源 gateError） */
  const handleReject = () => {
    void run(() => onReviewRejected(rejectReason.trim() || undefined))
      .then(() => { setShowRejectModal(false); setRejectReason(''); })
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
            onClick={() => { void run(onConfirmPending).catch(() => { /* 失败原因已内联 */ }); }}
          >
            {confirming ? '提交中…' : '确认（进待领取）'}
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
              {confirming ? '提交中…' : '通过（审查闸门）'}
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
            {confirming ? '提交中…' : '人工确认（留痕）'}
          </button>
        )}
      </div>
      {/* 批次A 项5：闸门动作失败内联错误行（BlockedActions run() 同模式） */}
      {gateError && <div className="text-xs u-err mt-1">{gateError}</div>}

      {showApproveModal && (
        <AnalysisApproveDialog
          prefill={buildMapOpeningPrefill(wu.metadata)}
          channelId={wu.channelId}
          onConfirm={async (summary, assigneeId) => {
            // 批次A 项7：成功才关窗（失败由弹窗内联展示，gateError 亦已置位）
            await run(() => onReviewPassed(summary, assigneeId));
            setShowApproveModal(false);
          }}
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
              <button className="btn btn-danger" disabled={confirming} onClick={handleReject}>
                确认拒绝
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
