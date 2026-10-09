/**
 * type-assert.ts（#685 编译期互锚工具）测试：锁「运行时零导出」不变量 +
 * MutualExtends 正反两例的编译期行使（tsc 通过即语义正确）。
 */

import { describe, it, expect } from 'vitest';
import * as ta from '../type-assert.js';
import type { MutualExtends } from '../type-assert.js';

// 正例：互相 extends 才 = true
const _pos: MutualExtends<{ a: string; b?: number }, { a: string; b?: number }> = true;
// 反例：任一方向不 extends = never（赋 true 即编译错误）
const _neg: MutualExtends<{ a: string }, { a: number }> = null as unknown as never;

describe('type-assert 纯类型工具', () => {
  it('运行时零导出（type-only）', () => {
    expect(Object.keys(ta)).toEqual([]);
    expect(_pos).toBe(true);
    expect(_neg).toBe(null);
  });
});
