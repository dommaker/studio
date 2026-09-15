// ChannelMessageItem — channel 上下游优化 Phase 3（AC4 复制部分）：
// actionButtons 加「复制」（clipboard.writeText 全文，成功 ✓ 反馈 ~1.5s 恢复；
// API 不可用/拒绝 → toast.warning）；系统播报消息给 hover 复制入口（只复制，不出回复/转任务）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ChannelMessage } from '../../../api/channel';

const { mockWriteText, mockToastWarning } = vi.hoisted(() => ({
  mockWriteText: vi.fn(),
  mockToastWarning: vi.fn(),
}));

vi.mock('../../../utils/toast', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: mockToastWarning, info: vi.fn(), dismiss: vi.fn(),
  }),
}));

import { ChannelMessageEnvProvider } from '../ChannelMessageEnv';
import type { ChannelMessageEnv } from '../ChannelMessageEnv';
import { ChannelMessageItem } from '../ChannelMessageItem';

const base: ChannelMessage = {
  id: 'm-1',
  channelId: 'ch-1',
  authorType: 'agent',
  agentName: 'dev-agent',
  content: '正文内容-待复制',
  replyToId: null,
  meta: '{}',
  createdAt: '2026-08-19T00:00:00.000Z',
};

const systemMsg: ChannelMessage = {
  ...base,
  id: 's-1',
  agentName: 'Studio',
  content: '[CRITICAL] **[Monitor]** 队列积压',
};

const renderItem = (
  message: ChannelMessage,
  extra: Record<string, unknown> = {},
  envExtra: Partial<ChannelMessageEnv> = {},
) =>
  render(
    <MemoryRouter>
      <ChannelMessageEnvProvider value={{ onAction: vi.fn(), ...envExtra }}>
        <ChannelMessageItem message={message} {...extra} />
      </ChannelMessageEnvProvider>
    </MemoryRouter>,
  );

const setClipboard = (available: boolean) => {
  Object.defineProperty(navigator, 'clipboard', {
    value: available ? { writeText: mockWriteText } : undefined,
    configurable: true,
  });
};

describe('ChannelMessageItem — 复制按钮（Phase 3 / AC4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteText.mockResolvedValue(undefined);
    setClipboard(true);
  });
  afterEach(() => vi.useRealTimers());

  it('点击复制 → writeText 写入消息全文；按钮变 ✓ 约 1.5s 后恢复', async () => {
    vi.useFakeTimers();
    renderItem(base);
    const btn = screen.getByLabelText('复制消息内容');
    fireEvent.click(btn);
    expect(mockWriteText).toHaveBeenCalledWith('正文内容-待复制');
    await act(async () => {}); // writeText promise 落地 + state 提交
    expect(btn.textContent).toBe('✓');
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(btn.textContent).not.toBe('✓');
  });

  it('clipboard API 不可用 → toast.warning 提示，不静默', async () => {
    setClipboard(false);
    renderItem(base);
    fireEvent.click(screen.getByLabelText('复制消息内容'));
    await Promise.resolve();
    expect(mockToastWarning).toHaveBeenCalled();
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('writeText 拒绝（权限拒绝）→ toast.warning 提示', async () => {
    mockWriteText.mockRejectedValue(new Error('denied'));
    renderItem(base);
    fireEvent.click(screen.getByLabelText('复制消息内容'));
    await vi.waitFor(() => expect(mockToastWarning).toHaveBeenCalled());
  });

  it('系统播报消息：有复制入口，无回复/转任务钮（即使传了 onReply）', () => {
    renderItem(systemMsg, {}, { onReply: vi.fn() });
    expect(screen.getByLabelText('复制消息内容')).toBeTruthy();
    expect(screen.queryByLabelText('回复消息')).toBeNull();
    expect(screen.queryByLabelText('转为任务')).toBeNull();
  });

  it('compact（连续合并）消息：复制按钮随角落动作保留', () => {
    renderItem(base, { compact: true }, { onReply: vi.fn() });
    expect(screen.getByLabelText('复制消息内容')).toBeTruthy();
    expect(screen.getByLabelText('回复消息')).toBeTruthy();
  });

  it('pending 乐观消息不出复制按钮（同既有回复/转任务守卫）', () => {
    renderItem({ ...base, pending: true } as ChannelMessage, {}, { onReply: vi.fn() });
    expect(screen.queryByLabelText('复制消息内容')).toBeNull();
  });
});
