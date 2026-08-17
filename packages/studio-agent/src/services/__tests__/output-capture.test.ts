/**
 * output-capture 单元测试 — #174: session:start/end 事件补 workUnitId + transcript 路径
 *
 * mock FileStore（appendJsonl）断言落盘 payload：
 * - 带 extras：payload 并入 workUnitId / transcriptPath（undefined 的不带键）
 * - 不带 extras：payload 无这两个键（行为不变）
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockAppendJsonl } = vi.hoisted(() => ({
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    FileStore: vi.fn().mockImplementation(function () {
      return { appendJsonl: mockAppendJsonl };
    }),
  };
});

import { emitSessionStart, emitSessionEnd } from '../output-capture.js';

function lastPayload(): Record<string, unknown> {
  const call = mockAppendJsonl.mock.calls[mockAppendJsonl.mock.calls.length - 1];
  return JSON.parse(call[1].payload);
}

describe('emitSessionStart (#174)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('无 extras：payload 仅含既有四键', async () => {
    await emitSessionStart('sess-1', 'exec-1', 1);
    const payload = lastPayload();
    expect(payload).toEqual({ sessionId: 'sess-1', agentId: 'exec-1', executionId: 'exec-1', sessionCount: 1 });
    expect(payload).not.toHaveProperty('workUnitId');
    expect(payload).not.toHaveProperty('transcriptPath');
  });

  test('带 extras：payload 并入 workUnitId + transcriptPath，既有字段不变', async () => {
    await emitSessionStart('sess-1', 'exec-1', 1, {
      workUnitId: 'wu-42',
      transcriptPath: '/data/transcripts/wu-42.jsonl',
    });
    const payload = lastPayload();
    expect(payload.sessionId).toBe('sess-1');
    expect(payload.sessionCount).toBe(1);
    expect(payload.workUnitId).toBe('wu-42');
    expect(payload.transcriptPath).toBe('/data/transcripts/wu-42.jsonl');
  });

  test('extras 部分字段为 undefined：对应键不出现', async () => {
    await emitSessionStart('sess-1', 'exec-1', 1, { workUnitId: 'wu-42' });
    const payload = lastPayload();
    expect(payload.workUnitId).toBe('wu-42');
    expect(payload).not.toHaveProperty('transcriptPath');
  });
});

describe('emitSessionEnd (#174)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('无 extras：payload 无 workUnitId/transcriptPath 键', async () => {
    await emitSessionEnd('sess-1', 'exec-1', 2);
    const payload = lastPayload();
    expect(payload).toEqual({ sessionId: 'sess-1', agentId: 'exec-1', executionId: 'exec-1', sessionCount: 2 });
  });

  test('带 extras：payload 并入两字段', async () => {
    await emitSessionEnd('sess-1', 'exec-1', 2, {
      workUnitId: 'wu-42',
      transcriptPath: '/data/transcripts/wu-42.jsonl',
    });
    const payload = lastPayload();
    expect(payload.workUnitId).toBe('wu-42');
    expect(payload.transcriptPath).toBe('/data/transcripts/wu-42.jsonl');
  });
});
