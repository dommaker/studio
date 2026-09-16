// ApproveDialogShell — 审批弹窗公共壳：标题/children 渲染、固定取消键、
// run 提交包装（防重入 + 失败内联保持打开 + 提交中屏蔽关窗路径）、actions render prop ctx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ApproveDialogShell } from '../ApproveDialogShell';
import { Button } from '../Button';

function setup({ onAction = vi.fn(), onCancel = vi.fn() } = {}) {
  render(
    <ApproveDialogShell
      title="确认测试"
      maxWidth="28rem"
      onCancel={onCancel}
      actions={({ submitting, run }) => (
        <Button variant="primary" loading={submitting} onClick={() => void run(() => onAction())}>
          确认
        </Button>
      )}
    >
      <p>表单差异内容</p>
    </ApproveDialogShell>,
  );
  return { onAction, onCancel };
}

describe('ApproveDialogShell（审批弹窗公共壳）', () => {
  it('渲染标题/children/固定取消键；取消键 → onCancel', () => {
    const { onCancel } = setup();
    expect(screen.getByText('确认测试')).toBeInTheDocument();
    expect(screen.getByText('表单差异内容')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('actions ctx：确认键经 run 触发动作回调', async () => {
    const { onAction } = setup();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
  });

  it('提交中：动作键 loading/禁用 + 取消键禁用，遮罩/Escape/✕ 关窗被屏蔽；结算后恢复', async () => {
    let resolve: () => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    const onCancel = vi.fn();
    const { container } = render(
      <ApproveDialogShell
        title="确认测试"
        onCancel={onCancel}
        actions={({ submitting, run }) => (
          <Button variant="primary" loading={submitting} onClick={() => void run(() => onAction())}>
            确认
          </Button>
        )}
      >
        <p>body</p>
      </ApproveDialogShell>,
    );

    const confirmBtn = screen.getByRole('button', { name: '确认' });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(confirmBtn).toBeDisabled());
    expect(confirmBtn).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(container.querySelector('.modal-overlay')!);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(confirmBtn).not.toBeDisabled());
  });

  it('动作 reject → 弹窗保持打开 + 内联错误行；重试成功清错误行', async () => {
    const onAction = vi.fn()
      .mockRejectedValueOnce(new Error('审批失败'))
      .mockResolvedValueOnce(undefined);
    setup({ onAction });

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(await screen.findByText('审批失败')).toBeInTheDocument();
    expect(screen.getByText('确认测试')).toBeInTheDocument(); // 弹窗仍在

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('审批失败')).toBeNull());
  });
});
