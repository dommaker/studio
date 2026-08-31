// #396：执行步共享纯函数（自 ExecutionSteps 抽取，ExecutionFlow 共用）——合并/最近进展/token 缩写
import { describe, it, expect } from 'vitest';
import { mergeStepEvents, lastProgressEntry, formatStepTokens } from '../executionSteps';
import type { ExecutionStepEvent } from '../../api/workunit';

function ev(step: number, over: Partial<ExecutionStepEvent> = {}): ExecutionStepEvent {
  return {
    workUnitId: 'wu-1', executionId: 'ex-1', step, status: 'success',
    thinking: [], toolCalls: [], skills: [], at: `2026-07-30T09:${String(step).padStart(2, '0')}:00Z`,
    ...over,
  };
}

describe('mergeStepEvents', () => {
  it('按 executionId-step 去重（后到覆盖），按步号升序', () => {
    const base = [ev(2), ev(1)];
    const incoming = [ev(2, { action: 'new' }), ev(3)];
    const merged = mergeStepEvents(base, incoming);
    expect(merged.map(s => s.step)).toEqual([1, 2, 3]);
    expect(merged[1].action).toBe('new');
  });

  it('incoming 为空 → 原样返回', () => {
    const base = [ev(1)];
    expect(mergeStepEvents(base, [])).toBe(base);
  });

  it('不同 executionId 同步号不互相覆盖', () => {
    const merged = mergeStepEvents([ev(1)], [ev(1, { executionId: 'ex-2' })]);
    expect(merged.length).toBe(2);
  });
});

describe('lastProgressEntry', () => {
  it('取最后一条带 summary 的条目；畸形条目跳过', () => {
    expect(lastProgressEntry([{ step: 1, summary: 'a' }, { step: 2, summary: 'b' }])).toEqual({ step: 2, summary: 'b' });
    expect(lastProgressEntry([{ step: 1, summary: 'a' }, { step: 3 }, null])).toEqual({ step: 1, summary: 'a' });
  });

  it('非数组/无有效条目 → null', () => {
    expect(lastProgressEntry(undefined)).toBeNull();
    expect(lastProgressEntry([])).toBeNull();
    expect(lastProgressEntry([{ step: 1 }])).toBeNull();
  });
});

describe('formatStepTokens', () => {
  it('≥1000 缩写 k（一位小数），否则原值', () => {
    expect(formatStepTokens(4500)).toBe('4.5k');
    expect(formatStepTokens(999)).toBe('999');
    expect(formatStepTokens(1000)).toBe('1.0k');
  });
});
