// types/workunit.ts — WU 事件负载类型锚定测试（P3-a）：
// 负载形状 + api/workunit.ts re-export 同一性（解析器行为覆盖在 api/__tests__/workunit.test.ts）。
import { describe, it, expect } from 'vitest';
import type { WorkunitTokenEvent, ExecutionStepEvent, ExecutionStreamChunk, ExecutionStepToolCall } from '../workunit';
import type { ExecutionStepEvent as FromApi, ExecutionStreamChunk as ChunkFromApi } from '../../api/workunit';

describe('types/workunit（事件负载）', () => {
  it('WorkunitTokenEvent：executionTokens 可空（CLI 未回报不编造 0）', () => {
    const ev: WorkunitTokenEvent = { workUnitId: 'wu-1', injectedTokens: 100, executionTokens: null, totalTokens: 100 };
    expect(ev.executionTokens).toBeNull();
  });

  it('ExecutionStepEvent 与 api/workunit re-export 同一性', () => {
    const toolCall: ExecutionStepToolCall = { tool: 'Read', summary: 'file_path=/a.ts' };
    const step: ExecutionStepEvent = {
      workUnitId: 'wu-1', executionId: 'ex-1', step: 1, status: 'success',
      thinking: [], toolCalls: [toolCall], skills: [], at: '2026-10-02T00:00:00Z',
    };
    const viaApi: FromApi = step;
    expect(viaApi.toolCalls[0].tool).toBe('Read');
  });

  it('ExecutionStreamChunk kind 词表（含 #240 tool-result）', () => {
    const kinds: ExecutionStreamChunk['kind'][] = ['step-start', 'thinking', 'text', 'tool', 'tool-result', 'result'];
    const chunk: ChunkFromApi = { workUnitId: 'wu-1', executionId: 'ex-1', step: 1, kind: kinds[4], at: 'ts' };
    expect(chunk.kind).toBe('tool-result');
  });
});
