// 项目进展卡（从 pages/ProjectDetailPage.tsx 抽取，工单 35-E4）
// #399（spec §8.2）新构成：progress 条 + %（--fs-stat mono）+「已完成 n/m」（完成数即
// progress 分子，同一行）+ Token meta（全周期累计）+ --fs-xs muted 口径副标题；
// 原 WU 链路六卡删除（状态计数唯一表达 = 进度管道泳道头）；证据警告条保留原位（白话词表）。
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
    <div className="card p-4 mb-6">
      <h3 className="text-sm font-medium u-text-2 mb-3">📈 项目进展</h3>

      {/* 主进度条 + % + 已完成 n/m + Token meta（全周期累计），同一行 */}
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
        <span className="font-mono font-bold u-text" style={{ fontSize: 'var(--fs-stat)' }}>{progress}%</span>
        {delivery && (
          <span className="text-sm u-text-2 flex-shrink-0">
            · 已完成 {delivery.wu.finished}/{delivery.wu.total} · 💰 {formatTokens(delivery.tokens)} tokens（全周期累计）
          </span>
        )}
      </div>
      {/* 口径副标题：可见小字，不用 tooltip（§8.2） */}
      {delivery && (
        <p className="u-text-3 mt-1 mb-3" style={{ fontSize: 'var(--fs-xs)' }}>
          完成数 = 已交付的任务，验收中的不计入
        </p>
      )}

      {/* 证据提示条：存量 completed 缺证据给警告；in_review 说明自动翻转 */}
      {projectStatus === 'completed' && delivery && !delivery.deliverable && evidenceGapSummary && (
        <div className="mt-3 text-xs u-warn u-warn-dim rounded p-2">
          ⚠️ 项目已标记完成，但交付证据未齐（{evidenceGapSummary}）——在上方交付卡补齐后才算真正交付
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
