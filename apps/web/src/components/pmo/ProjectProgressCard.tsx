// 项目进展卡（从 pages/ProjectDetailPage.tsx 抽取，工单 35-E4）：主进度条 + WU 链路六卡统计 + 证据警告条
import type { DeliveryStatus } from '../../api';

interface ProjectProgressCardProps {
  progress: number;
  delivery: DeliveryStatus | null;
  projectStatus: string;
}

export function ProjectProgressCard({ progress, delivery, projectStatus }: ProjectProgressCardProps) {
  // 证据缺口摘要（L1/L2/L3 缺的层为 0 不显示），用于进展卡的琥珀警告条
  const evidenceGapSummary = delivery
    ? [
        { label: 'L1', n: delivery.evidence.l1Missing.length },
        { label: 'L2', n: delivery.evidence.l2Missing.length },
        { label: 'L3', n: delivery.evidence.l3Missing.length },
      ]
        .filter(g => g.n > 0)
        .map(g => `${g.label} 缺 ${g.n}`)
        .join(' · ')
    : '';

  return (
    <div className="card p-4 mb-6">
      <h3 className="text-sm font-medium u-text-2 mb-3">📈 项目进展</h3>

      {/* 主进度条 */}
      <div className="flex items-center gap-3 mb-3">
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
        <span className="text-2xl font-bold u-text">{progress}%</span>
      </div>

      {/* 统计卡片：WU 链路六卡（Card 7：老 Task 链路五卡已随双轨删除） */}
      {delivery && (
        <div className="grid grid-cols-6 gap-2">
          <div className="p-2 rounded u-ok-dim text-center">
            <div className="text-lg font-bold u-ok">{delivery.wu.finished}</div>
            <div className="text-xs u-text-2">✅ 完成</div>
          </div>
          <div className="p-2 rounded u-warn-dim text-center">
            <div className="text-lg font-bold u-warn">{delivery.wu.byStatus.inReview}</div>
            <div className="text-xs u-text-2">👀 待验收</div>
          </div>
          <div className="p-2 rounded u-accent-dim text-center">
            <div className="text-lg font-bold u-accent">{delivery.wu.byStatus.active}</div>
            <div className="text-xs u-text-2">🔄 进行中</div>
          </div>
          <div className="p-2 rounded u-surface-2 text-center">
            <div className="text-lg font-bold u-text-2">{delivery.wu.byStatus.unassigned}</div>
            <div className="text-xs u-text-2">⏳ 待领取</div>
          </div>
          <div className="p-2 rounded u-err-dim text-center">
            <div className="text-lg font-bold u-err">{delivery.wu.byStatus.blocked}</div>
            <div className="text-xs u-text-2">🚫 阻塞</div>
          </div>
          <div className="p-2 rounded u-accent-dim text-center">
            <div className="text-lg font-bold u-accent">{delivery.tokens.toLocaleString()}</div>
            <div className="text-xs u-text-2">💰 Token</div>
          </div>
        </div>
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
