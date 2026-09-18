// PlanDirectionCard — #567：方向锁定接力卡（plan 会话内方向人闸，裁决轮前置环节）
// 契约：cardType 'plan_direction'；「去选定」→ onOpenDirection(workUnitId)（开 WU 抽屉并自动弹 PlanDirectionDialog）
// 卡面照 PlanRulingCard（#467）先例 = 静态文案 + message.content；候选明细在抽屉弹窗经 WU metadata 取
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PlanDirectionCard } from '../PlanDirectionCard';
import type { ChannelMessage } from '../../../api/channel';

const baseMessage: ChannelMessage = {
  id: 'msg-pd-1',
  channelId: 'ch-1',
  workUnitId: 'wu-plan-1',
  authorType: 'agent',
  agentName: 'Planner',
  content: '需要输入: 方向锁定——请选定本票方向',
  replyToId: null,
  meta: JSON.stringify({ cardType: 'plan_direction' }),
  createdAt: new Date().toISOString(),
};

describe('PlanDirectionCard（#567 方向锁定接力卡）', () => {
  it('卡面 = 「方向待锁定」+ 引导文案 + 「去选定」按钮', () => {
    render(<PlanDirectionCard message={baseMessage} meta={{ cardType: 'plan_direction' }} onOpenDirection={vi.fn()} />);
    expect(screen.getByText('方向待锁定')).toBeTruthy();
    expect(screen.getByText(/请选定本票方向/)).toBeTruthy();
    expect(screen.getByText('去选定')).toBeTruthy();
  });

  it('点「去选定」→ onOpenDirection(workUnitId)', () => {
    const onOpenDirection = vi.fn();
    render(<PlanDirectionCard message={baseMessage} meta={{ cardType: 'plan_direction' }} onOpenDirection={onOpenDirection} />);
    fireEvent.click(screen.getByText('去选定'));
    expect(onOpenDirection).toHaveBeenCalledWith('wu-plan-1');
  });

  it('缺 workUnitId（异常数据）→ 不渲染「去选定」按钮', () => {
    render(
      <PlanDirectionCard
        message={{ ...baseMessage, workUnitId: null }}
        meta={{ cardType: 'plan_direction' }}
        onOpenDirection={vi.fn()}
      />,
    );
    expect(screen.getByText('方向待锁定')).toBeTruthy();
    expect(screen.queryByText('去选定')).toBeNull();
  });
});
