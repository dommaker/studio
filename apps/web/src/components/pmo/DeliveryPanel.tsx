/**
 * DeliveryPanel - PMO-b/F6-c 交付面板（Card 7 从 ProjectDetailPage 抽取）
 *
 * 交付台账 + human-only 交付合并 + 缺口行动（重跑 L1 验证 / 派发 L2 评审 / L3 人工确认）。
 * 状态码 → toast 矩阵集中在 handleGapAction，可单测。
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectApi, type DeliveryStatus, type DeliveryGap } from '../../api';
import { workunitApi, type ReviewConfirmPayload } from '../../api/workunit';
import { formatFullTime } from '../../utils/datetime';
import { toast } from '../../utils/toast';
import { AnalysisApproveDialog } from './AnalysisApproveDialog';
import { IconCheck, IconRefresh, IconClock } from '../ui/icons';
import { buildAnalysisConfirmPrefill, type AnalysisConfirmPrefill } from './mapUtils';
import { EVIDENCE_LAYER_LABELS } from './pipelineUtils';
import { DELIVERY_POLICY_LABELS } from './projectDisplay';

// 🆕 F6-c: 缺口层 → 人话文案（#399 §8.3 词表：自动验证 / Agent 评审 / 人工确认，L1/L2/L3 不上界面）
// 「缺」与 Latin 开头的 Agent 评审间留空格，CJK 词直连
const GAP_LAYER_LABELS: Record<'l1' | 'l2' | 'l3', string> = {
  l1: `缺${EVIDENCE_LAYER_LABELS.l1}`,
  l2: `缺 ${EVIDENCE_LAYER_LABELS.l2}`,
  l3: `缺${EVIDENCE_LAYER_LABELS.l3}`,
};

export interface DeliveryPanelProps {
  projectId: string;
  /** 交付台账（GET /pmo/project/:id/delivery 响应），为 null 时面板不渲染（由调用方守卫） */
  delivery: DeliveryStatus;
  /** 缺口行动/交付成功后回调：重新拉台账 + 全量数据 */
  onRefresh: () => Promise<void> | void;
}

