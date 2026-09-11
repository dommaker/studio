// ChannelInput — #486：发送中 textarea 不再整段禁用（可接着打下一条）；
// 仅发送钮禁用防重复提交（乐观回显后无需阻塞输入）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../../api/channel', () => ({
  channelApi: { listAgents: vi.fn() },
}));

import { ChannelInput } from '../ChannelInput';
import { useRosterStore } from '../../../stores/rosterStore';

describe('ChannelInput — 发送中输入不阻塞（#486）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRosterStore.setState({ profiles: [], loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
  });

  it('sending=true 时 textarea 仍可输入，发送按钮禁用防重复提交', () => {
    render(<ChannelInput onSend={vi.fn()} sending={true} />);
    const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(screen.getByRole('button', { name: '...' })).toBeDisabled();
  });

  it('sending=false 时回归常态：textarea 可用、空内容发送钮禁用', () => {
    render(<ChannelInput onSend={vi.fn()} sending={false} />);
    const textarea = screen.getByPlaceholderText('输入消息，@Agent 提及 Agent...') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled(); // 空内容禁用（既有语义）
  });
});
