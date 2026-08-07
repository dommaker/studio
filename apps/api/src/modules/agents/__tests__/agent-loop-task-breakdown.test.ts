/**
 * parseTaskBreakdown 单测（PMO 分析接力：analysis WU 输出的 TASK: 行解析）
 */
import { describe, it, expect } from 'vitest';
import { parseTaskBreakdown } from '../loop/agent-loop.js';
import { ANALYSIS_TASKS_MAX } from '../../workunit/workunit.service.js';

describe('parseTaskBreakdown', () => {
  it('解析多行 TASK: 行', () => {
    const text = '分析结论如下……\nTASK: 实现登录接口\nTASK: 补登录单测\nACTION: COMPLETE: 分析完成';
    expect(parseTaskBreakdown(text)).toEqual(['实现登录接口', '补登录单测']);
  });

  it('无 TASK 行 → 空数组', () => {
    expect(parseTaskBreakdown('只是普通输出\nACTION: COMPLETE: done')).toEqual([]);
    expect(parseTaskBreakdown('')).toEqual([]);
  });

  it('空描述行忽略；行内空白容错', () => {
    const text = 'TASK:\nTASK:   \n  TASK: 有效任务  ';
    expect(parseTaskBreakdown(text)).toEqual(['有效任务']);
  });

  it('去重（同文只保留第一条）', () => {
    const text = 'TASK: 同一任务\nTASK: 同一任务\nTASK: 另一任务';
    expect(parseTaskBreakdown(text)).toEqual(['同一任务', '另一任务']);
  });

  it('封顶 ANALYSIS_TASKS_MAX 条', () => {
    const text = Array.from({ length: ANALYSIS_TASKS_MAX + 5 }, (_, i) => `TASK: 任务${i}`).join('\n');
    expect(parseTaskBreakdown(text).length).toBe(ANALYSIS_TASKS_MAX);
  });

  it('单条超长截断到 300 字符', () => {
    const text = `TASK: ${'长'.repeat(400)}`;
    expect(parseTaskBreakdown(text)[0].length).toBe(300);
  });
});
