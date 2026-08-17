/**
 * #163（T8-E2）：parseOpportunities 单测——巡检 WU 输出的 OPPORTUNITY: 协议行解析
 */
import { describe, it, expect } from 'vitest';
import { parseOpportunities } from '../loop/agent-loop-parsers.js';
import { INSPECTION_OPPORTUNITIES_MAX } from '../../workunit/workunit.service.js';

describe('parseOpportunities', () => {
  it('解析多条 OPPORTUNITY: 行（含 estimate 可省）', () => {
    const text = [
      '巡检报告正文……',
      'OPPORTUNITY: {"problem":"登录接口缺少限流","suggestion":"加 rate-limit 中间件","estimate":"半天"}',
      'OPPORTUNITY: {"problem":"README 与实际启动命令不一致","suggestion":"改 README 快速开始段"}',
      'ACTION: COMPLETE: 巡检完成',
    ].join('\n');
    expect(parseOpportunities(text)).toEqual([
      { problem: '登录接口缺少限流', suggestion: '加 rate-limit 中间件', estimate: '半天' },
      { problem: 'README 与实际启动命令不一致', suggestion: '改 README 快速开始段' },
    ]);
  });

  it('无 OPPORTUNITY 行 → 空数组', () => {
    expect(parseOpportunities('只是普通输出\nACTION: COMPLETE: done')).toEqual([]);
    expect(parseOpportunities('')).toEqual([]);
  });

  it('缺 problem/suggestion 或 JSON 损坏的条目丢弃', () => {
    const text = [
      'OPPORTUNITY: {"suggestion":"只有建议"}',
      'OPPORTUNITY: {"problem":"只有问题"}',
      'OPPORTUNITY: {损坏 json}',
      'OPPORTUNITY: {"problem":"  ","suggestion":"空白问题"}',
      'OPPORTUNITY: {"problem":"有效问题","suggestion":"有效建议"}',
    ].join('\n');
    expect(parseOpportunities(text)).toEqual([
      { problem: '有效问题', suggestion: '有效建议' },
    ]);
  });

  it('去重（problem+suggestion 同文只保留第一条）', () => {
    const line = 'OPPORTUNITY: {"problem":"同一问题","suggestion":"同一建议"}';
    const text = `${line}\n${line}\nOPPORTUNITY: {"problem":"另一问题","suggestion":"另一建议"}`;
    expect(parseOpportunities(text)).toHaveLength(2);
  });

  it('封顶 INSPECTION_OPPORTUNITIES_MAX 条', () => {
    const text = Array.from(
      { length: INSPECTION_OPPORTUNITIES_MAX + 5 },
      (_, i) => `OPPORTUNITY: {"problem":"问题${i}","suggestion":"建议${i}"}`,
    ).join('\n');
    expect(parseOpportunities(text).length).toBe(INSPECTION_OPPORTUNITIES_MAX);
  });

  it('单字段超长截断到 300 字符', () => {
    const text = `OPPORTUNITY: {"problem":"${'长'.repeat(400)}","suggestion":"s"}`;
    expect(parseOpportunities(text)[0].problem.length).toBe(300);
  });
});
