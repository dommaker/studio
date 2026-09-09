// DecisionApproveDialog — #463 decision 确认弹窗：建议结论预填 / 采纳与修改后采纳 /
// 转人工讨论（打回预设理由）/ 取消；批次A 项7 提交反馈（loading + 失败内联保持打开）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DecisionApproveDialog, DECISION_DISCUSS_REASON } from '../DecisionApproveDialog';

function setup(overrides: Record<string, unknown> = {}) {
  const props = {
    question: '待决问题 PMO-1: 存储选型用哪个？',
    suggestion: '选型用 SQLite，理由是单机部署零依赖。',
    onConfirm: vi.fn(),
    onReject: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<DecisionApproveDialog {...props} />);
  return props;
}

describe('DecisionApproveDialog（#463）', () => {
  it('预填 agent 建议结论进 textarea；未改点「采纳结论」→ confirm 回传原结论', () => {
    const { onConfirm } = setup();
    const textarea = screen.getByLabelText('决策结论') as HTMLTextAreaElement;
    expect(textarea.value).toBe('选型用 SQLite，理由是单机部署零依赖。');
    expect(screen.getByText('待决问题 PMO-1: 存储选型用哪个？')).toBeTruthy();

    fireEvent.click(screen.getByText('采纳结论'));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'decision', conclusion: '选型用 SQLite，理由是单机部署零依赖。' });
  });

  it('人审改后 → 主按钮标签切「修改后采纳」，confirm 回传改后文本（trim）', () => {
    const { onConfirm } = setup();
    fireEvent.change(screen.getByLabelText('决策结论'), { target: { value: '  改用 Postgres  ' } });
    fireEvent.click(screen.getByText('修改后采纳'));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'decision', conclusion: '改用 Postgres' });
  });

  it('「转人工讨论」→ onReject 带预设理由（打回路径）', () => {
    const { onReject, onConfirm } = setup();
    fireEvent.click(screen.getByText('转人工讨论'));
    expect(onReject).toHaveBeenCalledWith(DECISION_DISCUSS_REASON);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('空建议（agent 没给）→ 空手填；空白结论禁用主按钮', () => {
    setup({ suggestion: '' });
    const textarea = screen.getByLabelText('决策结论') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(screen.getByText('采纳结论').closest('button')!.disabled).toBe(true);
  });

  it('onConfirm reject → 弹窗不关 + 内联错误；onCancel/遮罩在提交中屏蔽', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('审查硬门已关闭'));
    const onCancel = vi.fn();
    setup({ onConfirm, onCancel });

    fireEvent.click(screen.getByText('采纳结论'));
    expect(await screen.findByText('审查硬门已关闭')).toBeTruthy();
    expect(screen.getByText('确认决策结论')).toBeTruthy(); // 弹窗仍在
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('onConfirm 未结算期间按钮禁用；结算后恢复', async () => {
    let resolve: () => void = () => {};
    const onConfirm = vi.fn().mockImplementation(() => new Promise<void>(r => { resolve = r; }));
    setup({ onConfirm });

    const btn = screen.getByText('采纳结论').closest('button')!;
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    resolve();
    await waitFor(() => expect(btn.disabled).toBe(false));
  });
});
