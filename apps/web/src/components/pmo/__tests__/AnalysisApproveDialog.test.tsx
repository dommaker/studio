// AnalysisApproveDialog — #106 M7 analysis 确认弹窗共享件（自 WorkUnitListPage 抽出）
// 预填展示 / 人改后 summary 回传 / 空清单直接通过 / 取消（按钮、关闭 ×、遮罩点击）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { AnalysisApproveDialog } from '../AnalysisApproveDialog';

const PREFILL = 'DESTINATION: 三仓特性联动上线\nFOG: 存储选型用哪个？\nFOG: 部署形态先单机还是分布式？';

describe('AnalysisApproveDialog', () => {
  it('预填文本进 textarea；人审改后确认 → onConfirm 回传改后文本', () => {
    const onConfirm = vi.fn();
    render(<AnalysisApproveDialog prefill={PREFILL} onConfirm={onConfirm} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/DESTINATION/) as HTMLTextAreaElement;
    expect(textarea.value).toBe(PREFILL);

    // 人审改：删掉一条雾
    fireEvent.change(textarea, { target: { value: 'FOG: 存储选型用哪个？' } });
    fireEvent.click(screen.getByText('确认通过'));

    expect(onConfirm).toHaveBeenCalledWith('FOG: 存储选型用哪个？');
  });

  it('空预填（无清单 metadata）→ 空文本，直接确认 → onConfirm 回传空串（非探路型不开图）', () => {
    const onConfirm = vi.fn();
    render(<AnalysisApproveDialog prefill="" onConfirm={onConfirm} onCancel={vi.fn()} />);

    const textarea = screen.getByPlaceholderText(/DESTINATION/) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    fireEvent.click(screen.getByText('确认通过'));
    expect(onConfirm).toHaveBeenCalledWith('');
  });

  it('取消按钮 / 关闭 × / 遮罩点击 → onCancel，不触发 onConfirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container, unmount } = render(
      <AnalysisApproveDialog prefill={PREFILL} onConfirm={onConfirm} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByText('取消'));
    expect(onCancel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onCancel).toHaveBeenCalledTimes(2);

    fireEvent.click(container.querySelector('.modal-overlay')!);
    expect(onCancel).toHaveBeenCalledTimes(3);
    expect(onConfirm).not.toHaveBeenCalled();
    unmount();
  });
});
