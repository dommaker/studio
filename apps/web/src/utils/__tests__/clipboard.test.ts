// copyText（#271 从 FileRefChip 提取共用）：navigator.clipboard 优先 / execCommand 降级
import { describe, it, expect, vi, afterEach } from 'vitest';
import { copyText } from '../clipboard';

describe('copyText（#271）', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: originalClipboard, configurable: true });
    vi.restoreAllMocks();
  });

  it('navigator.clipboard 可用时走 writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await copyText('hello');
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('clipboard 不可用时降级 execCommand，临时 textarea 用后清理', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    await copyText('fallback');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('writeText 被拒绝（权限拒绝）时同样降级 execCommand', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    document.execCommand = exec;
    await copyText('x');
    expect(exec).toHaveBeenCalledWith('copy');
  });
});
