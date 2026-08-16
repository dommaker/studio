/**
 * hooks-closure-check 脚本测试（#150 C1 / #202）
 *
 * checkHooksClosure 纯函数：正例（真实声明表 ↔ 定义闭环）+ 负例
 * （assertHookRegistryClosed 抛错 → ok=false 不向上抛）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertHookRegistryClosed } from '@dommaker/harness';

import { checkHooksClosure } from '../hooks-closure-check';

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, assertHookRegistryClosed: vi.fn(actual.assertHookRegistryClosed) };
});

describe('checkHooksClosure', () => {
  afterEach(() => {
    vi.mocked(assertHookRegistryClosed).mockClear();
  });

  it('正例：真实声明表与导出定义闭环 → ok=true', () => {
    const result = checkHooksClosure();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('闭环');
  });

  it('负例：闭环校验抛错 → ok=false 且消息含原始错误，不向上抛', () => {
    vi.mocked(assertHookRegistryClosed).mockImplementationOnce(() => {
      throw new Error('hook 配置 "phantom" 引用的实现未注册');
    });

    const result = checkHooksClosure();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('phantom');
  });
});
