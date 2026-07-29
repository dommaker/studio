import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewHint } from '../ReviewHint';

describe('ReviewHint (AC-2.4，F4 口径)', () => {
  it('status != in_review 时不渲染', () => {
    const { container } = render(
      <ReviewHint status="active" channelMembers={[]} onSetupClick={() => {}} />
    );
    expect(container.querySelector('[data-testid="review-hint"]')).toBeNull();
  });

  it('in_review + 频道无成员（无人可领评审）-> 显示横幅', () => {
    render(<ReviewHint status="in_review" channelMembers={[]} />);
    expect(screen.getByTestId('review-hint')).toBeTruthy();
    expect(screen.getByText('频道内没有可认领评审的成员，评审将滞留——请添加成员或人工评审')).toBeTruthy();
  });

  it('in_review + 频道有成员（评审可涌现认领，不再要求 reviewer 角色）-> 不显示', () => {
    const { container } = render(
      <ReviewHint
        status="in_review"
        channelMembers={[{ id: '1', name: 'dev', description: 'developer' }]}
      />
    );
    expect(container.querySelector('[data-testid="review-hint"]')).toBeNull();
  });

  it('in_review + 无成员 + onSetupClick -> 显示跳转按钮 + 点击触发', () => {
    const onSetupClick = vi.fn();
    render(
      <ReviewHint
        status="in_review"
        channelMembers={[]}
        onSetupClick={onSetupClick}
      />
    );
    const btn = screen.getByTestId('review-hint-setup');
    fireEvent.click(btn);
    expect(onSetupClick).toHaveBeenCalled();
  });
});
