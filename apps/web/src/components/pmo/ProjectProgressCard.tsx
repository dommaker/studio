// 项目进展卡（从 pages/ProjectDetailPage.tsx 抽取，工单 35-E4）
// #399（spec §8.2）新构成：progress 条 + %（--fs-stat mono）+ Token meta（全周期累计）
// + --fs-xs muted 口径副标题；原 WU 链路六卡删除（状态计数唯一表达 = 进度管道泳道头）。
// #474 减噪：折叠为次要块——头部恒显「项目进展 + %」，详情默认收起（点「展开」看进度条/
// Token/口径副标题）；「已完成 n/m」删除（与 DeliveryPanel 台账「任务: n/m 完成」重复，
// 同一事实只表达一次）；证据警告条保留原位（去 ⚠️ emoji，警告色自承载语义）。
import { useState } from 'react';
import type { DeliveryStatus } from '../../api';
import { EVIDENCE_LAYER_LABELS } from './pipelineUtils';

/** k/M 缩写（与 ManualTaskButton 的 formatTokens 同款） */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface ProjectProgressCardProps {
  progress: number;
  delivery: DeliveryStatus | null;
  projectStatus: string;
}

export function ProjectProgressCard({ progress, delivery, projectStatus }: ProjectProgressCardProps) {
  // #474：次要块默认折叠（与「项目动态」收起层同款交互），% 提头部恒显
  const [expanded, setExpanded] = useState(false);
  // #376 归档口径：终态项目实时重算零 WU（progress 是完成时历史快照，任务数据已清理），
  // 「已完成 0/0 · 0 tokens」是归档分叉假象 → 显示归档提示取代实时计数
  const archived = delivery?.archived === true;
  // 证据缺口摘要（缺的层为 0 不显示；§8.3 白话词表 EVIDENCE_LAYER_LABELS）
  const gaps = delivery
    ? [
        { label: EVIDENCE_LAYER_LABELS.l1, n: delivery.evidence.l1Missing.length },
        { label: EVIDENCE_LAYER_LABELS.l2, n: delivery.evidence.l2Missing.length },
        { label: EVIDENCE_LAYER_LABELS.l3, n: delivery.evidence.l3Missing.length },
      ].filter(g => g.n > 0)
    : [];
  const evidenceGapSummary = gaps
    .map((g, i) => (i === 0 ? `${g.n} 个任务缺${g.label}` : `${g.n} 个缺${g.label}`))
    .join(' · ');

  return (
    <div className="card p-4 mb-3">
      {/* 头部：标签 + % 恒显 + 展开/收起（详情为次要信息，默认收） */}
      <div className="flex items-center justify-between">
        <h3 className="mc-block-label mc-block-label-flush">项目进展</h3>
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold u-text" style={{ fontSize: 'var(--fs-stat)' }}>{progress}%</span>
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-xs u-accent u-btn-reset"
          >
            {expanded ? '收起' : '展开'}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3">
          {/* 进度条 + Token meta（全周期累计）；「已完成 n/m」已删——交付台账「任务: n/m 完成」为唯一表达 */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <div className="h-4 u-surface-2 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    progress === 100 ? 'u-ok-bg' :
                    progress > 50 ? 'u-accent-bg' :
                    'u-warn-bg'
                  }`}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
            {delivery && !archived && (
              <span className="text-sm u-text-2 flex-shrink-0">
                {formatTokens(delivery.tokens)} tokens（全周期累计）
              </span>
            )}
            {archived && (
              <span className="text-sm u-text-3 flex-shrink-0">任务明细已归档</span>
            )}
          </div>
          {/* 口径副标题：可见小字，不用 tooltip（§8.2）；归档态换成快照口径说明 */}
          {delivery && !archived && (
            <p className="u-text-3 mt-1 mb-3" style={{ fontSize: 'var(--fs-xs)' }}>
              完成数 = 已交付的任务，验收中的不计入
            </p>
          )}
          {archived && (
            <p className="u-text-3 mt-1 mb-3" style={{ fontSize: 'var(--fs-xs)' }}>
              任务明细已归档：百分比为完成时快照，完成数与 Token 为实时重算口径，历史任务数据已清理
            </p>
          )}
        </div>
      )}

      {/* 证据提示条：存量 completed 缺证据给警告；in_review 说明自动翻转（#474 去 ⚠️ emoji） */}
      {projectStatus === 'completed' && delivery && !delivery.deliverable && evidenceGapSummary && (
        <div className="mt-3 text-xs u-warn u-warn-dim rounded p-2">
          项目已标记完成，但交付证据未齐（{evidenceGapSummary}）——在上方交付卡补齐后才算真正交付
        </div>
      )}
      {projectStatus === 'in_review' && delivery && !delivery.deliverable && (
        <div className="mt-3 text-xs u-accent u-accent-dim rounded p-2">
          交付证据补齐后，项目将自动标记完成
        </div>
      )}
    </div>
  );
}
