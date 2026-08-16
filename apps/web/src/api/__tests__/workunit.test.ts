// Contract test: WorkUnit API client — MVP-3 + MVP-4
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { workunitApi, formatExecutionStreamChunkText, parseExecutionStepEvents, type ExecutionStreamChunk } from '../workunit';
import { api } from '../index';

describe('workunitApi', () => {
  it('reviewRejected passes reason param', async () => {
    await workunitApi.reviewRejected('wu-1', 'quality issue');
    expect(api.post).toHaveBeenCalledWith('/workunits/wu-1/review-rejected', { reason: 'quality issue' });
  });

  it('reviewRejected works without reason', async () => {
    await workunitApi.reviewRejected('wu-1');
    expect(api.post).toHaveBeenCalledWith('/workunits/wu-1/review-rejected', { reason: undefined });
  });

  it('getMessages calls correct endpoint', async () => {
    await workunitApi.getMessages('wu-1', { limit: 10 });
    expect(api.get).toHaveBeenCalledWith('/workunits/wu-1/messages', { params: { limit: 10 } });
  });

  it('postMessage passes content and authorType', async () => {
    await workunitApi.postMessage('wu-1', 'hello', 'human');
    expect(api.post).toHaveBeenCalledWith('/workunits/wu-1/messages', { content: 'hello', authorType: 'human' });
  });
});

describe('formatExecutionStreamChunkText', () => {
  const chunk = (overrides: Partial<ExecutionStreamChunk>): ExecutionStreamChunk => ({
    workUnitId: 'wu-1', executionId: 'e1', step: 1, kind: 'text', at: 't0', ...overrides,
  });

  it('kind 映射：tool/thinking/text/result，step-start 返回 null', () => {
    expect(formatExecutionStreamChunkText(chunk({ kind: 'tool', tool: 'Edit', summary: 'src/auth.ts' })))
      .toBe('🔧 Edit src/auth.ts');
    expect(formatExecutionStreamChunkText(chunk({ kind: 'thinking', text: '先读现有实现' })))
      .toBe('思考：先读现有实现');
    expect(formatExecutionStreamChunkText(chunk({ kind: 'text', text: '你好' }))).toBe('你好');
    expect(formatExecutionStreamChunkText(chunk({ kind: 'result', text: '', isError: false }))).toBe('✓ 回合结束');
    expect(formatExecutionStreamChunkText(chunk({ kind: 'result', text: '炸了', isError: true }))).toBe('✗ 炸了');
    expect(formatExecutionStreamChunkText(chunk({ kind: 'step-start' }))).toBeNull();
  });

  it('缺关键内容返回 null；默认截断超长文案', () => {
    expect(formatExecutionStreamChunkText(chunk({ kind: 'tool' }))).toBeNull();
    expect(formatExecutionStreamChunkText(chunk({ kind: 'thinking' }))).toBeNull();
    expect(formatExecutionStreamChunkText(chunk({ kind: 'text', text: 'x'.repeat(61) })))
      .toBe(`${'x'.repeat(60)}…`);
    expect(formatExecutionStreamChunkText(chunk({ kind: 'thinking', text: 'y'.repeat(41) })))
      .toBe(`思考：${'y'.repeat(40)}…`);
  });

  it('传 false 不截断（ExecutionSteps 完整展示）', () => {
    const long = 'z'.repeat(200);
    expect(formatExecutionStreamChunkText(chunk({ kind: 'text', text: long }), { maxTextLength: false }))
      .toBe(long);
    expect(formatExecutionStreamChunkText(chunk({ kind: 'tool', tool: 'Bash', summary: long }), { maxSummaryLength: false }))
      .toBe(`🔧 Bash ${long}`);
  });
});

// #182（决策 #61 速览档）：失败步字段（#172 落的 status/errorType/errorDetail）必须解析出来
describe('parseExecutionStepEvents · 失败步字段', () => {
  const row = (payload: Record<string, unknown>) => ({
    payload: JSON.stringify({ workUnitId: 'WU-1', executionId: 'e1', thinking: [], toolCalls: [], skills: [], ...payload }),
    createdAt: '2026-08-16T00:00:00Z',
  });

  it('失败步：status/errorType/errorDetail 透传', () => {
    const events = parseExecutionStepEvents([
      row({ step: 3, action: 'failed', status: 'failed', errorType: 'execution_failed', errorDetail: 'Verify FAILED: tsc' }),
    ], 'WU-1');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('failed');
    expect(events[0].errorType).toBe('execution_failed');
    expect(events[0].errorDetail).toBe('Verify FAILED: tsc');
  });

  it('历史成功步无 status 字段 → 缺省 success，不带错误字段', () => {
    const events = parseExecutionStepEvents([row({ step: 1 })], 'WU-1');
    expect(events[0].status).toBe('success');
    expect(events[0].errorType).toBeUndefined();
    expect(events[0].errorDetail).toBeUndefined();
  });
});
