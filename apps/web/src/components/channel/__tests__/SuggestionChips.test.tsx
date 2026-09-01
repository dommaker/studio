// SuggestionChips（#440 Phase 1）— 频道输入框上方的建议 prompt 片：渲染 / 点击填入 / dismiss
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SuggestionChips } from '../SuggestionChips';

const SUGGESTIONS = [
  { id: 'review-checklist', text: '@reviewer 把 AC 转写成审查清单' },
  { id: 'contract-lock', text: '@developer 锁定实现契约' },
];

describe('SuggestionChips', () => {
  it('渲染全部建议片（mono 小卡）', () => {
    render(<SuggestionChips suggestions={SUGGESTIONS} onPick={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('@reviewer 把 AC 转写成审查清单')).toBeTruthy();
    expect(screen.getByText('@developer 锁定实现契约')).toBeTruthy();
  });

  it('点击建议片 → onPick 携带该片文本', () => {
    const onPick = vi.fn();
    render(<SuggestionChips suggestions={SUGGESTIONS} onPick={onPick} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('@reviewer 把 AC 转写成审查清单'));
    expect(onPick).toHaveBeenCalledWith('@reviewer 把 AC 转写成审查清单');
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('dismiss 按钮 → onDismiss', () => {
    const onDismiss = vi.fn();
    render(<SuggestionChips suggestions={SUGGESTIONS} onPick={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('关闭建议'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('空建议列表 → 整体不渲染', () => {
    const { container } = render(<SuggestionChips suggestions={[]} onPick={() => {}} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
