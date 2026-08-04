/**
 * 检查点时间线组件（深色主题）
 * 
 * 在工作流执行过程中，显示检查点的验证状态
 */

import React from 'react';
import '../styles/theme.css';

export interface CheckpointCheck {
  checkId: string;
  passed: boolean;
  message: string;
  actual?: any;
  expected?: any;
  error?: string;
}

export interface CheckpointResult {
  checkpointId: string;
  passed: boolean;
  checks: CheckpointCheck[];
  message: string;
  validatedAt: string;
}

export interface CheckpointTimelineProps {
  checkpoints: CheckpointResult[];
  title?: string;
}

export const CheckpointTimeline: React.FC<CheckpointTimelineProps> = ({
  checkpoints,
  title = '检查点验证',
}) => {
  if (!checkpoints || checkpoints.length === 0) {
    return (
      <div className="p-4" style={{ color: 'var(--text-tertiary)' }}>
        无检查点数据
      </div>
    );
  }

  return (
    <div className="checkpoint-timeline">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        <div className="flex items-center gap-2 text-sm">
          <span style={{ color: 'var(--success)' }}>
            ✓ {checkpoints.filter(c => c.passed).length} 通过
          </span>
          <span style={{ color: 'var(--error)' }}>
            ✗ {checkpoints.filter(c => !c.passed).length} 失败
          </span>
        </div>
      </div>

      {/* Timeline */}
      <div className="space-y-4">
        {checkpoints.map((checkpoint, index) => (
          <div
            key={checkpoint.checkpointId || index}
            className="checkpoint-item border rounded-lg p-4"
            style={{
              borderColor: checkpoint.passed ? 'var(--success-border)' : 'var(--error-border)',
              background: checkpoint.passed ? 'var(--success-dim)' : 'var(--error-dim)'
            }}
          >
            {/* Checkpoint Header */}
            <div className="flex items-center gap-3 mb-3">
              <span className="text-xl">
                {checkpoint.passed ? '✅' : '❌'}
              </span>
              <div className="flex-1">
                <div className="font-medium" style={{ color: 'var(--text-primary)' }}>
                  {checkpoint.checkpointId}
                </div>
                <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {checkpoint.message}
                </div>
              </div>
              <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {new Date(checkpoint.validatedAt).toLocaleTimeString()}
              </div>
            </div>

            {/* Checks */}
            {checkpoint.checks && checkpoint.checks.length > 0 && (
              <div className="ml-8 space-y-2">
                {checkpoint.checks.map((check, checkIndex) => (
                  <div
                    key={check.checkId || checkIndex}
                    className="flex items-center gap-2 text-sm"
                    style={{ color: check.passed ? 'var(--success)' : 'var(--error)' }}
                  >
                    <span>{check.passed ? '✓' : '✗'}</span>
                    <span>{check.message}</span>
                    {check.error && (
                      <span className="text-xs" style={{ color: 'var(--error)' }}>
                        ({check.error})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default CheckpointTimeline;
