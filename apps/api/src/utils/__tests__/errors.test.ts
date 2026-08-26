/**
 * getErrorMessage 单测（#359）
 *
 * 统一错误消息提取口径，替代手写 `err instanceof Error ? err.message : String(err)`：
 * Error → message；string → 原文；其他（number/null/object）→ 'Unknown error'。
 */
import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../errors.js';

describe('getErrorMessage (#359)', () => {
  it('Error → message', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('Error 子类 → message', () => {
    expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
  });

  it('string → 原文', () => {
    expect(getErrorMessage('plain failure')).toBe('plain failure');
  });

  it('非 Error 非 string（number/null/object）→ Unknown error', () => {
    expect(getErrorMessage(42)).toBe('Unknown error');
    expect(getErrorMessage(null)).toBe('Unknown error');
    expect(getErrorMessage({ code: 'X' })).toBe('Unknown error');
  });
});
