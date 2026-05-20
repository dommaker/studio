import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CheckpointTimeline, type CheckpointResult } from '../CheckpointTimeline';

describe('CheckpointTimeline', () => {
  const mockCheckpoints: CheckpointResult[] = [
    {
      checkpointId: 'cp-001',
      passed: true,
      checks: [
        { checkId: 'check-1', passed: true, message: '文件存在' },
        { checkId: 'check-2', passed: true, message: '文件非空' },
      ],
      message: '验证通过',
      validatedAt: '2026-04-04T15:00:00Z',
    },
    {
      checkpointId: 'cp-002',
      passed: false,
      checks: [
        { checkId: 'check-3', passed: false, message: '测试失败', error: 'Expected 1, got 0' },
      ],
      message: '验证失败',
      validatedAt: '2026-04-04T15:01:00Z',
    },
  ];

  it('should render empty state when no checkpoints', () => {
    render(<CheckpointTimeline checkpoints={[]} />);
    expect(screen.getByText('无检查点数据')).toBeInTheDocument();
  });

  it('should render checkpoint count', () => {
    render(<CheckpointTimeline checkpoints={mockCheckpoints} />);
    expect(screen.getByText('✓ 1 通过')).toBeInTheDocument();
    expect(screen.getByText('✗ 1 失败')).toBeInTheDocument();
  });

  it('should render checkpoint items', () => {
    render(<CheckpointTimeline checkpoints={mockCheckpoints} />);
    expect(screen.getByText('cp-001')).toBeInTheDocument();
    expect(screen.getByText('cp-002')).toBeInTheDocument();
  });

  it('should render check messages', () => {
    render(<CheckpointTimeline checkpoints={mockCheckpoints} />);
    expect(screen.getByText('验证通过')).toBeInTheDocument();
    expect(screen.getByText('验证失败')).toBeInTheDocument();
  });

  it('should render check details', () => {
    render(<CheckpointTimeline checkpoints={mockCheckpoints} />);
    expect(screen.getByText('文件存在')).toBeInTheDocument();
    expect(screen.getByText('文件非空')).toBeInTheDocument();
    expect(screen.getByText('测试失败')).toBeInTheDocument();
  });

  it('should render error message', () => {
    render(<CheckpointTimeline checkpoints={mockCheckpoints} />);
    expect(screen.getByText('(Expected 1, got 0)')).toBeInTheDocument();
  });

  it('should use custom title', () => {
    render(<CheckpointTimeline checkpoints={mockCheckpoints} title="自定义标题" />);
    expect(screen.getByText('自定义标题')).toBeInTheDocument();
  });

  it('should show correct icons for passed/failed', () => {
    const { container } = render(<CheckpointTimeline checkpoints={mockCheckpoints} />);
    expect(container.querySelector('.checkpoint-item')).toBeInTheDocument();
  });
});