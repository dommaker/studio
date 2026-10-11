// FileRefChips（#691 自 ChannelInput 抽出）：#485 文件引用台账 chip——空台账不渲染；
// 正文含路径 = 正常 chip（title 全路径），不含 = 标灰「已失效」；✕ 单独移除走 onRemove。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileRefChips } from '../FileRefChips';
import type { FileRef } from '../../../api/channel';

const refA: FileRef = { repo: '/abs/repo-a', path: 'src/App.tsx' };
const refB: FileRef = { repo: '/abs/repo-b', path: 'docs/spec.md' };

describe('FileRefChips', () => {
  it('空台账不渲染', () => {
    const { container } = render(<FileRefChips refs={[]} content="anything" onRemove={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('正文含路径 = 正常 chip；不含 = 标灰「已失效」', () => {
    const { container } = render(
      <FileRefChips refs={[refA, refB]} content="请看 src/App.tsx 这个文件" onRemove={vi.fn()} />,
    );
    const chips = container.querySelectorAll('.mc-fileref-chip');
    expect(chips.length).toBe(2);
    expect(chips[0].className).toBe('mc-fileref-chip');
    expect(chips[0].getAttribute('title')).toBe('/abs/repo-a/src/App.tsx');
    expect(chips[1].className).toBe('mc-fileref-chip mc-fileref-chip-invalid');
    expect(chips[1].textContent).toContain('已失效');
    // repo basename 消歧展示
    expect(container.textContent).toContain('repo-a');
    expect(container.textContent).toContain('repo-b');
  });

  it('✕ 单独移除该引用（onRemove 上送对应 ref）', () => {
    const onRemove = vi.fn();
    render(<FileRefChips refs={[refA, refB]} content="src/App.tsx docs/spec.md" onRemove={onRemove} />);
    fireEvent.click(screen.getByLabelText('移除引用 docs/spec.md'));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(refB);
  });
});
