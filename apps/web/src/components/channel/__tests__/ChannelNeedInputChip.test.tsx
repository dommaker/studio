// #279（决策 #250 D4）：顶栏 NEED_INPUT 待办 chip —— 计数 + 下拉清单 + 点击定位
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChannelNeedInputChip, type NeedInputTodo } from '../ChannelNeedInputChip';

const ITEMS: NeedInputTodo[] = [
  { wuId: 'WU-3000', question: '使用 OAuth 还是账号密码？' },
  { wuId: 'WU-3001', question: '匹配到多个工程，请回复其中一个' },
];

describe('ChannelNeedInputChip — #279 顶栏待办 chip', () => {
  it('无待办 → 不渲染', () => {
    const { container } = render(<ChannelNeedInputChip items={[]} onLocate={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('有待办 → chip 显示聚合计数', () => {
    render(<ChannelNeedInputChip items={ITEMS} onLocate={vi.fn()} />);
    expect(screen.getByText('待回复 · 2')).toBeTruthy();
  });

  it('点击 chip → 下拉清单列 WU 标识 + 问题摘要', () => {
    render(<ChannelNeedInputChip items={ITEMS} onLocate={vi.fn()} />);
    fireEvent.click(screen.getByText('待回复 · 2'));
    expect(screen.getByText('WU-3000')).toBeTruthy();
    expect(screen.getByText('使用 OAuth 还是账号密码？')).toBeTruthy();
    expect(screen.getByText('WU-3001')).toBeTruthy();
    expect(screen.getByText('匹配到多个工程，请回复其中一个')).toBeTruthy();
  });

  it('点条目 → onLocate(wuId) 并收起下拉', () => {
    const onLocate = vi.fn();
    render(<ChannelNeedInputChip items={ITEMS} onLocate={onLocate} />);
    fireEvent.click(screen.getByText('待回复 · 2'));
    fireEvent.click(screen.getByText('使用 OAuth 还是账号密码？'));
    expect(onLocate).toHaveBeenCalledWith('WU-3000');
    expect(screen.queryByText('WU-3001')).toBeNull();
  });

  it('超长问题摘要截断展示，全文入 title', () => {
    const long = '这是一个非常非常长的问题摘要，需要在下拉清单里被截断展示以免撑破布局'.repeat(3);
    render(<ChannelNeedInputChip items={[{ wuId: 'WU-3002', question: long }]} onLocate={vi.fn()} />);
    fireEvent.click(screen.getByText('待回复 · 1'));
    const item = screen.getByTitle(long);
    expect(item.textContent!.length).toBeLessThan(long.length);
  });

  it('点击组件外部 → 下拉收起', () => {
    render(
      <div>
        <ChannelNeedInputChip items={ITEMS} onLocate={vi.fn()} />
        <div data-testid="outside" />
      </div>,
    );
    fireEvent.click(screen.getByText('待回复 · 2'));
    expect(screen.getByText('WU-3000')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('WU-3000')).toBeNull();
  });
});
