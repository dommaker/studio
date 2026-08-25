/**
 * domain-vocab 测试（决策 8：阶段导向单一词表 + legacy 归一化）
 */
import { describe, it, expect } from 'vitest';
import { STAGE_TYPES, normalizeToStage } from '../domain-vocab';

describe('STAGE_TYPES 词表', () => {
  it('包含全部 8 个阶段名', () => {
    expect(STAGE_TYPES).toEqual([
      'design', 'plan', 'implement', 'review', 'docs', 'refactor', 'analysis', 'general',
    ]);
  });
});

describe('normalizeToStage', () => {
  it('阶段名原样通过', () => {
    for (const stage of STAGE_TYPES) {
      expect(normalizeToStage(stage)).toBe(stage);
    }
  });

  it('legacy 归一化：feature/bug → implement', () => {
    expect(normalizeToStage('feature')).toBe('implement');
    expect(normalizeToStage('bug')).toBe('implement');
  });

  it('legacy 归一化：task → general', () => {
    expect(normalizeToStage('task')).toBe('general');
  });

  it('未知值原样返回（容错，不丢信息）', () => {
    expect(normalizeToStage('executor')).toBe('executor');
    expect(normalizeToStage('随便什么')).toBe('随便什么');
  });

  it('阶段名大小写不敏感（统一返回小写）', () => {
    expect(normalizeToStage('Implement')).toBe('implement');
    expect(normalizeToStage('REVIEW')).toBe('review');
  });
});
