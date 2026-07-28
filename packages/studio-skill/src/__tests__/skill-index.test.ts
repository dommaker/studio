/**
 * Skill Index Mode — metadata+index consumption model
 *
 * AC:
 * 1. formatForPrompt() returns name+description index, no prompt body
 * 2. getFullPrompt(id) returns single skill's full prompt
 * 3. Index is significantly smaller than old full injection
 */
import { describe, it, expect } from 'vitest';
import { SkillLoader } from '../loader.js';

const testSkills = [
  {
    id: 'tdd-workflow',
    name: 'TDD Workflow',
    description: 'Test-driven development workflow',
    agentTypes: ['executor'],
    prompt: '## TDD Steps\n1. Write failing test\n2. Implement\n3. Refactor\n\nThis is a long prompt with detailed instructions that should NOT appear in the index.',
  },
  {
    id: 'review-skill',
    name: 'Multi-Stance Review',
    description: 'Review from multiple perspectives',
    agentTypes: ['reviewer'],
    prompt: '## Review Process\n1. Read code\n2. Check patterns\n3. Report issues\n\nDetailed review instructions that should NOT appear in index.',
  },
  {
    id: 'always-skill',
    name: 'Behaviour Constraints',
    description: 'Always-on constraints',
    agentTypes: ['executor'],
    prompt: '## Constraints\n- No any type\n- TDD required\n\nDetailed constraint text that should NOT appear in index.',
  },
];

describe('SkillLoader metadata+index mode', () => {
  it('formatForPrompt returns index without prompt body', () => {
    const loader = new SkillLoader(testSkills);
    const index = loader.formatForPrompt(
      loader.load({ agentType: 'executor' }),
    );

    // Should contain skill names and descriptions
    expect(index).toContain('TDD Workflow');
    expect(index).toContain('Test-driven development workflow');
    expect(index).toContain('Behaviour Constraints');

    // Should NOT contain full prompt body
    expect(index).not.toContain('## TDD Steps');
    expect(index).not.toContain('Write failing test');
    expect(index).not.toContain('## Constraints');
    expect(index).not.toContain('No any type');
  });

  it('getFullPrompt returns complete prompt for a skill', () => {
    const loader = new SkillLoader(testSkills);

    const prompt = loader.getFullPrompt('tdd-workflow');
    expect(prompt).toBe('## TDD Steps\n1. Write failing test\n2. Implement\n3. Refactor\n\nThis is a long prompt with detailed instructions that should NOT appear in the index.');
  });

  it('getFullPrompt returns null for nonexistent skill', () => {
    const loader = new SkillLoader(testSkills);
    expect(loader.getFullPrompt('nonexistent')).toBeNull();
  });

  it('index is significantly smaller than full injection', () => {
    const loader = new SkillLoader(testSkills);
    const skills = loader.load({ agentType: 'executor' });

    const index = loader.formatForPrompt(skills);
    const fullPrompt = skills.map(s => s.prompt).join('\n---\n');

    // Index should be much smaller than full prompt
    expect(index.length).toBeLessThan(fullPrompt.length);
    // At least 50% smaller
    expect(index.length).toBeLessThan(fullPrompt.length * 0.5);
  });

  it('formatForPrompt returns empty string for no skills', () => {
    const loader = new SkillLoader(testSkills);
    expect(loader.formatForPrompt([])).toBe('');
  });

  it('formatForPrompt handles skills with empty description', () => {
    const loader = new SkillLoader([
      {
        id: 'no-desc',
        name: 'No Description',
        description: '',
        agentTypes: [],
        prompt: 'Full prompt content',
      },
    ]);
    const skills = loader.load({});
    const index = loader.formatForPrompt(skills);
    expect(index).toContain('No Description');
    expect(index).not.toContain('Full prompt content');
  });
});
