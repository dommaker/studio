import { describe, it, expect } from 'vitest';
import { SkillLoader } from '../loader.js';
import { allSkillDefinitions, tddWorkflow, forensicReview, toolRisk } from '../definitions/index.js';

describe('SkillLoader', () => {
  const loader = new SkillLoader();

  it('should load skills for goal_start trigger', () => {
    const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.some(s => s.id === 'tdd-workflow')).toBe(true);
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
    const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', exclude: ['tdd-workflow'] });
    expect(skills.some(s => s.id === 'tdd-workflow')).toBe(false);
  });

  it('should format skills for prompt', () => {
    const skills = [tddWorkflow];
    const prompt = loader.formatForPrompt(skills);
    expect(prompt).toContain('TDD 工作流');
  });

  it('should have 9 skill definitions', () => {
    expect(allSkillDefinitions).toHaveLength(9);
  });

  it('should get single skill by id', () => {
    const skill = loader.get('tdd-workflow');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('TDD Workflow');
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
});
