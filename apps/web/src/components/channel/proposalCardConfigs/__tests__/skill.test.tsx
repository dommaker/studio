// #717 Skill 人审卡：ChannelMessageItem → ReviewProposalCard → 通用 action。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChannelMessageItem } from '../../ChannelMessageItem';
import { ChannelMessageEnvProvider } from '../../ChannelMessageEnv';
import { skillProposalConfig } from '../skill';
import { skillsApi } from '../../../../api/skills';
import type { ChannelMessage } from '../../../../api/channel';

vi.mock('../../../../api/skills', () => ({
  skillsApi: {
    approveProposal: vi.fn(),
    rejectProposal: vi.fn(),
    proposalStatus: vi.fn().mockResolvedValue({ data: { data: { status: 'pending' } } }),
  },
}));

const message: ChannelMessage = {
  id: 'msg-skill-1',
  channelId: 'ch-sys',
  workUnitId: null,
  authorType: 'agent',
  agentName: 'Studio',
  content: 'Skill pending review',
  replyToId: null,
  createdAt: new Date().toISOString(),
  meta: {
    cardType: 'skill_review_request',
    cardData: {
      proposalId: 'sp-1',
      skillId: 'skill-1',
      name: 'ci-fix',
      description: '先复现，再修复，最后跑受影响测试。',
      proposedBy: 'distill',
      sourceGoalIds: ['material-1', 'material-2'],
    },
  },
};

describe('SkillProposalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(skillsApi.proposalStatus).mockResolvedValue({ data: { data: { status: 'pending' } } });
  });

  it('在频道消息中展示 Skill 审核内容，点击通过后显示已发布', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(
      <MemoryRouter>
        <ChannelMessageEnvProvider value={{ onAction }}>
          <ChannelMessageItem message={message} />
        </ChannelMessageEnvProvider>
      </MemoryRouter>,
    );

    expect(screen.getByText('ci-fix')).toBeTruthy();
    expect(screen.getByText('先复现，再修复，最后跑受影响测试。')).toBeTruthy();
    expect(screen.getByText(/原料 2 条/)).toBeTruthy();
    fireEvent.click(screen.getByText('通过并发布'));

    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-skill-1', 'skill_review_request_approve'));
    expect(await screen.findByText('已通过并发布')).toBeTruthy();
    expect(screen.queryByText('拒绝')).toBeNull();
  });

  it('approve/reject 经配置调用通用端点，缺 proposalId 不发请求', async () => {
    vi.mocked(skillsApi.approveProposal).mockResolvedValue({ data: { data: { success: true } } } as never);
    await expect(skillProposalConfig.exec({ proposalId: 'sp-1' }, 'approve')).resolves.toBe(true);
    expect(skillsApi.approveProposal).toHaveBeenCalledWith('sp-1');

    await expect(skillProposalConfig.exec({ proposalId: 'sp-1' }, 'reject')).resolves.toBe(true);
    expect(skillsApi.rejectProposal).toHaveBeenCalledWith('sp-1');
    await expect(skillProposalConfig.exec({}, 'approve')).resolves.toBe(false);
    expect(skillsApi.approveProposal).toHaveBeenCalledTimes(1);
  });

  it('刷新时 executed/rejected/failed 映射为已发布/已拒绝/发布失败，pending 保持待审', async () => {
    vi.mocked(skillsApi.proposalStatus).mockResolvedValue({ data: { data: { status: 'executed' } } });
    await expect(skillProposalConfig.fetchReviewed!({ proposalId: 'sp-1' })).resolves.toBe('approved');
    vi.mocked(skillsApi.proposalStatus).mockResolvedValue({ data: { data: { status: 'rejected' } } });
    await expect(skillProposalConfig.fetchReviewed!({ proposalId: 'sp-1' })).resolves.toBe('rejected');
    vi.mocked(skillsApi.proposalStatus).mockResolvedValue({ data: { data: { status: 'failed' } } });
    await expect(skillProposalConfig.fetchReviewed!({ proposalId: 'sp-1' })).resolves.toBe('failed');
    await expect(skillProposalConfig.fetchReviewed!({})).resolves.toBeNull();
  });
});