export function DeliveryPanel({ projectId, delivery, onRefresh }: DeliveryPanelProps) {
  const navigate = useNavigate();

  // 交付合并（决策 1：合并动作为 human-only 手动触发）
  const [delivering, setDelivering] = useState(false);
  const [deliverError, setDeliverError] = useState<{ message: string; missing?: string[]; conflictFiles?: string[] } | null>(null);
  // 🆕 F6-c: 缺口行动按钮的独立 loading 态（key = `${wuId}:${action}`），防重复点击
  const [gapActionPending, setGapActionPending] = useState<Record<string, boolean>>({});
  // #106 M7：analysis 缺口的「人工确认」走共享确认弹窗（#463 起结构化评审表单：
  // FOG 清单 + TASK 拆分预览，人审后 confirm 载荷由后端序列化进 l3.summary）
  const [approveGap, setApproveGap] = useState<{ gap: DeliveryGap; prefill: AnalysisConfirmPrefill; channelId: string | null } | null>(null);

  // analysis 缺口开弹窗：gaps 列表无 metadata，best-effort 拉 WU 详情取预填（拉不到 → 空手评）
  // #177：同时取 channelId 喂弹窗的「默认执行角色」下拉（候选=频道成员）
  const openAnalysisApprove = async (gap: DeliveryGap) => {
    let prefill: AnalysisConfirmPrefill = { destination: '', fog: [], tasks: [] };
    let channelId: string | null = null;
    try {
      const res = await workunitApi.get(gap.id);
      prefill = buildAnalysisConfirmPrefill(res.data?.metadata);
      channelId = res.data?.channelId ?? null;
    } catch { /* best-effort */ }
    setApproveGap({ gap, prefill, channelId });
  };

  // 🆕 F6-c: 缺口行动——重跑 L1 验证 / 补派 L2 评审 / L3 人工确认
  const handleGapAction = async (gap: DeliveryGap, action: 'verify' | 'dispatchReview' | 'reviewPassed', summary?: string, assigneeId?: string, confirm?: ReviewConfirmPayload) => {
    const key = `${gap.id}:${action}`;
    setGapActionPending(prev => ({ ...prev, [key]: true }));
    try {
      if (action === 'verify') {
        const res = await workunitApi.verify(gap.id);
        if (res.data?.verified) {
          toast.success('验证通过，自动验证已补齐');
          await onRefresh();
        } else {
          const failedCmds = (res.data?.failed || []).map((f: { command: string }) => f.command).join('；');
          toast.error(`验证未通过${failedCmds ? `：${failedCmds}` : ''}`);
        }
      } else if (action === 'dispatchReview') {
        await workunitApi.dispatchReview(gap.id);
        toast.success('已创建评审任务，待 agent 领取');
        await onRefresh();
      } else {
        await workunitApi.reviewPassed(gap.id, summary, assigneeId, confirm);
        toast.success('人工确认已补齐');
        await onRefresh();
      }
    } catch (err) {
      const status = err?.response?.status;
      const errData = err?.response?.data?.error;
      if (action === 'verify' && status === 422) {
        toast.error(err?.response?.data?.hint || '未配置验证命令（verifyCommands）');
      } else if (action === 'verify' && status === 409) {
        toast.error(errData?.message || '无 worktree，无法重跑验证');
      } else if (action === 'dispatchReview' && status === 409) {
        toast.info('评审已在途或已完成');
      } else {
        toast.error(errData?.message || err?.message || '操作失败');
      }
    } finally {
      setGapActionPending(prev => ({ ...prev, [key]: false }));
    }
  };

  // #469: branch-only 标记已交付（系统外合并后人工落档 commit 哈希）
  const [markCommit, setMarkCommit] = useState('');
  const [marking, setMarking] = useState(false);

  // 🆕 PMO-b: 交付合并（409 时展示缺口/冲突清单）
  const handleDeliver = async () => {
    setDelivering(true);
    setDeliverError(null);
    try {
      const res = await projectApi.deliver(projectId);
      toast.success(`交付成功${res.data?.deliverCommit ? ` (${String(res.data.deliverCommit).slice(0, 7)})` : ''}`);
      // 刷新台账与项目信息（显示 deliveredAt/deliveredBy/deliverCommit）
      await onRefresh();
    } catch (err) {
      const errData = err?.response?.data?.error;
      if (err?.response?.status === 409 && errData) {
        setDeliverError({
          message: errData.message || '交付被拒绝',
          missing: errData.missing,
          conflictFiles: errData.conflictFiles,
        });
      } else {
        toast.error(errData?.message || err?.message || '交付失败');
      }
    } finally {
      setDelivering(false);
    }
  };

  // #469: branch-only 人工落档——填合并 commit 哈希，写 deliveredAt/By/Commit（后端幂等拒绝重复落档）
  const handleMarkDelivered = async () => {
    const commit = markCommit.trim();
    if (!commit) return;
    setMarking(true);
    try {
      const res = await projectApi.markDelivered(projectId, commit);
      toast.success(`已标记交付${res.data?.deliverCommit ? ` (${String(res.data.deliverCommit).slice(0, 7)})` : ''}`);
      setMarkCommit('');
      await onRefresh();
    } catch (err) {
      const errData = err?.response?.data?.error;
      toast.error(errData?.message || err?.message || '标记已交付失败');
    } finally {
      setMarking(false);
    }
  };

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center justify-between mb-3">
        <h3 className="mc-block-label" style={{ margin: 0 }}>交付</h3>
        {/* #474 去 emoji：状态徽章图标 = ui/icons stroke SVG（原 ✓/🔄/⏳ 徽章） */}
        {delivery.deliveredAt ? (
          <span className="text-xs px-2 py-1 rounded u-ok-dim u-ok font-medium inline-flex items-center gap-1"><IconCheck size={12} /> 已交付</span>
        ) : delivery.deliverable ? (
          <span className="text-xs px-2 py-1 rounded u-ok-dim u-ok font-medium inline-flex items-center gap-1"><IconCheck size={12} /> 可交付</span>
        ) : delivery.wu.inFlight > 0 ? (
          <span className="text-xs px-2 py-1 rounded u-accent-dim u-accent font-medium inline-flex items-center gap-1">
            <IconRefresh size={12} /> 进行中 {delivery.wu.finished}/{delivery.wu.total}
          </span>
        ) : (
          // #472：项目级「待验收」改「待交付」——与 WU 四站「待验收」同词异义分词（项目级=待交付合并）
          <span className="text-xs px-2 py-1 rounded u-warn-dim u-warn font-medium inline-flex items-center gap-1">
            <IconClock size={12} /> 待交付:证据还差 {delivery.evidence.l1Missing.length + delivery.evidence.l2Missing.length + delivery.evidence.l3Missing.length} 项
          </span>
        )}
      </div>

      {/* 台账概览：策略 / 分支 / 任务完成度 / 证据三层（白话词表）/ 自评；#472 策略文案走 projectDisplay 唯一词表；#474 ✓ → IconCheck */}
      <div className="text-sm u-text-2 flex flex-wrap gap-x-4 gap-y-1 mb-2 items-center">
        <span>交付策略: {DELIVERY_POLICY_LABELS[delivery.policy] ?? delivery.policy}</span>
        <span>分支: {delivery.branch || '—'}</span>
        <span>任务: {delivery.wu.finished}/{delivery.wu.total} 完成</span>
        <span className="inline-flex items-center gap-1">{EVIDENCE_LAYER_LABELS.l1}: {delivery.evidence.l1Missing.length === 0 ? <IconCheck size={12} /> : `缺 ${delivery.evidence.l1Missing.length}`}</span>
        <span className="inline-flex items-center gap-1">{EVIDENCE_LAYER_LABELS.l2}: {delivery.evidence.l2Missing.length === 0 ? <IconCheck size={12} /> : `缺 ${delivery.evidence.l2Missing.length}`}</span>
        <span className="inline-flex items-center gap-1">{EVIDENCE_LAYER_LABELS.l3}: {delivery.evidence.l3Missing.length === 0 ? <IconCheck size={12} /> : `缺 ${delivery.evidence.l3Missing.length}`}</span>
        <span>自评: {delivery.evidence.selfReviewCount}</span>
      </div>

      {/* 无任务时的非缺口提示；#376 归档态（终态项目历史任务数据已清理）换成归档说明 */}
      {delivery.wu.total === 0 && (
        <div className="text-xs u-text-3 mb-2">
          {delivery.archived ? '任务明细已归档：历史任务数据已清理，计数不可考' : '无关联任务'}
        </div>
      )}

      {/* 🆕 F6-c: 缺口行动清单（已完成但证据有缺口的 WU，逐行给补齐动作） */}
      {!delivery.deliverable && delivery.gaps.length > 0 && (
        <div className="mb-2">
          {delivery.wu.inFlight > 0 && (
            <div className="text-xs u-text-3 mb-1">{delivery.wu.inFlight} 个任务仍在途</div>
          )}
          <div className="space-y-1">
            {delivery.gaps.map(gap => (
              <div key={gap.id} className="flex items-center justify-between gap-2 text-xs u-surface-2 rounded px-2 py-1.5">
                <div className="min-w-0">
                  <span className="u-text font-medium">{gap.title}</span>
                  <span className="u-text-3 ml-1">{gap.type}</span>
                  <div className="u-warn">
                    {gap.missing.map(layer => GAP_LAYER_LABELS[layer]).join(' · ')}
                  </div>
                </div>
                <div className="flex gap-1 flex-shrink-0">
                  {/* AC-5: gap.id 即 WU id，直跳 WU 详情 */}
                  <button
                    onClick={() => navigate(`/workunits/${gap.id}`)}
                    className="btn btn-sm u-surface-2 u-text-2 u-hover-bg"
                  >
                    查看任务 ›
                  </button>
                  {gap.missing.includes('l1') && (
                    <button
                      onClick={() => handleGapAction(gap, 'verify')}
                      disabled={!!gapActionPending[`${gap.id}:verify`]}
                      className="btn btn-sm u-accent-dim u-accent u-hover-bg"
                    >
                      {gapActionPending[`${gap.id}:verify`] ? '验证中...' : '重跑验证'}
                    </button>
                  )}
                  {gap.missing.includes('l2') && (
                    <button
                      onClick={() => handleGapAction(gap, 'dispatchReview')}
                      disabled={!!gapActionPending[`${gap.id}:dispatchReview`]}
                      className="btn btn-sm u-accent-dim u-accent u-hover-bg"
                    >
                      {gapActionPending[`${gap.id}:dispatchReview`] ? '派发中...' : '派发评审'}
                    </button>
                  )}
                  {gap.missing.includes('l3') && (
                    <button
                      onClick={() => (gap.type === 'analysis' || gap.type === 'plan') ? openAnalysisApprove(gap) : handleGapAction(gap, 'reviewPassed')}
                      disabled={!!gapActionPending[`${gap.id}:reviewPassed`]}
                      className="btn btn-sm u-ok-dim u-ok u-hover-bg"
                    >
                      {gapActionPending[`${gap.id}:reviewPassed`] ? '确认中...' : '人工确认'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 已交付记录（时间 / 人 / commit 短哈希） */}
      {delivery.deliveredAt && (
        <div className="text-xs u-ok u-ok-dim rounded p-2 mb-2">
          已交付: {formatFullTime(delivery.deliveredAt)}
          {delivery.deliveredBy && ` · ${delivery.deliveredBy}`}
          {delivery.deliverCommit && ` · ${delivery.deliverCommit.slice(0, 7)}`}
        </div>
      )}

      {/* 交付动作：auto-merge 给按钮；branch-only 给说明 */}
      {delivery.policy === 'auto-merge' ? (
        <div>
          <button
            onClick={handleDeliver}
            disabled={delivering || !!delivery.deliveredAt}
            className="btn u-ok-bg u-on-accent u-hover-bg"
          >
            {delivering ? '交付中...' : delivery.deliveredAt ? '已交付' : '交付合并'}
          </button>
          {/* 409：缺口 / 冲突文件清单 */}
          {deliverError && (
            <div className="mt-2 text-xs u-err u-err-dim rounded p-2">
              <div className="font-medium mb-1">{deliverError.message}</div>
              {deliverError.missing && deliverError.missing.length > 0 && (
                <ul className="list-disc pl-5 space-y-0.5">
                  {deliverError.missing.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              )}
              {deliverError.conflictFiles && deliverError.conflictFiles.length > 0 && (
                <div className="mt-1">
                  冲突文件: {deliverError.conflictFiles.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        // branch-only：未交付时给「标记已交付」人工落档（#469：系统外合并后回填 commit，
        // 台账不再永停「✓ 可交付」）；证据齐时再附手动合并提示（证据未齐时缺口行动清单就是指引）
        !delivery.deliveredAt && (
          <div className="text-xs u-text-3">
            {delivery.deliverable && (
              <div className="mb-1">证据已齐:请合并分支 {delivery.branch} 并走下游发布链路</div>
            )}
            <div className="flex items-center gap-2">
              <input
                aria-label="合并 commit 哈希"
                className="input flex-1"
                placeholder="系统外已合并？填 commit 哈希落档"
                value={markCommit}
                onChange={e => setMarkCommit(e.target.value)}
              />
              <button
                onClick={handleMarkDelivered}
                disabled={marking || !markCommit.trim()}
                className="btn btn-sm u-ok-dim u-ok u-hover-bg"
              >
                {marking ? '落档中...' : '标记已交付'}
              </button>
            </div>
          </div>
        )
      )}
      {/* #106 M7：analysis/plan 缺口的共享确认弹窗（#463 起结构化评审表单 + 打回路径；#471 plan 同路） */}
      {approveGap && (
        <AnalysisApproveDialog
          prefill={approveGap.prefill}
          channelId={approveGap.channelId}
          confirmKind={approveGap.gap.type === 'plan' ? 'plan' : 'analysis'}
          onConfirm={async (confirm, assigneeId) => {
            // 批次A 项7：等动作结算后才关窗（失败 toast 在 handleGapAction 内）
            const gap = approveGap.gap;
            await handleGapAction(gap, 'reviewPassed', undefined, assigneeId, confirm);
            setApproveGap(null);
          }}
          onReject={async reason => {
            const gap = approveGap.gap;
            await workunitApi.reviewRejected(gap.id, reason);
            toast.success('已打回，待补充修订');
            setApproveGap(null);
            await onRefresh();
          }}
          onCancel={() => setApproveGap(null)}
        />
      )}
    </div>
  );
}

export default DeliveryPanel;
