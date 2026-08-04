// 项目进展卡 — 主进度条 + 统计卡（老 Task 链路五卡 / WU 链路六卡）+ 证据提示条（AS-010 增强）
// 从 ProjectDetailPage 抽出
import type { DeliveryStatus } from '../../api';
import type { Project, Task } from './types';

interface Props {
  project: Project;
  tasks: Task[];
  delivery: DeliveryStatus | null;
  progressStats: { completed: number; inProgress: number; pending: number; blocked: number; total: number; progress: number };
  tokenStats: number;
  evidenceGapSummary: string;
}

export function ProgressCard({ project, tasks, delivery, progressStats, tokenStats, evidenceGapSummary }: Props) {
  return (
    <div className="card p-4 mb-6">
      <h3 className="text-sm font-medium u-text-2 mb-3">📈 项目进展</h3>
      
      {/* 主进度条 */}
      <div className="flex items-center gap-3 mb-3">
        <div className="flex-1">
          <div className="h-4 u-surface-2 rounded-full overflow-hidden">
            <div 
              className={`h-full transition-all ${
                progressStats.progress === 100 ? 'u-ok-bg' :
                progressStats.progress > 50 ? 'u-accent-bg' :
                'u-warn-bg'
              }`}
              style={{ width: `${progressStats.progress}%` }}
            />
          </div>
        </div>
        <span style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-text">{progressStats.progress}%</span>
      </div>
      
      {/* 统计卡片：老 Task 链路五卡 / WU 链路六卡（tasks 为空且有台账时） */}
      {tasks.length === 0 && delivery ? (
        <div className="grid grid-cols-6 gap-2">
          <div className="p-2 rounded u-ok-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-ok">{delivery.wu.finished}</div>
            <div className="text-xs u-text-2">✅ 完成</div>
          </div>
          <div className="p-2 rounded u-warn-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-warn">{delivery.wu.byStatus.inReview}</div>
            <div className="text-xs u-text-2">👀 待验收</div>
          </div>
          <div className="p-2 rounded u-accent-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-accent">{delivery.wu.byStatus.active}</div>
            <div className="text-xs u-text-2">🔄 进行中</div>
          </div>
          <div className="p-2 rounded u-surface-2 text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-text-2">{delivery.wu.byStatus.unassigned}</div>
            <div className="text-xs u-text-2">⏳ 待领取</div>
          </div>
          <div className="p-2 rounded u-err-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-err">{delivery.wu.byStatus.blocked}</div>
            <div className="text-xs u-text-2">🚫 阻塞</div>
          </div>
          <div className="p-2 rounded u-accent-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-accent">{delivery.tokens.toLocaleString()}</div>
            <div className="text-xs u-text-2">💰 Token</div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-5 gap-2">
          <div className="p-2 rounded u-ok-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-ok">{progressStats.completed}</div>
            <div className="text-xs u-text-2">✅ 完成</div>
          </div>
          <div className="p-2 rounded u-accent-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-accent">{progressStats.inProgress}</div>
            <div className="text-xs u-text-2">🔄 进行中</div>
          </div>
          <div className="p-2 rounded u-surface-2 text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-text-2">{progressStats.pending}</div>
            <div className="text-xs u-text-2">⏳ 待领取</div>
          </div>
          <div className="p-2 rounded u-err-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-err">{progressStats.blocked}</div>
            <div className="text-xs u-text-2">🚫 阻塞</div>
          </div>
          <div className="p-2 rounded u-accent-dim text-center">
            <div style={{ fontSize: 'var(--fs-stat)' }} className="font-bold u-accent">{tokenStats.toLocaleString()}</div>
            <div className="text-xs u-text-2">💰 Token</div>
          </div>
        </div>
      )}

      {/* 证据提示条：存量 completed 缺证据给警告；in_review 说明自动翻转 */}
      {project.status === 'completed' && delivery && !delivery.deliverable && evidenceGapSummary && (
        <div className="mt-3 text-xs u-warn u-warn-dim rounded p-2">
          ⚠️ 项目已标记完成，但交付证据未齐（{evidenceGapSummary}）——在上方交付卡补齐后才算真正交付
        </div>
      )}
      {project.status === 'in_review' && delivery && !delivery.deliverable && (
        <div className="mt-3 text-xs u-accent u-accent-dim rounded p-2">
          交付证据补齐后，项目将自动标记完成
        </div>
      )}
    </div>
  );
}
