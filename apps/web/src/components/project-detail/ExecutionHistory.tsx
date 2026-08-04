// 执行历史卡 — 最近 5 条 Execution，含步骤进度条 + Timeline（AS-010 增强）
// 从 ProjectDetailPage 抽出
import { Timeline } from '../Timeline';
import type { StatsPhase } from '../../types';
import type { Project } from './types';

interface Props {
  project: Project;
}

export function ExecutionHistory({ project }: Props) {
  return (
    <div className="card p-4 mb-6">
      <h3 className="text-sm font-medium u-text-2 mb-3">📦 执行历史 ({project.Execution.length})</h3>
      <div className="space-y-3">
        {project.Execution.slice(0, 5).map(exec => {
          // 解析 steps 数据
          const steps = exec.steps ? (Array.isArray(exec.steps) ? exec.steps : Object.values(exec.steps)) : [];
          const currentStep = exec.currentStep || 0;
          const totalSteps = exec.totalSteps || steps.length || 1;
          const progressPercent = Math.round((currentStep / totalSteps) * 100);
          
          return (
            <div key={exec.id} className="p-3 u-surface-2 rounded border u-border">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="u-text text-sm font-mono">{exec.id.slice(0, 8)}</span>
                  {exec.workflowName && (
                    <span className="text-xs u-text-3">{exec.workflowName}</span>
                  )}
                </div>
                <span className={`text-xs px-2 py-1 rounded ${
                  exec.status === 'completed' || exec.status === 'succeeded' ? 'u-ok-dim u-ok' :
                  exec.status === 'running' ? 'u-accent-dim u-accent' :
                  exec.status === 'failed' ? 'u-err-dim u-err' :
                  'u-surface-2 u-text-2'
                }`}>
                  {exec.status === 'succeeded' ? '✅ 成功' :
                   exec.status === 'running' ? '⏳ 运行中' :
                   exec.status === 'failed' ? '❌ 失败' :
                   exec.status === 'completed' ? '✅ 完成' : exec.status}
                </span>
              </div>
              
              {/* 进度条 */}
              {(exec.status === 'running' || steps.length > 0) && (
                <div className="mb-2">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="flex-1 u-surface-2 rounded-full h-2">
                      <div 
                        className={`h-2 rounded-full transition-all ${
                          exec.status === 'running' ? 'u-accent-bg' :
                          exec.status === 'failed' ? 'u-err-bg' : 'u-ok-bg'
                        }`}
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                    <span className="text-xs u-text-2">{progressPercent}%</span>
                  </div>
                  <div className="text-xs u-text-3">
                    步骤 {currentStep} / {totalSteps}
                  </div>
                </div>
              )}
              
              {/* 时间线（如果有 steps） */}
              {steps.length > 0 && (
                <Timeline 
                  phases={steps as StatsPhase[]} 
                  executionId={exec.id}
                />
              )}
              
              {/* 时间戳 */}
              <div className="text-xs u-text-3 mt-2 flex gap-3">
                <span>创建: {new Date(exec.createdAt).toLocaleString('zh-CN')}</span>
                {exec.completedAt && (
                  <span>完成: {new Date(exec.completedAt).toLocaleString('zh-CN')}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
