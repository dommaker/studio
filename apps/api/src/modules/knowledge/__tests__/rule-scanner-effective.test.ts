/**
 * #150 B2：scanHarnessConstraints 改走 harness 公共 API getEffectiveConstraints，
 * 不再硬编码 node_modules/@dommaker/harness/src/core/constraints/definitions/ 源路径。
 *
 * mock getEffectiveConstraints 断言映射口径（name/description 兜底/source），
 * 与 rule-scanner.test.ts（真 harness 集成口径）互补。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STAGE_TYPES } from '@dommaker/studio-shared';

const { mockGetEffective } = vi.hoisted(() => ({
  mockGetEffective: vi.fn().mockReturnValue([]),
}));

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, getEffectiveConstraints: mockGetEffective };
});

vi.mock('../knowledge-singletons.js', () => ({
  sharedStore: { list: vi.fn().mockReturnValue([]), save: vi.fn() },
}));

import { ruleScanner } from '../rule-scanner.js';
import { sharedStore } from '../knowledge-singletons.js';

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

  it('生效约束映射为 ScannedRule：name=severity:id、source 为公共包名、sourceType 不变', () => {
    mockGetEffective.mockReturnValue([
      { id: 'no_redis_import', severity: 'error', kind: 'check', rule: 'NO REDIS', message: '禁 Redis', description: 'Redis 已迁移' },
      { id: 'prefer_worktree', severity: 'warning', kind: 'check', rule: 'USE WORKTREE', message: '用 worktree', description: '高风险改动隔离' },
      { id: 'be_terse', severity: 'info', kind: 'check', rule: 'BE TERSE', message: '简洁', description: '电报式输出' },
    ]);

    const rules = (ruleScanner as any).scanHarnessConstraints() as Array<{
      name: string; source: string; sourceType: string; description: string; affects: string[];
    }>;

    expect(rules.map(r => r.name)).toEqual(['error:no_redis_import', 'warning:prefer_worktree', 'info:be_terse']);
    for (const r of rules) {
      expect(r.source).toBe('@dommaker/harness');
      expect(r.sourceType).toBe('harness_constraint');
      // #612：harness 约束为全局治理规则，affects 写 []（空 = 对所有阶段可见）。
      // 词表为阶段词表（决策 8 单一词表），角色词表（agent/reviewer/…）与 wu.type 零交集已废。
      expect(r.affects).toEqual([]);
    }
    expect(rules[0].description).toBe('Redis 已迁移');
  });

  it('description 缺失时按 message → rule 兜底（不产空描述）', () => {
    mockGetEffective.mockReturnValue([
      { id: 'no_desc', severity: 'warning', kind: 'check', rule: 'RULE TEXT', message: '中文消息' },
    ]);

    const rules = (ruleScanner as any).scanHarnessConstraints();
    expect(rules[0].description).toBe('中文消息');
  });

  it('description 与 message 均缺失时按 rule 文本兜底（不产空描述）', () => {
    mockGetEffective.mockReturnValue([
      { id: 'only_rule', severity: 'info', kind: 'check', rule: 'RULE ONLY TEXT' },
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

  it('#612: inferAffects 产出 ⊆ 阶段词表（STAGE_TYPES），空数组 = 全局可见', () => {
    // 决策 8 单一阶段词表：affects 只允许阶段名或 []。
    // 曾经的角色词表（agent/executor/monitor/triage/deploy/auditor）与 wu.type 零交集，
    // 导致 rule 段对真实 WU 恒空——本断言钉住词表口径，防回退。
    const cases: string[] = [
      'apps/api/src/modules/agents/loop/x.ts',
      'apps/api/src/modules/review-proposal/y.ts',
      'apps/api/src/modules/analyst/z.ts',
      'apps/api/src/modules/monitoring/m.ts',
      'apps/api/src/modules/triage/t.ts',
      'apps/api/src/modules/deploy/d.ts',
      'apps/api/src/modules/auditor/a.ts',
      'apps/api/src/modules/workunit/w.ts',
    ];
    for (const p of cases) {
      const affects = (ruleScanner as any).inferAffects(p) as string[];
      for (const a of affects) {
        expect(STAGE_TYPES).toContain(a);
      }
    }
    expect((ruleScanner as any).inferAffects('apps/api/src/modules/review-proposal/y.ts')).toEqual(['review']);
    expect((ruleScanner as any).inferAffects('apps/api/src/modules/agents/loop/x.ts')).toEqual([]);
  });

  it('#612: 存量条目 affects 为旧角色词表 → fullScan 判 changed 自愈重写（否则旧条目永远零交集）', async () => {
    mockGetEffective.mockReturnValue([
      { id: 'no_redis_import', severity: 'error', kind: 'check', rule: 'NO REDIS', message: '禁 Redis', description: 'Redis 已迁移' },
    ]);
    const now = new Date().toISOString();
    const staleEntry = {
      id: 'rule-error_no_redis_import', type: 'guideline', title: 'error:no_redis_import',
      content: JSON.stringify({
        name: 'error:no_redis_import', category: 'constraint', description: 'Redis 已迁移',
        condition: 'always', action: 'enforce error:no_redis_import',
        source: '@dommaker/harness', sourceType: 'harness_constraint',
        affects: ['agent', 'reviewer'], // 修复前的旧角色词表
      }),
      maturity: 'active', layer: 'project', created: now, lastReferenced: now,
      tags: ['rule', 'active', 'constraint'],
    };
    (sharedStore.list as any).mockReturnValueOnce([staleEntry]);

    const res = await ruleScanner.fullScan();

    // 内容其余字段完全一致，仅 affects 词表过期 → 仍判 changed 走 updated 路径
    expect(res.updated).toBe(1);
    const saved = (sharedStore.save as any).mock.calls
      .map((c: any[]) => c[0])
      .find((e: any) => e.title === 'error:no_redis_import');
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved.content).affects).toEqual([]);
  });
});
