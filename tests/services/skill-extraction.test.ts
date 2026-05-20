/**
 * Skill auto-publish 逻辑单元测试（BP-003）
 */

import { describe, it, expect } from 'vitest';

// 从 skill-extraction.service.ts 中提取出的纯逻辑
function shouldAutoPublish(confidence: number, threshold = 0.8): boolean {
  return (confidence || 0.5) >= threshold;
}

function formatConfidence(confidence: number): string {
  return confidence.toFixed(2);
}

describe('Skill auto-publish 逻辑', () => {
  it('confidence ≥ 0.8 → auto-publish', () => {
    expect(shouldAutoPublish(0.85)).toBe(true);
    expect(shouldAutoPublish(0.90)).toBe(true);
    expect(shouldAutoPublish(1.0)).toBe(true);
  });

  it('confidence < 0.8 → pending', () => {
    expect(shouldAutoPublish(0.79)).toBe(false);
    expect(shouldAutoPublish(0.60)).toBe(false);
    expect(shouldAutoPublish(0.30)).toBe(false);
  });

  it('confidence 正好 0.8 → auto-publish（边界值）', () => {
    expect(shouldAutoPublish(0.80)).toBe(true);
  });

  it('confidence 未提供 → 默认 0.5 → pending', () => {
    expect(shouldAutoPublish(0)).toBe(false);
    expect(shouldAutoPublish(NaN)).toBe(false);
  });

  it('confidence 格式化', () => {
    expect(formatConfidence(0.85)).toBe('0.85');
    expect(formatConfidence(0.8)).toBe('0.80');
    expect(formatConfidence(1)).toBe('1.00');
  });

  it('auto-publish 和 pending 生成正确的 SkillProposal 状态', () => {
    const scenarios = [
      { confidence: 0.85, expectedSkillStatus: 'published', expectedProposalStatus: 'approved' },
      { confidence: 0.60, expectedSkillStatus: 'draft', expectedProposalStatus: 'pending' },
      { confidence: 0.80, expectedSkillStatus: 'published', expectedProposalStatus: 'approved' },
      { confidence: 0.35, expectedSkillStatus: 'draft', expectedProposalStatus: 'pending' },
    ];

    for (const s of scenarios) {
      const autoPublish = shouldAutoPublish(s.confidence);
      const skillStatus = autoPublish ? 'published' : 'draft';
      const proposalStatus = autoPublish ? 'approved' : 'pending';

      expect(skillStatus).toBe(s.expectedSkillStatus);
      expect(proposalStatus).toBe(s.expectedProposalStatus);
    }
  });
});
