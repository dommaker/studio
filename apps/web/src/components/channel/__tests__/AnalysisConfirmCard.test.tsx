// AnalysisConfirmCard — #284（决策 #250 D6）analysis 接力卡
// 契约：cardType 'analysis_confirm'；「去确认」→ onOpenConfirm(workUnitId)（开 WU 抽屉并自动弹 AnalysisApproveDialog）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnalysisConfirmCard } from '../AnalysisConfirmCard';
import type { ChannelMessage } from '../../../api/channel';

const baseMessage: ChannelMessage = {
  id: 'msg-ac-1',
  channelId: 'ch-1',
  workUnitId: 'wu-ana-1',
  authorType: 'agent',
  agentName: 'Studio',
  content: '分析结论待确认（#wu-ana-1），确认后将按 TASK 拆分自动派工',
  replyToId: null,
  meta: JSON.stringify({ cardType: 'analysis_confirm' }),
  createdAt: new Date().toISOString(),
};

describe('AnalysisConfirmCard（#284 决策 #250 D6）', () => {
  it('卡面 = 「分析结论待确认」+ 引导文案 + 「去确认」按钮', () => {
    render(<AnalysisConfirmCard message={baseMessage} meta={{ cardType: 'analysis_confirm' }} onOpenConfirm={vi.fn()} />);
    expect(screen.getByText('分析结论待确认')).toBeTruthy();
    expect(screen.getByText(/确认后将按 TASK 拆分自动派工/)).toBeTruthy();
    expect(screen.getByText('去确认')).toBeTruthy();
  });

  it('点「去确认」→ onOpenConfirm(workUnitId)', () => {
    const onOpenConfirm = vi.fn();
    render(<AnalysisConfirmCard message={baseMessage} meta={{ cardType: 'analysis_confirm' }} onOpenConfirm={onOpenConfirm} />);
    fireEvent.click(screen.getByText('去确认'));
    expect(onOpenConfirm).toHaveBeenCalledWith('wu-ana-1');
  });

  it('缺 workUnitId（异常数据）→ 不渲染「去确认」按钮', () => {
    render(
      <AnalysisConfirmCard
        message={{ ...baseMessage, workUnitId: null }}
        meta={{ cardType: 'analysis_confirm' }}
        onOpenConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText('分析结论待确认')).toBeTruthy();
    expect(screen.queryByText('去确认')).toBeNull();
  });
});
