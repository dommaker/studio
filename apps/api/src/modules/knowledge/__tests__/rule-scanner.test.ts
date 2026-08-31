/**
 * G-002 补测：scanHarnessConstraints 按 harness 1.x 三定义文件扫描
 * （iron-laws / guidelines / prompts；tip 层已随 harness 1.x 移除）。
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
  it('扫描 iron_law / guideline / prompt 三层，不含已删 tip 层', () => {
    const rules = (ruleScanner as any).scanHarnessConstraints() as Array<{
      name: string;
      description: string;
    }>;
    const prefixes = [...new Set(rules.map(r => r.name.split(':')[0]))];

    expect(prefixes).toContain('iron_law');
    expect(prefixes).toContain('guideline');
    expect(prefixes).toContain('prompt');
    expect(prefixes).not.toContain('tip');

    const promptRules = rules.filter(r => r.name.startsWith('prompt:'));
    expect(promptRules.length).toBeGreaterThan(0);
    expect(promptRules.every(r => r.description.length > 0)).toBe(true);
  });
});
