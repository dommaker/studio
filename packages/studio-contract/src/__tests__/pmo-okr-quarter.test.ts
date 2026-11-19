import { describe, expect, it } from 'vitest';
import { createOkrBodySchema, isValidOkrQuarter } from '../pmo';

describe('isValidOkrQuarter（SEC-04 唯一校验）', () => {
  it('与 HTTP schema 共用严格 YYYY-Qn 口径', () => {
    for (const quarter of ['2026-Q1', '0000-Q4', '9999-Q3']) {
      expect(isValidOkrQuarter(quarter)).toBe(true);
    }
    for (const quarter of ['2026-Q0', '2026-Q5', '2026-q1', '26-Q1', '2026-Q1-extra', '2026-Q1\n', '../outside']) {
      expect(isValidOkrQuarter(quarter)).toBe(false);
      expect(createOkrBodySchema.pick({ quarter: true }).safeParse({ quarter }).success).toBe(false);
    }
  });
});
