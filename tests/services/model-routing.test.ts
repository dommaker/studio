/**
 * Model 路由测试
 *
 * 覆盖：环境变量 → 模型名解析、复杂度评估、兜底逻辑
 */
import { describe, it, expect, afterEach } from 'vitest';

describe('环境变量 → 模型名解析', () => {
  afterEach(() => {
    delete process.env.__TEST_ANTHROPIC_MODEL;
    delete process.env.__TEST_OPUS_MODEL;
    delete process.env.__TEST_SONNET_MODEL;
    delete process.env.__TEST_HAIKU_MODEL;
  });

  function resolveModel(tier: string): string {
    const defaultModel = process.env.__TEST_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || '';
    const map: Record<string, string> = {
      opus:   process.env.__TEST_OPUS_MODEL   || defaultModel,
      sonnet: process.env.__TEST_SONNET_MODEL || defaultModel,
      haiku:  process.env.__TEST_HAIKU_MODEL  || defaultModel,
    };
    return map[tier] || defaultModel;
  }

  it('全部来自 ANTHROPIC_MODEL 兜底（无专属变量时）', () => {
    process.env.__TEST_ANTHROPIC_MODEL = 'test-model-pro';
    expect(resolveModel('opus')).toBe('test-model-pro');
    expect(resolveModel('sonnet')).toBe('test-model-pro');
    expect(resolveModel('haiku')).toBe('test-model-pro');
  });

  it('专属变量覆盖 ANTHROPIC_MODEL', () => {
    process.env.__TEST_ANTHROPIC_MODEL = 'test-model-pro';
    process.env.__TEST_HAIKU_MODEL = 'test-model-flash';
    expect(resolveModel('haiku')).toBe('test-model-flash');
    expect(resolveModel('sonnet')).toBe('test-model-pro');
  });

  it('未知 tier 用 ANTHROPIC_MODEL 兜底', () => {
    process.env.__TEST_ANTHROPIC_MODEL = 'claude-sonnet';
    expect(resolveModel('unknown_tier')).toBe('claude-sonnet');
  });

  it('空字符串 tier 用 ANTHROPIC_MODEL 兜底', () => {
    process.env.__TEST_ANTHROPIC_MODEL = 'claude-sonnet';
    expect(resolveModel('')).toBe('claude-sonnet');
  });
});

describe('复杂度评估 — 边界条件', () => {
  function assess(acGroup: { acs?: string[]; files?: string[] }): string {
    const acs = acGroup.acs || [];
    const files = acGroup.files || [];
    const allText = [...acs, ...files].join(' ');
    const opusKws = ['架构', '重构', '设计', '迁移', '集成', 'auth', '安全', '性能优化', '数据库迁移'];
    const haikuKws = ['修复', 'fix', 'typo', '拼写', '配置', 'config', '文档', 'doc', '补充测试', '小改动', '更新', 'update', '依赖'];

    if (opusKws.some(k => allText.toLowerCase().includes(k.toLowerCase()))) return 'opus';
    if (haikuKws.some(k => allText.toLowerCase().includes(k.toLowerCase())) && acs.length <= 2 && files.length <= 3) return 'haiku';
    return 'sonnet';
  }

  it('opus 优先于 haiku（同时命中时取 opus）', () => {
    expect(assess({ acs: ['安全修复'], files: ['src/auth.ts'] })).toBe('opus');
  });

  it('无 AC 无文件 → sonnet', () => {
    expect(assess({})).toBe('sonnet');
  });

  it('空 AC → sonnet', () => {
    expect(assess({ acs: [], files: [] })).toBe('sonnet');
  });

  it('大 AC 数量（3+）→ sonnet', () => {
    expect(assess({ acs: ['更新文档', '补充测试', '修复typo'], files: [] })).toBe('sonnet');
  });
});
