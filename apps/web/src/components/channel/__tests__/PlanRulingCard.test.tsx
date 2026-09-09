// PlanRulingCard — #467：裁决轮接力卡（plan 会话内一次性人闸）
// 契约：cardType 'plan_ruling'；「去裁决」→ onOpenRuling(workUnitId)（开 WU 抽屉并自动弹 PlanRulingDialog）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanRulingCard } from '../PlanRulingCard';
import type { ChannelMessage } from '../../../api/channel';

const baseMessage: ChannelMessage = {
  id: 'msg-pr-1',
  channelId: 'ch-1',
  workUnitId: 'wu-plan-1',
  authorType: 'agent',
  agentName: 'Planner',
  content: '需要输入: 裁决轮——2 个待决问题请一次性裁决',
  replyToId: null,
  meta: JSON.stringify({ cardType: 'plan_ruling' }),
  createdAt: new Date().toISOString(),
};

describe('PlanRulingCard（#467 裁决轮接力卡）', () => {
  it('卡面 = 「裁决轮待裁」+ 引导文案 + 「去裁决」按钮', () => {
    render(<PlanRulingCard message={baseMessage} meta={{ cardType: 'plan_ruling' }} onOpenRuling={vi.fn()} />);
    expect(screen.getByText('裁决轮待裁')).toBeTruthy();
    expect(screen.getByText(/一次性裁决/)).toBeTruthy();
    expect(screen.getByText('去裁决')).toBeTruthy();
  });

  it('点「去裁决」→ onOpenRuling(workUnitId)', () => {
    const onOpenRuling = vi.fn();
    render(<PlanRulingCard message={baseMessage} meta={{ cardType: 'plan_ruling' }} onOpenRuling={onOpenRuling} />);
    fireEvent.click(screen.getByText('去裁决'));
    expect(onOpenRuling).toHaveBeenCalledWith('wu-plan-1');
  });

  it('缺 workUnitId（异常数据）→ 不渲染「去裁决」按钮', () => {
    render(
      <PlanRulingCard
        message={{ ...baseMessage, workUnitId: null }}
        meta={{ cardType: 'plan_ruling' }}
        onOpenRuling={vi.fn()}
      />,
    );
    expect(screen.getByText('裁决轮待裁')).toBeTruthy();
    expect(screen.queryByText('去裁决')).toBeNull();
  });
});
