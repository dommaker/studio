import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SkeletonText, SkeletonCard } from '../Skeleton';

describe('SkeletonText', () => {
  it('渲染指定行数，默认 3 行', () => {
    const { container, rerender } = render(<SkeletonText />);
    expect(container.querySelectorAll('.skeleton-text')).toHaveLength(3);

    rerender(<SkeletonText lines={6} />);
    expect(container.querySelectorAll('.skeleton-text')).toHaveLength(6);
  });

  it('widths 逐行自定义宽度（数字 → px，字符串原样）', () => {
    const { container } = render(<SkeletonText lines={2} widths={[240, '60%']} />);
    const rows = container.querySelectorAll<HTMLElement>('.skeleton-text');
    expect(rows[0].style.width).toBe('240px');
    expect(rows[1].style.width).toBe('60%');
  });

  it('widths 缺省行不写内联宽度（满宽）', () => {
    const { container } = render(<SkeletonText lines={2} widths={['50%']} />);
    const rows = container.querySelectorAll<HTMLElement>('.skeleton-text');
    expect(rows[1].style.width).toBe('');
  });

  it('aria-hidden：整块不进读屏', () => {
    const { container } = render(<SkeletonText lines={4} className="space-y-3" />);
    const root = container.firstElementChild!;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.className).toContain('space-y-3');
  });
});

describe('SkeletonCard', () => {
  it('自定义高度（默认 96px）', () => {
    const { container, rerender } = render(<SkeletonCard />);
    expect((container.firstElementChild as HTMLElement).style.height).toBe('96px');

    rerender(<SkeletonCard height={200} />);
    expect((container.firstElementChild as HTMLElement).style.height).toBe('200px');
  });

  it('aria-hidden + className 叠加', () => {
    const { container } = render(<SkeletonCard className="mb-3" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.className).toContain('skeleton');
    expect(el.className).toContain('mb-3');
  });
});
