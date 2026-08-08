// 交付卡 — PMO-b 台账 + human-only 合并（409 展示缺口/冲突清单）+ F6-c 缺口行动清单
// 从 ProjectDetailPage 抽出；GAP_LAYER_LABELS 常量随本区块搬走
import { useNavigate } from 'react-router-dom';
import type { DeliveryStatus, DeliveryGap } from '../../api';

// 🆕 F6-c: 缺口层 → 人话文案
const GAP_LAYER_LABELS: Record<'l1' | 'l2' | 'l3', string> = {
  l1: '缺 L1 自动验证',
  l2: '缺 L2 agent 评审',
  l3: '缺 L3 人工确认',
};

interface Props {
  delivery: DeliveryStatus;
  delivering: boolean;
  deliverError: { message: string; missing?: string[]; conflictFiles?: string[] } | null;
  gapActionPending: Record<string, boolean>;
  handleGapAction: (gap: DeliveryGap, action: 'verify' | 'dispatchReview' | 'reviewPassed') => Promise<void>;
  handleDeliver: () => Promise<void>;
}

export function DeliveryCard({ delivery, delivering, deliverError, gapActionPending, handleGapAction, handleDeliver }: Props) {
  const navigate = useNavigate();
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
                      onClick={() => handleGapAction(gap, 'reviewPassed')}
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
          已交付: {new Date(delivery.deliveredAt).toLocaleString('zh-CN')}
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
    </div>
  );
}
