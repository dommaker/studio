/** 包出口测试：index.ts 完整 re-export envelope */

import { describe, it, expect } from 'vitest';
import {
  errorBodySchema,
  paginatedBodySchema,
  ERROR_CODES,
} from '../envelope.js';
import * as contractIndex from '../index.js';

describe('index 出口', () => {
  it('re-export envelope 全部符号', () => {
    expect(contractIndex.errorBodySchema).toBe(errorBodySchema);
    expect(contractIndex.paginatedBodySchema).toBe(paginatedBodySchema);
    expect(contractIndex.ERROR_CODES).toBe(ERROR_CODES);
  });
});
