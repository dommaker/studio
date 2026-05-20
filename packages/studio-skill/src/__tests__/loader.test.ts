import { describe, it, expect } from 'vitest';
import { SkillLoader } from '../loader.js';
import { allSkillDefinitions, tddWorkflow } from '../definitions/index.js';

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

  it('should have 7 skill definitions', () => {
    expect(allSkillDefinitions).toHaveLength(7);
  });

  it('should get single skill by id', () => {
    const skill = loader.get('tdd-workflow');
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('TDD Workflow');
  });
});
