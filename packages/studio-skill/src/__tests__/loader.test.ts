import { describe, it, expect } from 'vitest';
import { SkillLoader } from '../loader.js';
import { allSkillDefinitions, greenOnlyTdd, forensicReview, toolRisk, contractTestWriting } from '../definitions/index.js';

describe('SkillLoader', () => {
  const loader = new SkillLoader();

  it('should load skills for goal_start trigger', () => {
    const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some(s => s.id === 'green-only-tdd')).toBe(true);
  });

  it('should include always-trigger skills', () => {
    const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
    expect(skills.some(s => s.trigger === 'always')).toBe(true);
  });

  it('should filter by agentType', () => {
    const execSkills = loader.load({ trigger: 'goal_start', agentType: 'executor' });
    expect(execSkills.every(s => s.agentTypes.includes('executor'))).toBe(true);
  });

  it('should filter by tier threshold', () => {
    const fastSkills = loader.load({ trigger: 'review', agentType: 'reviewer', tier: 'fast' });
    // multiStanceReview is standard tier, shouldn't be loaded at fast
    expect(fastSkills.some(s => s.id === 'multi-stance-review')).toBe(false);

    const standardSkills = loader.load({ trigger: 'review', agentType: 'reviewer', tier: 'standard' });
    expect(standardSkills.some(s => s.id === 'multi-stance-review')).toBe(true);
  });

  it('should respect exclude option', () => {
    const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', exclude: ['green-only-tdd'] });
    expect(skills.some(s => s.id === 'green-only-tdd')).toBe(false);
  });

  it('should format skills for prompt', () => {
    const skills = [greenOnlyTdd];
    const prompt = loader.formatForPrompt(skills);
    expect(prompt).toContain('GREEN');
  });

  it('should have 10 skill definitions', () => {
    expect(allSkillDefinitions).toHaveLength(10);
  });

  it('should get single skill by id', () => {
    const skill = loader.get('green-only-tdd');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('GREEN-Only TDD');
  });

  describe('forensic-review skill', () => {
    it('should load for reviewer at standard tier on review trigger', () => {
      const skills = loader.load({ trigger: 'review', agentType: 'reviewer', tier: 'standard' });
      expect(skills.some(s => s.id === 'forensic-review')).toBe(true);
    });

    it('should not load for executor', () => {
      const skills = loader.load({ trigger: 'review', agentType: 'executor', tier: 'standard' });
      expect(skills.some(s => s.id === 'forensic-review')).toBe(false);
    });

    it('should have forensic detection prompt content', () => {
      expect(forensicReview.prompt).toContain('Fallback');
      expect(forensicReview.prompt).toContain('Hack');
      expect(forensicReview.prompt).toContain('门禁绕过');
    });
  });

  describe('tool-risk skill', () => {
    it('should load for executor on any trigger (always)', () => {
      const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
      expect(skills.some(s => s.id === 'tool-risk')).toBe(true);
    });

    it('should not load for reviewer', () => {
      const skills = loader.load({ trigger: 'review', agentType: 'reviewer', tier: 'standard' });
      expect(skills.some(s => s.id === 'tool-risk')).toBe(false);
    });

    it('should have risk detection prompt content', () => {
      expect(toolRisk.prompt).toContain('rm -rf');
      expect(toolRisk.prompt).toContain('force');
      expect(toolRisk.prompt).toContain('禁止执行');
    });
  });

  describe('contract-test-writing skill', () => {
    it('should load for analyst at premium tier on goal_start trigger', () => {
      const skills = loader.load({ trigger: 'goal_start', agentType: 'analyst', tier: 'premium' });
      expect(skills.some(s => s.id === 'contract-test-writing')).toBe(true);
    });

    it('should not load for executor', () => {
      const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'premium' });
      expect(skills.some(s => s.id === 'contract-test-writing')).toBe(false);
    });

    it('should have contract test prompt content', () => {
      expect(contractTestWriting.prompt).toContain('契约测试');
      expect(contractTestWriting.prompt).toContain('AC');
      expect(contractTestWriting.prompt).toContain('vitest');
    });
  });

  describe('green-only-tdd skill', () => {
    it('should not contain RED phase instructions', () => {
      expect(greenOnlyTdd.prompt).not.toContain('写失败');
      expect(greenOnlyTdd.prompt).not.toContain('确认失败');
    });

    it('should contain GREEN phase instructions', () => {
      expect(greenOnlyTdd.prompt).toContain('读 Analyst');
      expect(greenOnlyTdd.prompt).toContain('实现代码');
      expect(greenOnlyTdd.prompt).toContain('确认通过');
    });
  });
});
