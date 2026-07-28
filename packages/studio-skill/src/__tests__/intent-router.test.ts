/**
 * Intent Router 测试
 *
 * AC:
 * 1. name/description 子串匹配返回对应 skill
 * 2. 无匹配返回空
 * 3. name/description 都不含关键词的 skill 被跳过
 * 4. 大小写不敏感
 * 5. 空 message 返回空
 */
import { describe, it, expect } from 'vitest';
import { matchIntent } from '../intent-router.js';
import type { SkillDefinition } from '../types.js';

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'test-skill',
    name: 'test-skill',
    description: 'Test skill',
    agentTypes: [],
    prompt: 'test prompt',
    ...overrides,
  };
}

describe('matchIntent', () => {
  it('returns skill when message contains word from name/description', () => {
    const skill = makeSkill({ id: 'deploy-skill', name: 'Deploy Skill', description: 'deploy and release' });
    const result = matchIntent('please deploy the app', [skill]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('deploy-skill');
  });

  it('returns empty array when no words match name/description', () => {
    const skill = makeSkill({ id: 'ci-skill', name: 'CI Pipeline', description: 'continuous integration' });
    const result = matchIntent('fix the bug', [skill]);
    expect(result).toHaveLength(0);
  });

  it('skips skills whose name/description contain no matching words', () => {
    const skill = makeSkill(); // name: 'test-skill', description: 'Test skill'
    const result = matchIntent('deploy', [skill]);
    expect(result).toHaveLength(0);
  });

  it('is case insensitive', () => {
    const skill = makeSkill({ id: 'deploy-skill', name: 'Deploy Skill', description: 'deployment helper' });
    const result = matchIntent('DEPLOY now', [skill]);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty message', () => {
    const skill = makeSkill({ id: 'deploy-skill', name: 'Deploy', description: 'deploy helper' });
    expect(matchIntent('', [skill])).toHaveLength(0);
    expect(matchIntent('   ', [skill])).toHaveLength(0);
  });

  it('returns multiple matching skills sorted by match count', () => {
    const s1 = makeSkill({ id: 's1', name: 'Deploy Helper', description: 'deployment tool' });
    const s2 = makeSkill({ id: 's2', name: 'Deploy Test', description: 'testing and deploy workflow' });
    const result = matchIntent('deploy and test', [s1, s2]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('s2'); // more matches first
    expect(result[1]).toBe('s1');
  });

  it('matches words longer than 2 characters only', () => {
    const skill = makeSkill({ id: 'go-skill', name: 'Go Deploy', description: 'go deployment' });
    // 'go' is only 2 chars, should not match
    expect(matchIntent('go deploy', [skill])).toHaveLength(1); // only 'deploy' matches
  });
});
