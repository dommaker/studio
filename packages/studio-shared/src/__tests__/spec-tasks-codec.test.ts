/**
 * spec-tasks-codec — TASK 物化行 wire codec 测试（#463 / P2-c 下沉）
 */
import { describe, it, expect } from 'vitest';
import { SPEC_TASKS_MAX, parseSpecTasks, serializeSpecTasks, type SpecTaskSpec } from '../spec-tasks-codec.js';

describe('spec-tasks-codec', () => {
  it('parse：TASK 行 + AC/BLOCKEDBY/LEG 段，兼容中文冒号', () => {
    const tasks = parseSpecTasks('TASK: 修分页 | AC: 页码 clamp | BLOCKEDBY: WU-1, WU-2 | LEG: repo-a\n其他结论行');
    expect(tasks).toEqual([{ title: '修分页', ac: ['页码 clamp'], blockedBy: ['WU-1', 'WU-2'], leg: 'repo-a' }]);
  });
  it('parse：超过 SPEC_TASKS_MAX 截断；空标题丢弃', () => {
    const lines = Array.from({ length: SPEC_TASKS_MAX + 3 }, (_, i) => `TASK: t${i}`).join('\n');
    expect(parseSpecTasks(lines)).toHaveLength(SPEC_TASKS_MAX);
    expect(parseSpecTasks('TASK:    ')).toEqual([]);
  });
  it('serialize 是 parse 的逆运算（同一契约正本）；空清单 → 空串', () => {
    const tasks: SpecTaskSpec[] = [{ title: 'a', ac: ['x'], blockedBy: ['b1'], leg: 'r' }];
    expect(parseSpecTasks(serializeSpecTasks(tasks))).toEqual(tasks);
    expect(serializeSpecTasks([])).toBe('');
  });
});
