/**
 * DeliveryPanel - PMO-b/F6-c 交付面板（Card 7 从 ProjectDetailPage 抽取）
 *
 * 交付台账 + human-only 交付合并 + 缺口行动（重跑 L1 验证 / 派发 L2 评审 / L3 人工确认）。
 * 状态码 → toast 矩阵集中在 handleGapAction，可单测。
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { projectApi, type DeliveryStatus, type DeliveryGap } from '../../api';
import { workunitApi } from '../../api/workunit';
import { formatFullTime } from '../../utils/datetime';
import { toast } from '../../utils/toast';
import { AnalysisApproveDialog } from './AnalysisApproveDialog';
import { buildMapOpeningPrefill } from './mapUtils';

// 🆕 F6-c: 缺口层 → 人话文案
const GAP_LAYER_LABELS: Record<'l1' | 'l2' | 'l3', string> = {
  l1: '缺 L1 自动验证',
  l2: '缺 L2 agent 评审',
  l3: '缺 L3 人工确认',
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
  // #106 M7：analysis 缺口的「人工确认」走共享确认弹窗（预填待决问题清单 → 人改 → 带 summary 提交）
  const [approveGap, setApproveGap] = useState<{ gap: DeliveryGap; prefill: string; channelId: string | null } | null>(null);

  // analysis 缺口开弹窗：gaps 列表无 metadata，best-effort 拉 WU 详情取预填（拉不到 → 空手填）
  // #177：同时取 channelId 喂弹窗的「默认执行角色」下拉（候选=频道成员）
  const openAnalysisApprove = async (gap: DeliveryGap) => {
    let prefill = '';
    let channelId: string | null = null;
    try {
      const res = await workunitApi.get(gap.id);
      prefill = buildMapOpeningPrefill(res.data?.metadata);
      channelId = res.data?.channelId ?? null;
    } catch { /* best-effort */ }
    setApproveGap({ gap, prefill, channelId });
  };

  // 🆕 F6-c: 缺口行动——重跑 L1 验证 / 补派 L2 评审 / L3 人工确认
  const handleGapAction = async (gap: DeliveryGap, action: 'verify' | 'dispatchReview' | 'reviewPassed', summary?: string, assigneeId?: string) => {
    const key = `${gap.id}:${action}`;
    setGapActionPending(prev => ({ ...prev, [key]: true }));
    try {
      if (action === 'verify') {
        const res = await workunitApi.verify(gap.id);
        if (res.data?.verified) {
          toast.success('验证通过，L1 已补齐');
          await onRefresh();
        } else {
          const failedCmds = (res.data?.failed || []).map((f: { command: string }) => f.command).join('；');
          toast.error(`验证未通过${failedCmds ? `：${failedCmds}` : ''}`);
        }
      } else if (action === 'dispatchReview') {
        await workunitApi.dispatchReview(gap.id);
        toast.success('已创建评审 WorkUnit，待 agent 认领');
        await onRefresh();
      } else {
        await workunitApi.reviewPassed(gap.id, summary, assigneeId);
        toast.success('已确认，L3 已补齐');
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

  return (
    <div className="card p-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium u-text-2">📦 交付</h3>
        {delivery.deliveredAt ? (
          <span className="text-xs px-2 py-1 rounded u-ok-dim u-ok font-medium">✓ 已交付</span>
        ) : delivery.deliverable ? (
          <span className="text-xs px-2 py-1 rounded u-ok-dim u-ok font-medium">✓ 可交付</span>
        ) : delivery.wu.inFlight > 0 ? (
          <span className="text-xs px-2 py-1 rounded u-accent-dim u-accent font-medium">
            🔄 进行中 {delivery.wu.finished}/{delivery.wu.total}
          </span>
        ) : (
          <span className="text-xs px-2 py-1 rounded u-warn-dim u-warn font-medium">
            ⏳ 待验收:证据还差 {delivery.evidence.l1Missing.length + delivery.evidence.l2Missing.length + delivery.evidence.l3Missing.length} 项
          </span>
        )}
      </div>

      {/* 台账概览：策略 / 分支 / WU 完成度 / 证据三层 / 自评 */}
      <div className="text-sm u-text-2 flex flex-wrap gap-x-4 gap-y-1 mb-2">
        <span>交付策略: {delivery.policy === 'auto-merge' ? '自动合并' : '分支交付'}</span>
        <span>分支: {delivery.branch || '—'}</span>
        <span>WU: {delivery.wu.finished}/{delivery.wu.total} 完成</span>
        <span>L1: {delivery.evidence.l1Missing.length === 0 ? '✓' : `缺 ${delivery.evidence.l1Missing.length}`}</span>
        <span>L2: {delivery.evidence.l2Missing.length === 0 ? '✓' : `缺 ${delivery.evidence.l2Missing.length}`}</span>
        <span>L3: {delivery.evidence.l3Missing.length === 0 ? '✓' : `缺 ${delivery.evidence.l3Missing.length}`}</span>
        <span>自评: {delivery.evidence.selfReviewCount}</span>
      </div>

      {/* 无 WU 时的非缺口提示 */}
      {delivery.wu.total === 0 && (
        <div className="text-xs u-text-3 mb-2">无关联 WorkUnit</div>
      )}

      {/* 🆕 F6-c: 缺口行动清单（已完成但证据有缺口的 WU，逐行给补齐动作） */}
      {!delivery.deliverable && delivery.gaps.length > 0 && (
        <div className="mb-2">
          {delivery.wu.inFlight > 0 && (
            <div className="text-xs u-text-3 mb-1">{delivery.wu.inFlight} 个 WorkUnit 仍在途</div>
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
                    查看 WU ›
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
                      onClick={() => gap.type === 'analysis' ? openAnalysisApprove(gap) : handleGapAction(gap, 'reviewPassed')}
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
        // branch-only：证据齐且未交付才提示手动合并；证据未齐时缺口行动清单就是指引
        delivery.deliverable && !delivery.deliveredAt && (
          <div className="text-xs u-text-3">
            证据已齐:请合并分支 {delivery.branch} 并走下游发布链路
          </div>
        )
      )}
      {/* #106 M7：analysis 缺口的共享确认弹窗 */}
      {approveGap && (
        <AnalysisApproveDialog
          prefill={approveGap.prefill}
          channelId={approveGap.channelId}
          onConfirm={(summary, assigneeId) => {
            const gap = approveGap.gap;
            setApproveGap(null);
            handleGapAction(gap, 'reviewPassed', summary, assigneeId);
          }}
          onCancel={() => setApproveGap(null)}
        />
      )}
    </div>
  );
}

export default DeliveryPanel;
