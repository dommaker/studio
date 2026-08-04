// 任务看板 — 四列状态分组 + AS-018 Iron Law 警告横幅
// 从 ProjectDetailPage 抽出
import { IronLawWarningBanner } from '../IronLawWarningBanner';
import type { Task } from './types';

interface Props {
  tasks: Task[];
  tasksByStatus: { pending: Task[]; inProgress: Task[]; completed: Task[]; blocked: Task[] };
}

export function TaskBoard({ tasks, tasksByStatus }: Props) {
  return (
    <div className="card p-4 mb-6">
      <h3 className="text-sm font-medium u-text-2 mb-3">📋 任务看板 ({tasks.length})</h3>
      
      {/* 🆕 AS-018: Iron Law 警告横幅 */}
      {(tasksByStatus.inProgress.length > 0 || tasksByStatus.completed.length > 0) && (
        <IronLawWarningBanner
          scenario="task_complete"
          hasTestEvidence={false}
          hasVerification={false}
          hasRequirementReview={false}
        />
      )}
      
      <div className="grid grid-cols-4 gap-2">
        {/* 待领取 */}
        <div className="p-3 rounded u-surface-2">
          <div className="text-xs u-text-2 mb-2">待领取 ({tasksByStatus.pending.length})</div>
          <div className="space-y-2">
            {tasksByStatus.pending.map(task => (
              <div key={task.id} className="p-2 u-surface rounded text-sm">
                <div className="font-medium">{task.name}</div>
                <div className="text-xs u-text-3">{task.assignee}</div>
              </div>
            ))}
          </div>
        </div>
        {/* 进行中 */}
        <div className="p-3 rounded u-accent-dim">
          <div className="text-xs u-accent mb-2">进行中 ({tasksByStatus.inProgress.length})</div>
          <div className="space-y-2">
            {tasksByStatus.inProgress.map(task => (
              <div key={task.id} className="p-2 u-surface rounded text-sm">
                <div className="font-medium">{task.name}</div>
                <div className="text-xs u-text-3">{task.ClaimedBy?.name || task.assignee}</div>
              </div>
            ))}
          </div>
        </div>
        {/* 已完成 */}
        <div className="p-3 rounded u-ok-dim">
          <div className="text-xs u-ok mb-2">已完成 ({tasksByStatus.completed.length})</div>
          <div className="space-y-2">
            {tasksByStatus.completed.map(task => (
              <div key={task.id} className="p-2 u-surface rounded text-sm">
                <div className="font-medium">{task.name}</div>
                <div className="text-xs u-text-3">✅</div>
              </div>
            ))}
          </div>
        </div>
        {/* 阻塞 */}
        <div className="p-3 rounded u-err-dim">
          <div className="text-xs u-err mb-2">阻塞 ({tasksByStatus.blocked.length})</div>
          <div className="space-y-2">
            {tasksByStatus.blocked.map(task => (
              <div key={task.id} className="p-2 u-surface rounded text-sm">
                <div className="font-medium">{task.name}</div>
                <div className="text-xs u-err">依赖: {task.dependsOn.length}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
