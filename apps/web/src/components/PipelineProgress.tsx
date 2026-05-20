// PipelineProgress - Pipeline 执行进度条
import type { ExecutionState } from '../types';

interface PipelineProgressProps {
  execution: ExecutionState;
}

export function PipelineProgress({ execution }: PipelineProgressProps) {
  const { status, currentStep, totalSteps, steps } = execution;

  // 角色图标和颜色
  const roleConfig: Record<string, { icon: string; color: string; bgColor: string; name: string }> = {
    'requirements': { icon: '📋', color: '#3b82f6', bgColor: 'rgba(59,130,246,0.1)', name: '需求分析' },
    'rdqa': { icon: '🔄', color: '#9333ea', bgColor: 'rgba(147,51,234,0.1)', name: 'RDQA 评审' },
    'architecture': { icon: '🏗️', color: '#d97706', bgColor: 'rgba(217,119,6,0.1)', name: '架构设计' },
    'api-contract': { icon: '📜', color: '#6366f1', bgColor: 'rgba(99,102,241,0.1)', name: 'API 契约' },
    'shared-types': { icon: '📝', color: '#14b8a6', bgColor: 'rgba(20,184,166,0.1)', name: '类型定义' },
    'frontend': { icon: '🎨', color: '#06b6d4', bgColor: 'rgba(6,182,212,0.1)', name: '前端开发' },
    'frontend-mock': { icon: '🎭', color: '#ec4899', bgColor: 'rgba(236,72,153,0.1)', name: '前端 Mock' },
    'backend': { icon: '⚙️', color: '#10b981', bgColor: 'rgba(16,185,129,0.1)', name: '后端开发' },
    'test': { icon: '🧪', color: '#f97316', bgColor: 'rgba(249,115,22,0.1)', name: '测试' },
    'test-e2e': { icon: '🌐', color: '#3b82f6', bgColor: 'rgba(59,130,246,0.1)', name: 'E2E 测试' },
    'test-cycle': { icon: '🔄', color: '#f43f5e', bgColor: 'rgba(244,63,94,0.1)', name: '测试循环' },
    'review': { icon: '👀', color: '#8b5cf6', bgColor: 'rgba(139,92,246,0.1)', name: '代码审查' },
    'deploy': { icon: '🚀', color: '#22c55e', bgColor: 'rgba(34,197,94,0.1)', name: '部署上线' },
  };

  const getStatusIcon = (stepStatus: string) => {
    switch (stepStatus) {
      case 'succeeded': return '✅';
      case 'running': return '⏳';
      case 'failed': return '❌';
      case 'skipped': return '⏭️';
      default: return '⏸️';
    }
  };

  const progressPercent = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;

  return (
    <div style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-default)' }} className="shadow-sm">
      <div className="max-w-4xl mx-auto p-6">
        {/* 进度概览 */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{
              background: status === 'succeeded' ? 'rgba(34,197,94,0.15)' :
                          status === 'failed' ? 'rgba(239,68,68,0.15)' :
                          status === 'running' ? 'rgba(59,130,246,0.15)' : 'var(--bg-tertiary)'
            }}>
              {status === 'succeeded' ? '🎉' : status === 'failed' ? '❌' : status === 'running' ? '⏳' : '⏸️'}
            </div>
            <div>
              <h3 className="font-bold" style={{ color: 'var(--text-primary)' }}>
                {status === 'succeeded' ? '执行完成' :
                 status === 'failed' ? '执行失败' :
                 status === 'running' ? '执行中...' : '等待执行'}
              </h3>
              <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                步骤 {currentStep} / {totalSteps}
              </p>
            </div>
          </div>

          {/* 进度条 */}
          <div className="flex-1 max-w-xs mx-6">
            <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-tertiary)' }}>
              <div
                className="h-full transition-all duration-500"
                style={{
                  width: `${progressPercent}%`,
                  background: status === 'succeeded' ? 'var(--success)' :
                              status === 'failed' ? 'var(--error)' :
                              'linear-gradient(to right, #6366f1, #9333ea)'
                }}
              />
            </div>
            <div className="text-center text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>{progressPercent}%</div>
          </div>
        </div>

        {/* Pipeline 流程条 */}
        <div className="overflow-x-auto pb-2">
          <div className="flex items-center gap-1 min-w-max">
            {steps.map((step, index) => {
              const config = roleConfig[step.id] || { icon: '📦', color: 'var(--text-secondary)', bgColor: 'var(--bg-tertiary)', name: step.name };

              return (
                <div key={`${step.id}-${index}`} className="flex items-center">
                  {/* 步骤节点 */}
                  <div
                    className="flex flex-col items-center p-2 rounded-xl transition-all"
                    style={{
                      background: step.status === 'running' ? config.bgColor :
                                  step.status === 'succeeded' ? config.bgColor :
                                  step.status === 'failed' ? 'rgba(239,68,68,0.1)' : 'var(--bg-tertiary)',
                      outline: step.status === 'running' ? '2px solid #818cf8' : undefined,
                      outlineOffset: step.status === 'running' ? '-2px' : undefined,
                    }}
                  >
                    <div className="relative">
                      <span className="text-2xl">{config.icon}</span>
                      <span className="absolute -top-1 -right-1 text-xs">
                        {getStatusIcon(step.status)}
                      </span>
                    </div>
                    <span className="text-xs font-medium mt-1" style={{ color: config.color }}>
                      {config.name}
                    </span>
                    {step.status === 'running' && (
                      <span className="text-xs animate-pulse" style={{ color: '#818cf8' }}>执行中...</span>
                    )}
                  </div>

                  {/* 箭头 */}
                  {index < steps.length - 1 && (
                    <div className="mx-1 text-lg" style={{
                      color: steps[index + 1]?.status !== 'pending' ? '#818cf8' : 'var(--text-tertiary)'
                    }}>
                      →
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* 当前步骤详情 */}
        {status === 'running' && steps[currentStep - 1] && (
          <div className="mt-4 p-3 rounded-xl" style={{ background: 'rgba(59,130,246,0.1)' }}>
            <div className="flex items-center gap-2">
              <span className="animate-spin text-lg">⏳</span>
              <span className="font-medium" style={{ color: 'var(--accent-primary)' }}>
                正在执行：{roleConfig[steps[currentStep - 1].id]?.name || steps[currentStep - 1].name}
              </span>
            </div>
          </div>
        )}

        {/* 错误信息 */}
        {status === 'failed' && (
          <div className="mt-4 p-3 rounded-xl" style={{ background: 'rgba(239,68,68,0.1)' }}>
            <div className="flex items-center gap-2" style={{ color: 'var(--error)' }}>
              <span>❌</span>
              <span className="font-medium">执行失败</span>
            </div>
            {steps.find(s => s.status === 'failed')?.error && (
              <p className="text-sm mt-1" style={{ color: 'var(--error)', opacity: 0.8 }}>
                {steps.find(s => s.status === 'failed')?.error}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
