// ChannelInput — channel 上下游优化 Phase 1（AC4，docs/plans/2026-09-channel-upstream-downstream-ux.md）：
// replyTo 预览条可点击定位被回复消息——提供 onReplyPreviewClick 时预览正文区 button 化；
// ✕ 取消按钮保持兄弟节点（不嵌套按钮），只触发 onCancelReply。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const { mockListAgents } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    listAgents: mockListAgents,
  },
}));

import { ChannelInput } from '../ChannelInput';
import { useRosterStore } from '../../../stores/rosterStore';
import type { ChannelMessage } from '../../../api/channel';

const replyTo: ChannelMessage = {
  id: 'm-parent',
  channelId: 'ch-1',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'pm-agent',
  content: '上游结论：用方案 A',
  replyToId: null,
  meta: '{}',
  createdAt: new Date().toISOString(),
};

describe('ChannelInput — reply 预览条点击定位（Phase 1 / AC4）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: [] } });
    useRosterStore.setState({ profiles: [], loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
  });

  it('提供 onReplyPreviewClick → 预览正文区为 button，点击回调带被回复消息 id', () => {
    const onReplyPreviewClick = vi.fn();
    const { container } = render(
      <ChannelInput
        onSend={vi.fn()}
        sending={false}
        replyTo={replyTo}
        onCancelReply={vi.fn()}
        onReplyPreviewClick={onReplyPreviewClick}
      />,
    );
    const jump = container.querySelector('.mc-input-reply .mc-input-reply-jump');
    expect(jump?.tagName).toBe('BUTTON');
    fireEvent.click(jump!);
    expect(onReplyPreviewClick).toHaveBeenCalledTimes(1);
    expect(onReplyPreviewClick).toHaveBeenCalledWith('m-parent');
  });

  it('✕ 取消按钮只触发 onCancelReply，不触发预览定位（与定位区分离）', () => {
    const onReplyPreviewClick = vi.fn();
    const onCancelReply = vi.fn();
    const { container } = render(
      <ChannelInput
        onSend={vi.fn()}
        sending={false}
        replyTo={replyTo}
        onCancelReply={onCancelReply}
        onReplyPreviewClick={onReplyPreviewClick}
      />,
    );
    fireEvent.click(container.querySelector('.mc-input-reply [aria-label="取消回复"]')!);
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(onReplyPreviewClick).not.toHaveBeenCalled();
  });

  it('未提供 onReplyPreviewClick → 预览条保持纯展示（无 jump button）', () => {
    const { container } = render(
      <ChannelInput onSend={vi.fn()} sending={false} replyTo={replyTo} onCancelReply={vi.fn()} />,
    );
    expect(container.querySelector('.mc-input-reply')).not.toBeNull();
    expect(container.querySelector('.mc-input-reply-jump')).toBeNull();
  });
});
