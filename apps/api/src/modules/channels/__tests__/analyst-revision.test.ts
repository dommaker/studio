import { describe, it, expect } from 'vitest';
import { buildRevisionPrompt } from '../analyst-prompt.js';

describe('buildRevisionPrompt', () => {
  const originalRequirement = '@Analyst 添加用户登录功能';
  const gateIssues = [
    'AC 组 "auth" 包含 7 个 AC，超过上限 5',
    '文件 src/old-auth.ts 不存在',
  ];
  const originalDoc = '# RequirementsDoc\n\n```json\n{"title":"用户登录","acGroups":[{"id":"auth","acs":["AC1","AC2"]}]}\n```';

  it('contains original requirement', () => {
    const prompt = buildRevisionPrompt(originalRequirement, gateIssues, originalDoc);
    expect(prompt).toContain(originalRequirement);
  });

  it('contains gate issues', () => {
    const prompt = buildRevisionPrompt(originalRequirement, gateIssues, originalDoc);
    for (const issue of gateIssues) {
      expect(prompt).toContain(issue);
    }
  });

  it('contains revision instruction (修正), not re-explore instruction (从头探索)', () => {
    const prompt = buildRevisionPrompt(originalRequirement, gateIssues, originalDoc);
    expect(prompt).toContain('修正');
    expect(prompt).not.toContain('从头探索');
  });

  it('contains original RequirementsDoc content', () => {
    const prompt = buildRevisionPrompt(originalRequirement, gateIssues, originalDoc);
    expect(prompt).toContain('用户登录');
    expect(prompt).toContain('acGroups');
  });

  it('handles empty gate issues gracefully', () => {
    const prompt = buildRevisionPrompt(originalRequirement, [], originalDoc);
    expect(prompt).toContain(originalRequirement);
    expect(prompt).toContain('修正');
  });

  it('includes GATE_REVISION_ATTEMPT marker instruction with default attempt=1', () => {
    const prompt = buildRevisionPrompt(originalRequirement, gateIssues, originalDoc);
    expect(prompt).toContain('GATE_REVISION_ATTEMPT 2');
  });

  it('increments revision attempt in marker instruction', () => {
    const prompt = buildRevisionPrompt(originalRequirement, gateIssues, originalDoc, 2);
    expect(prompt).toContain('GATE_REVISION_ATTEMPT 3');
  });
});
