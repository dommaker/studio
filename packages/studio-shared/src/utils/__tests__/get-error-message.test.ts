/**
 * getErrorMessage 单测（正本自 apps/api utils/errors.ts 下沉，#359 口径不变）：
 * Error → message；string → 原文；其他（number/null/object）→ 'Unknown error'。
 */
import { describe, it, expect } from 'vitest';
import { getErrorMessage } from '../get-error-message';

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
