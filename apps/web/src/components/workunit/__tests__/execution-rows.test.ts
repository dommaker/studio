// execution-rows 纯函数单测（#240）：工具行四态推导（running/ok/error/stopped）
// 配对规则：toolUseId 优先；result 缺 id 时位置兜底（最早未配对）；孤儿 result 跳过。
// stopped 合成：步结束（result chunk / REST 步卡片落位）时仍未配对的 tool ≠ 永远 running。
import { describe, it, expect } from 'vitest';
import { deriveLiveToolRows, derivePersistedToolRows } from '../execution-rows';
import type { ExecutionStepEvent, ExecutionStreamChunk } from '../../../api/workunit';

const chunk = (over: Partial<ExecutionStreamChunk>): ExecutionStreamChunk => ({
  workUnitId: 'WU-1', executionId: 'e1', step: 1, kind: 'text', at: 't0', ...over,
});

const tool = (toolUseId: string | undefined, name = 'Bash', summary = 'pnpm test') =>
  chunk({ kind: 'tool', tool: name, summary, toolUseId });
const resultFor = (toolUseId: string | undefined, over: Partial<ExecutionStreamChunk> = {}) =>
  chunk({ kind: 'tool-result', toolUseId, ...over });

describe('deriveLiveToolRows — 四态推导', () => {
  it('tool 未配对 result 且步未结束 → running', () => {
    const rows = deriveLiveToolRows([tool('t1')], false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'Bash', summary: 'pnpm test', state: 'running' });
    expect(rows[0].output).toBeUndefined();
  });

  it('toolUseId 配对成功 → ok，output 透出 result 文本', () => {
    const rows = deriveLiveToolRows([tool('t1'), resultFor('t1', { text: 'Tests 22 passed' })], false);
    expect(rows[0]).toMatchObject({ state: 'ok', output: 'Tests 22 passed' });
  });

  it('配对的 result 带 isError → error', () => {
    const rows = deriveLiveToolRows([tool('t1'), resultFor('t1', { isError: true, text: 'Exit code 1' })], false);
    expect(rows[0]).toMatchObject({ state: 'error', output: 'Exit code 1' });
  });

  it('步结束仍未配对 → stopped（中断合成，不再转圈）', () => {
    const rows = deriveLiveToolRows([tool('t1'), tool('t2', 'Read', '/a.ts')], true);
    expect(rows.map(r => r.state)).toEqual(['stopped', 'stopped']);
  });

  it('混合：已配对保持自身态，未配对的随 stepEnded 分流 running/stopped', () => {
    const live = deriveLiveToolRows([tool('t1'), resultFor('t1'), tool('t2', 'Grep', 'foo')], false);
    expect(live.map(r => r.state)).toEqual(['ok', 'running']);
    const ended = deriveLiveToolRows([tool('t1'), resultFor('t1'), tool('t2', 'Grep', 'foo')], true);
    expect(ended.map(r => r.state)).toEqual(['ok', 'stopped']);
  });

  it('result 缺 toolUseId → 位置兜底配对最早未配对 tool', () => {
    const rows = deriveLiveToolRows([tool('t1'), tool('t2', 'Read', '/a.ts'), resultFor(undefined, { text: 'done' })], false);
    expect(rows.map(r => r.state)).toEqual(['ok', 'running']);
    expect(rows[0].output).toBe('done');
  });

  it('孤儿 result（id 无匹配，如 tool chunk 被容量驱逐）→ 跳过不产行', () => {
    const rows = deriveLiveToolRows([tool('t1'), resultFor('t-ghost', { text: 'x' })], false);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('running');
  });

  it('多个 tool 按 id 各自配对，顺序保持 tool 出现序', () => {
    const rows = deriveLiveToolRows([
      tool('t1'), tool('t2', 'Read', '/a.ts'),
      resultFor('t2', { text: 'file content' }), resultFor('t1', { isError: true, text: 'boom' }),
    ], false);
    expect(rows.map(r => `${r.tool}:${r.state}`)).toEqual(['Bash:error', 'Read:ok']);
    expect(rows[1].output).toBe('file content');
  });

  it('非 tool/tool-result chunk（thinking/text/result/step-start）不影响行推导', () => {
    const rows = deriveLiveToolRows([
      chunk({ kind: 'step-start' }),
      chunk({ kind: 'thinking', text: '想' }),
      tool('t1'),
      chunk({ kind: 'text', text: '正文' }),
      chunk({ kind: 'result' }),
    ], true);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('stopped');
  });
});

describe('derivePersistedToolRows — Layer A 落盘步（无逐工具结果，按步状态合成）', () => {
  const step = (status: 'success' | 'failed'): ExecutionStepEvent => ({
    workUnitId: 'WU-1', executionId: 'e1', step: 3, status,
    thinking: [],
    toolCalls: [{ tool: 'Bash', summary: 'pnpm test' }, { tool: 'Read', summary: '/a.ts' }],
    skills: [], at: '2026-08-19T00:00:00Z',
  });

  it('成功步 → 全部 ok', () => {
    expect(derivePersistedToolRows(step('success')).map(r => r.state)).toEqual(['ok', 'ok']);
  });

  it('失败步 → 全部 stopped（执行中断于本步，逐工具结果未落盘）', () => {
    expect(derivePersistedToolRows(step('failed')).map(r => r.state)).toEqual(['stopped', 'stopped']);
  });
});
