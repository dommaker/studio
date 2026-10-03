// ChannelStreamHead — P3-b 自 ChannelDetailPage 切出的消息流头块：
// 首拉骨架 / #482 错误态三态分流 / 空频道示例 chip（prefill 通道）/ 加载更早 / 已完成折叠 toggle
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { ChannelStreamHead, EMPTY_EXAMPLE_PROMPTS } from '../ChannelStreamHead';

const base = {
  loading: false,
  error: null,
  isEmpty: false,
  onRetry: vi.fn(),
  onPickExample: vi.fn(),
  hasMore: false,
  onLoadMore: vi.fn(),
  completedCount: 0,
  showCompleted: false,
  onToggleCompleted: vi.fn(),
};
const renderHead = (overrides: Partial<typeof base> = {}) => {
  const props = { ...base, onRetry: vi.fn(), onPickExample: vi.fn(), onLoadMore: vi.fn(), onToggleCompleted: vi.fn(), ...overrides };
  render(<ChannelStreamHead {...props} />);
  return props;
};

describe('ChannelStreamHead — P3-b 消息流头块', () => {
  it('首拉中且空：骨架行（其余块不出）', () => {
    const { container } = render(<ChannelStreamHead {...base} loading isEmpty />);
    expect(container.querySelector('.mc-stream-head')).toBeTruthy();
    expect(screen.queryByText('发送消息开始对话')).toBeNull();
    expect(screen.queryByText('消息加载失败')).toBeNull();
  });

  it('#482：首拉失败且空 → 错误态 role=alert + 重试（不落假空态）；点击重试走 onRetry', () => {
    const props = renderHead({ error: '网络错误', isEmpty: true });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('消息加载失败')).toBeTruthy();
    expect(screen.queryByText('发送消息开始对话')).toBeNull();
    fireEvent.click(screen.getByText('重试'));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('#482：已有消息时失败不整屏替换（isEmpty=false → 错误块不渲染）', () => {
    renderHead({ error: '网络错误', isEmpty: false });
    expect(screen.queryByText('消息加载失败')).toBeNull();
  });

  it('空频道：示例提示 chip 三个，点击经 onPickExample 上送文案（不自动发送）', () => {
    const props = renderHead({ isEmpty: true });
    expect(screen.getByText('发送消息开始对话')).toBeTruthy();
    for (const text of EMPTY_EXAMPLE_PROMPTS) {
      fireEvent.click(screen.getByText(text));
      expect(props.onPickExample).toHaveBeenCalledWith(text);
    }
    expect(props.onPickExample).toHaveBeenCalledTimes(3);
  });

  it('hasMore → 「加载更早的消息」；点击走 onLoadMore', () => {
    const props = renderHead({ hasMore: true });
    fireEvent.click(screen.getByText('加载更早的消息'));
    expect(props.onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('折叠 toggle：completedCount>2 折叠态出「显示 N 条已完成消息」，展开态出「收起」', () => {
    const props = renderHead({ completedCount: 5, showCompleted: false });
    fireEvent.click(screen.getByText('显示 3 条已完成消息'));
    expect(props.onToggleCompleted).toHaveBeenCalledWith(true);

    const props2 = renderHead({ completedCount: 5, showCompleted: true });
    fireEvent.click(screen.getByText('收起已完成消息'));
    expect(props2.onToggleCompleted).toHaveBeenCalledWith(false);
  });

  it('completedCount<=2 不出折叠 toggle', () => {
    renderHead({ completedCount: 2 });
    expect(screen.queryByText(/已完成消息/)).toBeNull();
  });

  it('ref 挂到 .mc-stream-head 测量容器（组合层 scrollMargin 量高契约）', () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<ChannelStreamHead {...base} ref={ref} />);
    expect(ref.current).toBe(container.querySelector('.mc-stream-head'));
  });
});
