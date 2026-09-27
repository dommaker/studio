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

  it('点击复制 → writeText 写入消息全文；按钮变对勾图标约 1.5s 后恢复（批次 I-6 ✓ → IconCheck SVG）', async () => {
    vi.useFakeTimers();
    renderItem(base);
    const btn = screen.getByLabelText('复制消息内容');
    fireEvent.click(btn);
    expect(mockWriteText).toHaveBeenCalledWith('正文内容-待复制');
    await act(async () => {}); // writeText promise 落地 + state 提交
    expect(btn.querySelector('svg')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1600); });
    expect(btn.querySelector('svg')).toBeNull();
    expect(btn.textContent).toBe('⧉');
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

// B3：「转为任务」按钮回调化——弹窗页面级单例，消息项只经 env.onConvert 回调打开；
// 缺 onConvert（无 Provider/未注入）fail-closed 不出按钮
describe('ChannelMessageItem — 转为任务回调（B3 单例化）', () => {
  const humanMsg: ChannelMessage = {
    ...base, id: 'h-1', authorType: 'human', agentName: null, workUnitId: null,
  };

  it('人类消息（无 WU）点「转为任务」→ onConvert 回调携带消息本体', () => {
    const onConvert = vi.fn();
    renderItem(humanMsg, {}, { channelId: 'ch-1', onConvert });
    fireEvent.click(screen.getByLabelText('转为任务'));
    expect(onConvert).toHaveBeenCalledWith(humanMsg);
  });

  it('env 缺 onConvert → 不出「转为任务」按钮（fail-closed）', () => {
    renderItem(humanMsg, {}, { channelId: 'ch-1' });
    expect(screen.queryByLabelText('转为任务')).toBeNull();
  });

  it('agent 消息 / 已挂 WU 的人类消息不出「转为任务」按钮', () => {
    const onConvert = vi.fn();
    renderItem(base, {}, { channelId: 'ch-1', onConvert });
    expect(screen.queryByLabelText('转为任务')).toBeNull();
    renderItem({ ...humanMsg, id: 'h-2', workUnitId: 'WU-1' }, {}, { channelId: 'ch-1', onConvert });
    expect(screen.queryByLabelText('转为任务')).toBeNull();
  });
});
