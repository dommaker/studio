/**
 * check-module-cycles — 循环依赖 CI 门单元测试（#666）
 *
 * 门禁语义：
 * - 只看 prod 桶边（测试跨模块 import 是白名单，不计入环判定）
 * - 两层判定：SCC（size>1，成员集精确匹配）+ 互耦对（prod 双向）
 * - 实际有、豁免无 → 新增环 → fail；豁免有、实际无 → 豁免过期 → fail（防清单腐化）
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildModuleGraph } from '../p2c-dep-analysis.mjs';
import { prodAdjacency, checkCycles, formatViolations } from '../check-module-cycles.mjs';

function makeFixture(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

/** alpha <-> beta 生产互耦；gamma 独立无环 */
function cyclicFixture() {
  return makeFixture({
    'modules/alpha/index.ts': `import { b } from '../beta/index.js';\nexport const a = b;`,
    'modules/beta/index.ts': `import { a } from '../alpha/index.js';\nexport const b = 1;`,
    'modules/gamma/index.ts': `export const g = 1;`,
  });
}

describe('prodAdjacency', () => {
  it('只保留 prod 桶边，测试边不入图', () => {
    const dir = makeFixture({
      'modules/alpha/index.ts': `export const a = 1;`,
      'modules/beta/index.ts': `export const b = 1;`,
      // 仅测试文件互耦：不应构成环
      'modules/alpha/__tests__/x.test.ts': `import { b } from '../../beta/index.js';`,
      'modules/beta/__tests__/y.test.ts': `import { a } from '../../alpha/index.js';`,
    });
    const adj = prodAdjacency(buildModuleGraph(dir));
    expect(adj.size).toBe(0);
    const { ok, violations } = checkCycles(buildModuleGraph(dir), { sccs: [], mutualPairs: [] });
    expect(ok).toBe(true);
    expect(violations).toEqual([]);
  });

  it('type-only import 算结构依赖（与 no-deep-module-import 口径一致）', () => {
    const dir = makeFixture({
      'modules/alpha/index.ts': `import type { B } from '../beta/index.js';\nexport type A = B;`,
      'modules/beta/index.ts': `import type { A } from '../alpha/index.js';\nexport type B = A;`,
    });
    const adj = prodAdjacency(buildModuleGraph(dir));
    expect(adj.get('alpha')?.has('beta')).toBe(true);
    expect(adj.get('beta')?.has('alpha')).toBe(true);
  });
});

describe('checkCycles', () => {
  it('无豁免时：环 → new-scc + new-pair 违规', () => {
    const g = buildModuleGraph(cyclicFixture());
    const { ok, violations } = checkCycles(g, { sccs: [], mutualPairs: [] });
    expect(ok).toBe(false);
    const kinds = violations.map(v => `${v.kind}:${v.key}`);
    expect(kinds).toContain('new-scc:alpha,beta');
    expect(kinds).toContain('new-pair:alpha<->beta');
  });

  it('豁免精确匹配实际 → 通过', () => {
    const g = buildModuleGraph(cyclicFixture());
    const { ok, violations } = checkCycles(g, {
      sccs: [{ modules: ['alpha', 'beta'], reason: '测试豁免' }],
      mutualPairs: [{ a: 'alpha', b: 'beta', reason: '测试豁免' }],
    });
    expect(ok).toBe(true);
    expect(violations).toEqual([]);
  });

  it('豁免缺互耦对 → new-pair 违规（SCC 豁免不掩盖直连互耦）', () => {
    const g = buildModuleGraph(cyclicFixture());
    const { ok, violations } = checkCycles(g, {
      sccs: [{ modules: ['alpha', 'beta'], reason: 'x' }],
      mutualPairs: [],
    });
    expect(ok).toBe(false);
    expect(violations.map(v => v.kind)).toEqual(['new-pair']);
  });

  it('豁免有、实际无 → stale 违规（防清单腐化）', () => {
    const g = buildModuleGraph(cyclicFixture());
    const { ok, violations } = checkCycles(g, {
      sccs: [
        { modules: ['alpha', 'beta'], reason: 'x' },
        { modules: ['ghost'], reason: '已清零的环' },
      ],
      mutualPairs: [
        { a: 'alpha', b: 'beta', reason: 'x' },
        { a: 'foo', b: 'bar', reason: '已清零' },
      ],
    });
    expect(ok).toBe(false);
    const kinds = violations.map(v => `${v.kind}:${v.key}`).sort();
    expect(kinds).toEqual(['stale-pair:bar<->foo', 'stale-scc:ghost']);
  });

  it('SCC 成员集漂移（新模块加入环簇）→ new-scc + stale-scc', () => {
    const dir = makeFixture({
      'modules/alpha/index.ts': `import { b } from '../beta/index.js';\nexport const a = b;`,
      'modules/beta/index.ts': `import { g } from '../gamma/index.js';\nexport const b = 1;`,
      'modules/gamma/index.ts': `import { a } from '../alpha/index.js';\nexport const g = 1;`,
    });
    const g = buildModuleGraph(dir);
    const { ok, violations } = checkCycles(g, {
      sccs: [{ modules: ['alpha', 'beta'], reason: '旧两元环' }],
      mutualPairs: [],
    });
    expect(ok).toBe(false);
    expect(violations.some(v => v.kind === 'new-scc' && v.key === 'alpha,beta,gamma')).toBe(true);
    expect(violations.some(v => v.kind === 'stale-scc' && v.key === 'alpha,beta')).toBe(true);
  });
});

describe('formatViolations', () => {
  it('产出可读违规清单', () => {
    const g = buildModuleGraph(cyclicFixture());
    const { violations } = checkCycles(g, { sccs: [], mutualPairs: [] });
    const text = formatViolations(violations);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text.length).toBeGreaterThan(0);
  });
});
