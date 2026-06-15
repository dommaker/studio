import { describe, test, expect } from 'vitest';
import { getSessionTimeout } from '../agent-runner.js';

describe('getSessionTimeout: tier-based session timeout', () => {
  test('fast tier → 15min', () => {
    expect(getSessionTimeout('fast')).toBe(15);
  });

  test('standard tier → 30min', () => {
    expect(getSessionTimeout('standard')).toBe(30);
  });

  test('premium tier → 45min', () => {
    expect(getSessionTimeout('premium')).toBe(45);
  });

  test('undefined tier → 30min default', () => {
    expect(getSessionTimeout(undefined)).toBe(30);
  });

  test('unknown tier → 30min default', () => {
    expect(getSessionTimeout('enterprise')).toBe(30);
  });

  test('empty string → 30min default', () => {
    expect(getSessionTimeout('')).toBe(30);
  });
});
