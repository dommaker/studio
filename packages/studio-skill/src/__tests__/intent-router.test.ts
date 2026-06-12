/**
 * Intent Router 测试
 *
 * AC:
 * 1. 关键词匹配返回对应 skill
 * 2. 无匹配返回空
 * 3. 无 intentKeywords 的 skill 被跳过
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
    trigger: 'always',
    agentTypes: [],
    tier: 'standard',
    prompt: 'test prompt',
    ...overrides,
  };
}

describe('matchIntent', () => {
  it('returns skill when message contains matching keyword', () => {
    const skill = makeSkill({ intentKeywords: ['deploy', 'release'] });
    const result = matchIntent('please deploy the app', [skill]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('test-skill');
  });

  it('returns empty array when no keywords match', () => {
    const skill = makeSkill({ intentKeywords: ['deploy'] });
    const result = matchIntent('fix the bug', [skill]);
    expect(result).toHaveLength(0);
  });

  it('skips skills without intentKeywords', () => {
    const skill = makeSkill(); // no intentKeywords
    const result = matchIntent('anything', [skill]);
    expect(result).toHaveLength(0);
  });

  it('is case insensitive', () => {
    const skill = makeSkill({ intentKeywords: ['Deploy'] });
    const result = matchIntent('DEPLOY now', [skill]);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty message', () => {
    const skill = makeSkill({ intentKeywords: ['deploy'] });
    expect(matchIntent('', [skill])).toHaveLength(0);
    expect(matchIntent('   ', [skill])).toHaveLength(0);
  });

  it('returns multiple matching skills sorted by match count', () => {
    const s1 = makeSkill({ id: 's1', intentKeywords: ['deploy'] });
    const s2 = makeSkill({ id: 's2', intentKeywords: ['test', 'deploy'] });
    const result = matchIntent('deploy and test', [s1, s2]);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('s2'); // more matches first
    expect(result[1]).toBe('s1');
  });

  it('handles skill with empty intentKeywords array', () => {
    const skill = makeSkill({ intentKeywords: [] });
    const result = matchIntent('anything', [skill]);
    expect(result).toHaveLength(0);
  });
});
