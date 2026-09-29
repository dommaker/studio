/**
 * format-constraint-stats（ADR-0033 块 3 子项 9）— 约束统计白话渲染唯一出口。
 *
 * 审卡 UI 禁黑话（硬要求）：摆给人看的约束统计一律过 formatConstraintStats，
 * 不摆 failRate / evaluated / total= 等字段名原文（验收测试锁句式）。
 * 候选类别词表口径源自 harness CANDIDATE_KIND_LABEL，但用完整中文句
 * （harness 侧是 report 短标签「零触发」等，审卡场景要整句白话）。
 */
export interface ConstraintStatsLike {
  /** trace 总行数（含 skip） */
  total: number;
  /** 实际评估次数（total - skip） */
  evaluated: number;
  /** 拦截（fail）次数 */
  fail: number;
}

/** 白话统计句：「累计评估 60 次，拦到 0 次」 */
export function formatConstraintStats(s: ConstraintStatsLike): string {
  if (s.total === 0) return '没有任何触发记录';
  if (s.evaluated === 0) return `有 ${s.total} 次触发记录，但都跳过未评估`;
  return `累计评估 ${s.evaluated} 次，拦到 ${s.fail} 次`;
}

/** 退役候选类别 → 白话整句（键 = harness RetireCandidateKind） */
export const CONSTRAINT_CANDIDATE_KIND_LABELS: Record<string, string> = {
  zero_trigger: '从来没被触发过',
  unevaluable: '一直没法评估',
  high_noise: '误报太多',
  zero_intercept: '从来没拦到过',
};
