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

import { workunitApi, formatExecutionStreamChunkText, type ExecutionStreamChunk } from '../workunit';
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
