/**
 * format-constraint-stats 测试（ADR-0033 块 3 子项 9：审卡 UI 禁黑话）
 *
 * 验收句式：渲染输出含「评估 N 次」句式；不含 failRate/evaluated/total= 等字段名原文。
 * 候选类别词表 = harness CANDIDATE_KIND_LABEL 语义的完整中文句。
 */
import { describe, it, expect } from 'vitest';
import { CONSTRAINT_CANDIDATE_KIND_LABELS, formatConstraintStats } from '../format-constraint-stats.js';

describe('formatConstraintStats（白话统计句）', () => {
  it('常规：累计评估 N 次，拦到 M 次', () => {
    expect(formatConstraintStats({ total: 60, evaluated: 60, fail: 0 })).toBe('累计评估 60 次，拦到 0 次');
    expect(formatConstraintStats({ total: 65, evaluated: 60, fail: 12 })).toBe('累计评估 60 次，拦到 12 次');
  });

  it('零触发 / 全跳过：不出「评估 0 次」假话', () => {
    expect(formatConstraintStats({ total: 0, evaluated: 0, fail: 0 })).toBe('没有任何触发记录');
    expect(formatConstraintStats({ total: 8, evaluated: 0, fail: 0 })).toBe('有 8 次触发记录，但都跳过未评估');
  });

  it('禁黑话：输出不含字段名原文', () => {
    for (const s of [
      formatConstraintStats({ total: 60, evaluated: 60, fail: 0 }),
      formatConstraintStats({ total: 0, evaluated: 0, fail: 0 }),
      formatConstraintStats({ total: 8, evaluated: 0, fail: 0 }),
    ]) {
      expect(s).not.toContain('failRate');
      expect(s).not.toContain('evaluated');
      expect(s).not.toContain('total=');
    }
  });
});

describe('CONSTRAINT_CANDIDATE_KIND_LABELS（候选类别白话词表）', () => {
  it('四类候选全覆盖且为整句白话', () => {
    expect(CONSTRAINT_CANDIDATE_KIND_LABELS.zero_trigger).toBe('从来没被触发过');
    expect(CONSTRAINT_CANDIDATE_KIND_LABELS.unevaluable).toBe('一直没法评估');
    expect(CONSTRAINT_CANDIDATE_KIND_LABELS.high_noise).toBe('误报太多');
    expect(CONSTRAINT_CANDIDATE_KIND_LABELS.zero_intercept).toBe('从来没拦到过');
  });
});
