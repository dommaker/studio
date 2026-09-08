/**
 * cli/colors.ts 测试（ADR-0019：chalk 最小替代面）
 *
 * 测试环境非 TTY → 一律原样返回纯文本（这也是 --json 断言不被 ANSI 污染的锁）。
 */

import { describe, it, expect } from 'vitest';
import chalk from '../colors.js';

describe('colors（chalk 子集）', () => {
  it('非 TTY 下各色函数原样返回文本', () => {
    for (const fn of ['gray', 'blue', 'green', 'yellow', 'cyan', 'red', 'bold'] as const) {
      expect(chalk[fn]('文本')).toBe('文本');
    }
  });
});
