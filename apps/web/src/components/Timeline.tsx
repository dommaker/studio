// Timeline - 时间线组件（横向版本）
import { useState } from 'react';
import type { StatsPhase } from '../types';

interface TimelineProps {
  phases: StatsPhase[];
  executionId?: string;
  onStepClick?: (phase: StatsPhase) => void;
}

export function Timeline( { phases, executionId, onStepClick }: TimelineProps) {
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  // 计算步骤耗时
  const getDuration = (phase: StatsPhase) => {
    if (!phase.startedAt) return null;
    const start = new Date(phase.startedAt).getTime();
    const end = phase.completedAt ? new Date(phase.completedAt).getTime() : Date.now();
    const diff = Math.floor((end - start) / 1000);
    if (diff < 60) return `${diff}秒`;
    if (diff < 3600) return `${Math.floor(diff / 60)}分${diff % 60}秒`;
    return `${Math.floor(diff / 3600)}时${Math.floor((diff % 3600) / 60)}分`;
  };

  return (
    <div className="timeline-horizontal">
      {/* 横向时间线 */}
      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {phases.map((phase, index) => {
          const isLast = index === phases.length - 1;

          return (
            <div key={`${phase.id}-${index}`} className="flex items-center flex-shrink-0">
              {/* 步骤节点 */}
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg border transition-all cursor-pointer"
                style={{
                  background: phase.status === 'running' ? 'rgba(0, 212, 255, 0.1)' :
                    phase.status === 'succeeded' || phase.status === 'completed' ? 'rgba(16, 185, 129, 0.1)' :
                    phase.status === 'failed' ? 'rgba(239, 68, 68, 0.1)' :
                    'var(--bg-tertiary)',
                  color: phase.status === 'running' ? 'var(--accent-primary)' :
                    phase.status === 'succeeded' || phase.status === 'completed' ? 'var(--success)' :
                    phase.status === 'failed' ? 'var(--error)' :
                    'var(--text-secondary)',
                  borderColor: phase.status === 'running' ? 'var(--accent-primary)' :
                    phase.status === 'succeeded' || phase.status === 'completed' ? 'var(--success)' :
                    phase.status === 'failed' ? 'var(--error)' :
                    'var(--border-subtle)',
                  boxShadow: phase.status === 'running' ? '0 0 12px var(--accent-glow)' : 'none',
                }}
                onClick={() => {
                  setExpandedStep(expandedStep === phase.id ? null : phase.id);
                  onStepClick?.(phase);
                }}
              >
                {/* 状态图标 */}
                <span className="text-lg">
                  {phase.status === 'running' ? '⏳' :
                   phase.status === 'succeeded' || phase.status === 'completed' ? '✅' :
                   phase.status === 'failed' ? '❌' :
                   '⏸️'}
                </span>
                {/* 步骤名称 */}
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{phase.name}</span>
                  {getDuration(phase) && (
                    <span className="text-xs opacity-70">{getDuration(phase)}</span>
                  )}
                </div>
              </div>

              {/* 连接箭头 */}
              {!isLast && (
                <div 
                  className="mx-2 text-lg"
                  style={{ color: phases[index + 1]?.status !== 'pending' ? 'var(--success)' : 'var(--text-muted)' }}
                >
                  →
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 展开的详情 */}
      {expandedStep && phases.find(phase => phase.id === expandedStep) && (
        <div 
          className="mt-3 p-3 rounded-lg text-sm"
          style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-subtle)' }}
        >
          {(() => {
            const phase = phases.find(p => p.id === expandedStep)!;
            return (
              <>
                <div className="font-medium mb-2" style={{ color: 'var(--text-primary)' }}>{phase.name}</div>
                <div style={{ color: 'var(--text-secondary)' }}>
                  状态：{phase.status === 'succeeded' || phase.status === 'completed' ? '✅ 成功' :
                         phase.status === 'failed' ? '❌ 失败' :
                         phase.status === 'running' ? '⏳ 运行中' :
                         '⏸️ 待执行'}
                </div>
                {phase.error && (
                  <div className="mt-2" style={{ color: 'var(--error)' }}>错误：{phase.error}</div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* 图例 */}
      <div className="flex items-center gap-4 mt-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
        <span>⏸️ 待执行</span>
        <span>⏳ 运行中</span>
        <span>✅ 已完成</span>
        <span>❌ 失败</span>
      </div>
    </div>
  );
}

export default Timeline;
