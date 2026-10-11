// MergePreviewBar（#691 自 ChannelInput 抽出）：#632 发送前归属预览条——
// 无 preview / eligible 失效不渲染；unique 显示并入目标、ambiguous 淡提示、none 纯消息；
// 「新任务」/「纯消息」chip 点击选中、再点回 auto。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MergePreviewBar } from '../MergePreviewBar';
import type { MergeTargetPreview } from '../../../api/channel';

const unique: MergeTargetPreview = { status: 'unique', workUnit: { id: 'wu-1', title: '修登录页' } };

describe('MergePreviewBar', () => {
  it('preview 为 null 或 eligible=false 时不渲染', () => {
    const { container: c1 } = render(
      <MergePreviewBar preview={null} eligible={true} choice="auto" onChoiceChange={vi.fn()} />);
    expect(c1.firstChild).toBeNull();
    const { container: c2 } = render(
      <MergePreviewBar preview={unique} eligible={false} choice="auto" onChoiceChange={vi.fn()} />);
    expect(c2.firstChild).toBeNull();
  });

  it('unique：显示「将并入：<title>」+ 两个归属 chip', () => {
    render(<MergePreviewBar preview={unique} eligible={true} choice="auto" onChoiceChange={vi.fn()} />);
    expect(screen.getByText('修登录页')).toBeTruthy();
    expect(screen.getByText('新任务')).toBeTruthy();
    expect(screen.getByText('纯消息')).toBeTruthy();
  });

  it('ambiguous：淡提示多件在途，不显目标', () => {
    render(<MergePreviewBar preview={{ status: 'ambiguous' }} eligible={true} choice="auto" onChoiceChange={vi.fn()} />);
    expect(screen.getByText('频道有多件事同时进行，请回复对应消息或 @角色')).toBeTruthy();
  });

  it('none：默认「纯消息」文案 + 仅「新任务」chip（无「纯消息」chip）', () => {
    render(<MergePreviewBar preview={{ status: 'none' }} eligible={true} choice="auto" onChoiceChange={vi.fn()} />);
    expect(screen.getByText('纯消息')).toBeTruthy(); // 文案
    expect(screen.getByText('新任务')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '纯消息' })).toBeNull();
  });

  it('chip 点击选中、再点回 auto；选中态带 active 类与 aria-pressed', () => {
    const onChoiceChange = vi.fn();
    const { rerender } = render(
      <MergePreviewBar preview={unique} eligible={true} choice="auto" onChoiceChange={onChoiceChange} />);
    fireEvent.click(screen.getByText('新任务'));
    expect(onChoiceChange).toHaveBeenCalledWith('new-task');

    rerender(<MergePreviewBar preview={unique} eligible={true} choice="new-task" onChoiceChange={onChoiceChange} />);
    const chip = screen.getByText('新任务');
    expect(chip.className).toBe('mc-input-merge-chip mc-input-merge-chip-active');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip);
    expect(onChoiceChange).toHaveBeenCalledWith('auto');
  });
});
