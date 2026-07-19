/**
 * ChannelMessageItem tests — F5: NEED_INPUT 挂起「等待回复」badge
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChannelMessageItem } from '../channel/ChannelMessageItem';
import type { ChannelMessage } from '../../api/channel';

// 卡片子组件与本测试无关，避免其内部 API 依赖
vi.mock('../channel/RequirementsDocCard', () => ({ RequirementsDocCard: () => null }));
vi.mock('../channel/KnowledgeConfirmCard', () => ({ KnowledgeConfirmCard: () => null }));
vi.mock('../channel/AuditorSuggestionCard', () => ({ AuditorSuggestionCard: () => null }));
vi.mock('../channel/DeployApprovalCard', () => ({ DeployApprovalCard: () => null }));
vi.mock('../channel/ConvertToTaskDialog', () => ({ ConvertToTaskDialog: () => null }));

const baseMessage: ChannelMessage = {
  id: 'msg-1',
  channelId: 'ch-1',
  workUnitId: 'wu-1',
  authorType: 'agent',
  agentName: 'f5-agent',
  content: '需要输入: 使用 OAuth 还是账号密码？',
  replyToId: null,
  meta: '{}',
  createdAt: new Date().toISOString(),
};

describe('ChannelMessageItem — F5 waiting badge', () => {
  it('shows 等待回复 badge when waitingForInput', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} waitingForInput />);
    expect(screen.getByText('等待回复')).toBeInTheDocument();
  });

  it('does not show badge by default', () => {
    render(<ChannelMessageItem message={baseMessage} onAction={vi.fn()} />);
    expect(screen.queryByText('等待回复')).not.toBeInTheDocument();
  });
});
