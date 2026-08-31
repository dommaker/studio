/**
 * #150 B2：scanHarnessConstraints 改走 harness 公共 API getEffectiveConstraints，
 * 不再硬编码 node_modules/@dommaker/harness/src/core/constraints/definitions/ 源路径。
 *
 * mock getEffectiveConstraints 断言映射口径（name/description 兜底/source），
 * 与 rule-scanner.test.ts（真 harness 集成口径）互补。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetEffective } = vi.hoisted(() => ({
  mockGetEffective: vi.fn().mockReturnValue([]),
}));

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, getEffectiveConstraints: mockGetEffective };
});

vi.mock('../knowledge-singletons.js', () => ({
  sharedStore: { list: vi.fn().mockReturnValue([]) },
}));

import { ruleScanner } from '../rule-scanner.js';

describe('RuleScanner.scanHarnessConstraints — 生效集公共 API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetEffective.mockReturnValue([]);
  });

  it('调用 getEffectiveConstraints（项目根）而非读包内 src 文件', () => {
    (ruleScanner as any).scanHarnessConstraints();
    expect(mockGetEffective).toHaveBeenCalledTimes(1);
    expect(mockGetEffective.mock.calls[0][0]).toBeTruthy();
  });

  it('生效约束映射为 ScannedRule：name=level:id、source 为公共包名、sourceType 不变', () => {
    mockGetEffective.mockReturnValue([
      { id: 'no_redis_import', level: 'iron_law', rule: 'NO REDIS', message: '禁 Redis', description: 'Redis 已迁移' },
      { id: 'prefer_worktree', level: 'guideline', rule: 'USE WORKTREE', message: '用 worktree', description: '高风险改动隔离' },
      { id: 'be_terse', level: 'prompt', rule: 'BE TERSE', message: '简洁', description: '电报式输出' },
    ]);

    const rules = (ruleScanner as any).scanHarnessConstraints() as Array<{
      name: string; source: string; sourceType: string; description: string; affects: string[];
    }>;

    expect(rules.map(r => r.name)).toEqual(['iron_law:no_redis_import', 'guideline:prefer_worktree', 'prompt:be_terse']);
    for (const r of rules) {
      expect(r.source).toBe('@dommaker/harness');
      expect(r.sourceType).toBe('harness_constraint');
      expect(r.affects).toEqual(['agent', 'reviewer']);
    }
    expect(rules[0].description).toBe('Redis 已迁移');
  });

  it('description 缺失时按 message → rule 兜底（不产空描述）', () => {
    mockGetEffective.mockReturnValue([
      { id: 'no_desc', level: 'guideline', rule: 'RULE TEXT', message: '中文消息' },
    ]);

    const rules = (ruleScanner as any).scanHarnessConstraints();
    expect(rules[0].description).toBe('中文消息');
  });

  it('description 与 message 均缺失时按 rule 文本兜底（不产空描述）', () => {
    mockGetEffective.mockReturnValue([
      { id: 'only_rule', level: 'prompt', rule: 'RULE ONLY TEXT' },
    ]);

    const rules = (ruleScanner as any).scanHarnessConstraints();
    expect(rules[0].description).toBe('RULE ONLY TEXT');
  });

  it('生效集为空 → 空清单', () => {
    expect((ruleScanner as any).scanHarnessConstraints()).toEqual([]);
  });

  it('getEffectiveConstraints 抛错 → 返回空清单不向上抛（扫描兜底）', () => {
    mockGetEffective.mockImplementation(() => { throw new Error('config broken'); });
    expect((ruleScanner as any).scanHarnessConstraints()).toEqual([]);
  });
});
