/**
 * transcripts 域契约测试：params 防穿越边界 + query 边界 + index 出口。
 * schema 即正本；同名类型为 z.infer alias / import type 同源，由编译期断言锚定，无 parity 互验层。
 */

import { describe, it, expect } from 'vitest';
import {
  transcriptParamsSchema,
  transcriptQuerySchema,
} from '../transcripts.js';
import * as contractIndex from '../index.js';

describe('transcriptParamsSchema（防路径穿越）', () => {
  it('空值 / 含路径分隔符 / 含 .. 一律拒绝（原手写 400 收进 zod）', () => {
    expect(transcriptParamsSchema.parse({ workUnitId: 'wu-1' }).workUnitId).toBe('wu-1');
    for (const bad of ['', 'a/b', 'a\\b', '..', 'a..b', '../../etc']) {
      expect(() => transcriptParamsSchema.parse({ workUnitId: bad }), bad).toThrow();
    }
  });

  it('query offset/limit 可选（clamp 走 parsePagination）', () => {
    expect(transcriptQuerySchema.parse({})).toEqual({});
    expect(transcriptQuerySchema.parse({ offset: '1', limit: '50' }).limit).toBe('50');
  });
});

describe('index.ts 出口', () => {
  it('transcripts 域 schema 经 index 导出', () => {
    expect(contractIndex.transcriptEntrySchema).toBeDefined();
    expect(contractIndex.transcriptResponseSchema).toBeDefined();
    expect(contractIndex.transcriptParamsSchema).toBeDefined();
  });
});
