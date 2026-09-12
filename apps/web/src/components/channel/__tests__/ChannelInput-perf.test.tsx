// #520 测量②：composer 提交动作瞬间发 client.perf.send_click（埋点①）——
// 点击发送/Enter 发送即埋点（不等 REST 结果）；sink 关闭时发送行为完全不变。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockListAgents, mockSink } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockSink: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: { listAgents: mockListAgents },
}));

import { ChannelInput } from '../ChannelInput';
import { useRosterStore } from '../../../stores/rosterStore';
import { setClientPerfSink, resetClientPerfSink } from '../../../utils/clientPerf';

function setup(onSend = vi.fn().mockResolvedValue(undefined)) {
  render(<ChannelInput onSend={onSend} sending={false} channelId="ch-1" />);
  const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
  return { onSend, textarea };
}

describe('ChannelInput — #520 发送点击埋点', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClientPerfSink();
    setClientPerfSink(mockSink);
    mockListAgents.mockResolvedValue({ data: { data: [] } });
    useRosterStore.setState({ profiles: [], loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
  });

  it('点击「发送」→ 发 client.perf.send_click（channelId + replyToId=null）', async () => {
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: '你好' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('你好', undefined));

    expect(mockSink).toHaveBeenCalledTimes(1);
    expect(mockSink.mock.calls[0][0]).toBe('client.perf.send_click');
    expect(mockSink.mock.calls[0][1]).toEqual({ channelId: 'ch-1', replyToId: null });
  });

  it('Enter 发送同样埋点', () => {
    const { textarea } = setup();
    fireEvent.change(textarea, { target: { value: 'enter 发送' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(mockSink).toHaveBeenCalledTimes(1);
    expect(mockSink.mock.calls[0][0]).toBe('client.perf.send_click');
  });

  it('空内容不提交也不埋点', () => {
    render(<ChannelInput onSend={vi.fn()} sending={false} channelId="ch-1" />);
    fireEvent.click(screen.getByText('发送'));
    expect(mockSink).not.toHaveBeenCalled();
  });

  it('sink 关闭时发送行为不变（onSend 正常调用、无事件）', async () => {
    setClientPerfSink(null);
    const { onSend, textarea } = setup();
    fireEvent.change(textarea, { target: { value: '关闭埋点' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith('关闭埋点', undefined));
    expect(mockSink).not.toHaveBeenCalled();
  });
});
