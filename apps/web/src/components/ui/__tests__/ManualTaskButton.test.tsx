import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// React 19 CJS interop: `act` is an ESM-only named export（与 MonitoringPage.test.tsx 同款 polyfill）
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockSuccess, mockError } = vi.hoisted(() => ({
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));
vi.mock('../../../utils/toast', () => ({
  toast: { success: mockSuccess, error: mockError },
}));

import { ManualTaskButton } from '../ManualTaskButton';

describe('ManualTaskButton', () => {
  it('点击 → loading（disabled + 运行中…）→ 成功 toast 展示 onRun 返回的文案', async () => {
    let resolveRun!: (msg: string) => void;
    const onRun = vi.fn(() => new Promise<string>((res) => { resolveRun = res; }));
    render(<ManualTaskButton label="🧪 测试任务" onRun={onRun} />);

    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('🧪 测试任务');

    fireEvent.click(btn);
    expect(onRun).toHaveBeenCalledTimes(1);
    // loading 态
    expect(btn).toBeDisabled();
    expect(btn.textContent).toBe('运行中…');

    resolveRun('任务完成');
    await waitFor(() => expect(btn.textContent).toBe('🧪 测试任务'));
    expect(mockSuccess).toHaveBeenCalledWith('任务完成');
    expect(btn).not.toBeDisabled();
  });

  it('失败时 toast.error 取后端 error.message，无 message 时兜底「执行失败」', async () => {
    const onRun = vi.fn()
      .mockRejectedValueOnce({ response: { data: { error: { message: '触发器不存在' } } } })
      .mockRejectedValueOnce(new Error('network'));
    render(<ManualTaskButton label="任务" onRun={onRun} />);
    const btn = screen.getByRole('button');

    fireEvent.click(btn);
    await waitFor(() => expect(mockError).toHaveBeenCalledWith('触发器不存在'));

    fireEvent.click(btn);
    await waitFor(() => expect(mockError).toHaveBeenCalledWith('执行失败'));
  });

  it('costTokens 渲染近 30 天成本小字（k 缩写）', () => {
    render(<ManualTaskButton label="任务" onRun={vi.fn()} costTokens={12345} />);
    expect(screen.getByText('近 30 天 ≈12.3k tokens')).toBeInTheDocument();
  });

  it('costNote 优先于 costTokens 渲染（token 记账缺失时展示调用次数）', () => {
    render(<ManualTaskButton label="任务" onRun={vi.fn()} costTokens={12345} costNote="近 30 天 32 次调用" />);
    expect(screen.getByText('近 30 天 32 次调用')).toBeInTheDocument();
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
  });
});
