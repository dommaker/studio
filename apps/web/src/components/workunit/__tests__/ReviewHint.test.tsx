import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewHint } from '../ReviewHint';

describe('ReviewHint (AC-2.4)', () => {
  it('status != in_review 时不渲染', () => {
    const { container } = render(
      <ReviewHint status="active" channelMembers={[]} onSetupClick={() => {}} />
    );
    expect(container.querySelector('[data-testid="review-hint"]')).toBeNull();
  });

  it('in_review + 无 reviewer -> 显示横幅', () => {
    render(
      <ReviewHint
        status="in_review"
        channelMembers={[{ id: '1', name: 'dev', description: 'developer' }]}
      />
    );
    expect(screen.getByTestId('review-hint')).toBeTruthy();
    expect(screen.getByText('建议创建 reviewer 角色以启用自动审查')).toBeTruthy();
  });

  it('in_review + 有 reviewer（description 含 reviewer）-> 不显示', () => {
    const { container } = render(
      <ReviewHint
        status="in_review"
        channelMembers={[{ id: '1', name: 'rev', description: 'code reviewer' }]}
      />
    );
    expect(container.querySelector('[data-testid="review-hint"]')).toBeNull();
  });

  it('in_review + 无 reviewer + onSetupClick -> 显示跳转按钮 + 点击触发', () => {
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

  it('in_review + 空成员列表 -> 显示横幅', () => {
    render(<ReviewHint status="in_review" channelMembers={[]} />);
    expect(screen.getByTestId('review-hint')).toBeTruthy();
  });
});
