import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WuDeliveryState } from '@dommaker/studio-shared/web';
import { DeliveryBadge } from '../DeliveryBadge';

describe('DeliveryBadge', () => {
  it.each([
    ['merge-queued', '等待合并', 'u-text-2'],
    ['merge-running', '合并与目标验证中', 'u-accent'],
    ['merged-with-failed-verification', '已合并，目标验证失败', 'u-err'],
    ['verification-unavailable', '无目标验证命令，待人工确认', 'u-warn'],
  ] as const)('%s 使用共享交付文案与配色', (delivery, label, color) => {
    render(<DeliveryBadge delivery={delivery} />);
    const badge = screen.getByText(label);
    expect(badge.className).toContain(color);
  });

  it('无交付子状态时不占位', () => {
    const { container } = render(<DeliveryBadge delivery={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('接受共享 WuDeliveryState 类型', () => {
    const delivery: WuDeliveryState = 'merge-queued';
    render(<DeliveryBadge delivery={delivery} />);
    expect(screen.getByText('等待合并')).toBeTruthy();
  });
});
