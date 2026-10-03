/**
 * transcripts 域契约测试：TranscriptEntry/TranscriptResult parity + params 防穿越边界 + 响应壳。
 * 正本 = apps/api/src/modules/transcripts/transcript-archive.ts + transcript.routes.ts。
 */

import { describe, it, expect } from 'vitest';
import {
  transcriptEntrySchema,
  type TranscriptEntry,
  transcriptResultSchema,
  type TranscriptResult,
  transcriptParamsSchema,
  transcriptQuerySchema,
  transcriptResponseSchema,
} from '../transcripts.js';
import * as contractIndex from '../index.js';

const entry: TranscriptEntry = {
  workUnitId: 'wu-1',
  sessionId: 'sess-1',
  step: 1,
  action: 'progress',
  rawOutput: 'step-1 output',
  createdAt: '2026-08-15T10:00:00.000Z',
};

describe('transcriptEntrySchema', () => {
  it('parity：TranscriptEntry fixture 通过校验；必填字段删除即拒', () => {
    expect(transcriptEntrySchema.parse(entry)).toEqual(entry);
    // sessionId/action/rawOutput 可缺省（归档器条件落键）
    const minimal: TranscriptEntry = { workUnitId: 'wu-2', step: 3, createdAt: 't' };
    expect(transcriptEntrySchema.parse(minimal)).toEqual(minimal);
    expect(() => transcriptEntrySchema.parse({ ...entry, workUnitId: undefined })).toThrow();
    expect(() => transcriptEntrySchema.parse({ ...entry, step: undefined })).toThrow();
    expect(() => transcriptEntrySchema.parse({ ...entry, createdAt: undefined })).toThrow();
  });
});

describe('transcriptResultSchema', () => {
  it('parity：TranscriptResult fixture；文件不存在 = 200 空列表', () => {
    const result: TranscriptResult = {
      workUnitId: 'wu-1', total: 1, offset: 0, limit: 20, entries: [entry],
    };
    expect(transcriptResultSchema.parse(result)).toEqual(result);
    expect(transcriptResponseSchema.parse({ data: result }).data.total).toBe(1);
    const empty: TranscriptResult = { workUnitId: 'wu-nope', total: 0, offset: 0, limit: 20, entries: [] };
    expect(transcriptResultSchema.parse(empty)).toEqual(empty);
  });
});

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
