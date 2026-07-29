import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SelfReviewBadge } from '../SelfReviewBadge';

describe('SelfReviewBadge (F6 决策 5 自评标记)', () => {
  it('评审 WU 自身 metadata.selfReview=true → 显示', () => {
    render(
      <SelfReviewBadge wu={{ status: 'done', type: 'review', metadata: JSON.stringify({ selfReview: true }) }} />,
    );
    expect(screen.getByText('自评')).toBeTruthy();
  });

  it('父 WU 台账 l2.selfReview=true → 显示（deriveDisplayState 透出）', () => {
    const metadata = JSON.stringify({
      attestations: {
        l2: { verdict: 'approved', by: 'dev-1', at: '2026-07-29T00:00:00Z', kind: 'agent-review', selfReview: true },
      },
    });
    render(<SelfReviewBadge wu={{ status: 'done', type: 'feature', metadata }} />);
    expect(screen.getByText('自评')).toBeTruthy();
  });

  it('无自评标记 → 不渲染', () => {
    const { container } = render(
      <SelfReviewBadge wu={{ status: 'done', type: 'feature', metadata: JSON.stringify({}) }} />,
    );
    expect(container.querySelector('span')).toBeNull();
  });

  it('l2 无 selfReview 标记 → 不渲染', () => {
    const metadata = JSON.stringify({
      attestations: {
        l2: { verdict: 'approved', by: 'rev-1', at: '2026-07-29T00:00:00Z', kind: 'agent-review' },
      },
    });
    const { container } = render(
      <SelfReviewBadge wu={{ status: 'done', type: 'feature', metadata }} />,
    );
    expect(container.querySelector('span')).toBeNull();
  });

  it('metadata 损坏 JSON → 不渲染（不放大异常数据）', () => {
    const { container } = render(
      <SelfReviewBadge wu={{ status: 'done', type: 'review', metadata: '{broken' }} />,
    );
    expect(container.querySelector('span')).toBeNull();
  });
});
