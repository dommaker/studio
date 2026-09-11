// ChannelMessageItem — #486 乐观回显 pending 视觉态：
// 灰色「发送中」标记；本地 pending id 服务端不存在，不出回复/转任务动作。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// 卡片子组件与本测试无关，避免其内部 API 依赖
vi.mock('../RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

import { ChannelMessageItem } from '../ChannelMessageItem';
import type { ChannelMessage } from '../../../api/channel';

const pendingMessage: ChannelMessage = {
  id: 'pending-1',
  channelId: 'ch-1',
  workUnitId: null,
  authorType: 'human',
  content: '发送中的消息',
  replyToId: null,
  meta: '{}',
  createdAt: new Date().toISOString(),
  pending: true,
};

describe('ChannelMessageItem — pending 乐观回显（#486）', () => {
  it('pending 消息带 mc-msg-pending 类与「发送中」标记', () => {
    const { container } = render(
      <ChannelMessageItem message={pendingMessage} onAction={vi.fn()} onReply={vi.fn()} />,
    );
    const row = container.querySelector('.mc-msg');
    expect(row?.className).toContain('mc-msg-pending');
    expect(screen.getByText('发送中…')).toBeInTheDocument();
  });

  it('pending 消息不出回复动作（本地 id 服务端不存在，回复无的放矢）', () => {
    render(<ChannelMessageItem message={pendingMessage} onAction={vi.fn()} onReply={vi.fn()} />);
    expect(screen.queryByLabelText('回复消息')).toBeNull();
  });

  it('非 pending 消息行为不变：无 pending 类、有回复动作', () => {
    const normal: ChannelMessage = { ...pendingMessage, id: 'm1', pending: undefined };
    const { container } = render(
      <ChannelMessageItem message={normal} onAction={vi.fn()} onReply={vi.fn()} />,
    );
    expect(container.querySelector('.mc-msg')?.className).not.toContain('mc-msg-pending');
    expect(screen.queryByText('发送中…')).toBeNull();
    expect(screen.getByLabelText('回复消息')).toBeInTheDocument();
  });
});
