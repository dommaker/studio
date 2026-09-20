/**
 * G-002 补测：scanHarnessConstraints 走真 harness 生效集。
 *
 * harness 1.10.0（ADR-0029）：三层命名（iron_law/guideline/prompt）废弃，
 * 规则名前缀改为显式 severity（error/warning）。
 *
 * 不 mock fs——直接对仓内实装 @dommaker/harness 断言，harness 层再
 * 重构导致本测试失效时即提示 scanner 需随动。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../knowledge-singletons.js', () => ({
  sharedStore: { list: vi.fn().mockReturnValue([]) },
}));

import { ruleScanner } from '../rule-scanner.js';

describe('RuleScanner.scanHarnessConstraints', () => {
  it('按 severity（error/warning）前缀扫描生效集，不含已废弃的三层命名', () => {
    const rules = (ruleScanner as any).scanHarnessConstraints() as Array<{
      name: string;
      description: string;
    }>;
    const prefixes = [...new Set(rules.map(r => r.name.split(':')[0]))];

    expect(prefixes).toContain('error');
    expect(prefixes).toContain('warning');
    expect(prefixes).not.toContain('iron_law');
    expect(prefixes).not.toContain('guideline');
    expect(prefixes).not.toContain('prompt');
    expect(prefixes).not.toContain('tip');

    const errorRules = rules.filter(r => r.name.startsWith('error:'));
    expect(errorRules.length).toBeGreaterThan(0);
    expect(errorRules.every(r => r.description.length > 0)).toBe(true);
  });
});
