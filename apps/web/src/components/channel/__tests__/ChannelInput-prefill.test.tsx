// ChannelInput prefill（#440 Phase 1）— 外部填入口：prefill={text, nonce}，nonce 变化才写入，
// 用户编辑后同 nonce 不覆盖（建议片点击 → 填入输入框的通道）。
// 独立文件：prefill 会 focus() textarea，与 ChannelInput-mention-cursor 同样的串扰考虑。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../api/channel', () => ({
  channelApi: { listAgents: vi.fn().mockResolvedValue({ data: { data: [] } }) },
}));

import { ChannelInput } from '../ChannelInput';
import { useRosterStore } from '../../../stores/rosterStore';

describe('ChannelInput prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRosterStore.setState({ profiles: [], loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
  });

  it('prefill nonce 变化 → 内容写入输入框', () => {
    const onSend = vi.fn();
    const { rerender } = render(<ChannelInput onSend={onSend} sending={false} />);
    const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');

    rerender(<ChannelInput onSend={onSend} sending={false} prefill={{ text: '@reviewer 把 AC 转写成审查清单', nonce: 1 }} />);
    expect(textarea.value).toBe('@reviewer 把 AC 转写成审查清单');
  });

  it('同 nonce 重复渲染不覆盖用户编辑；新 nonce 再写入', () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <ChannelInput onSend={onSend} sending={false} prefill={{ text: 'A', nonce: 1 }} />,
    );
    const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
    expect(textarea.value).toBe('A');

    fireEvent.change(textarea, { target: { value: '用户改过' } });
    rerender(<ChannelInput onSend={onSend} sending={false} prefill={{ text: 'A', nonce: 1 }} />);
    expect(textarea.value).toBe('用户改过');

    rerender(<ChannelInput onSend={onSend} sending={false} prefill={{ text: 'B', nonce: 2 }} />);
    expect(textarea.value).toBe('B');
  });

  it('发送后 prefill 填入的内容正常清空（与手写输入同路径）', () => {
    const onSend = vi.fn();
    render(<ChannelInput onSend={onSend} sending={false} prefill={{ text: '发我', nonce: 1 }} />);
    const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('发我', undefined);
    expect(textarea.value).toBe('');
  });
});
