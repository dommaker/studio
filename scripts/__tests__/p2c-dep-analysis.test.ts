/**
 * p2c-dep-analysis — 模块依赖分析器单元测试（P2-c）
 * parseImports / buildModuleGraph / findMutualPairs / findSCCs / findSimpleCycles / summarize
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseImports,
  buildModuleGraph,
  findMutualPairs,
  findSCCs,
  findSimpleCycles,
  summarize,
  renderReport,
} from '../p2c-dep-analysis.mjs';

describe('parseImports', () => {
  it('提取静态 import / export-from / 动态 import / type-only', () => {
    const src = [
      `import { a } from './a.js';`,
      `import type { B } from '../b/index.js';`,
      `export { c } from './c.js';`,
      `import {`,
      `  multi,`,
      `  line,`,
      `} from './multi.js';`,
      `const x = await import('./dyn.js');`,
      `// import { fake } from './comment.js';`,
      `/* import { fake2 } from './block.js'; */`,
    ].join('\n');
    const specs = parseImports(src);
    const bySpec = Object.fromEntries(specs.map(s => [s.spec, s]));
    expect(bySpec['./a.js']).toBeTruthy();
    expect(bySpec['../b/index.js'].typeOnly).toBe(true);
    expect(bySpec['./c.js']).toBeTruthy();
    expect(bySpec['./multi.js']).toBeTruthy();
    expect(bySpec['./dyn.js'].dynamic).toBe(true);
    expect(bySpec['./comment.js']).toBeUndefined();
    expect(bySpec['./block.js']).toBeUndefined();
  });
});

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2c-dep-'));
  const mods = path.join(dir, 'modules');
  const files = {
    'modules/alpha/index.ts': `import { b } from '../beta/service.js';\nexport const a = b;`,
    'modules/beta/service.ts': `import type { A } from '../alpha/types.js';\nexport const b = 1;`,
    'modules/beta/types.ts': `export type B = string;`,
    'modules/alpha/types.ts': `export type A = string;`,
    'modules/gamma/index.ts': `export const g = 1;`,
    'modules/beta/__tests__/service.test.ts': `import { a } from '../../alpha/index.js';`,
    'route-registry.ts': `const r = import('./modules/alpha/index.js');`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

describe('buildModuleGraph + 环检测', () => {
  it('构建模块图：prod/test 分桶、模块外深 import 单列', () => {
    const dir = makeFixture();
    const g = buildModuleGraph(dir);
    expect(g.modules).toEqual(['alpha', 'beta', 'gamma']);
    expect(g.edges.get('alpha').get('beta')).toHaveLength(1);
    // beta→alpha：service.ts 的 type-only import（prod，结构依赖也算）+ __tests__ 的 import（test 桶）
    expect(g.edges.get('beta').get('alpha')).toHaveLength(2);
    expect(g.outsideDeep).toHaveLength(1);
    expect(g.outsideDeep[0].toMod).toBe('alpha');
    const s = summarize(g);
    expect(s.prodCrossModuleImports).toBe(2);
    expect(s.testCrossModuleImports).toBe(1);
  });

  it('互耦对与 SCC', () => {
    const dir = makeFixture();
    const g = buildModuleGraph(dir);
    const pairs = findMutualPairs(g.edges);
    expect(pairs).toEqual([{ a: 'alpha', b: 'beta', ab: 1, ba: 1 }]);
    const sccs = findSCCs(g.modules, g.edges);
    expect(sccs).toEqual([['alpha', 'beta']]);
  });

  it('简单环枚举去重且规范化', () => {
    const edges = new Map([
      ['a', new Map([['b', [{ bucket: 'prod' }]]])],
      ['b', new Map([['c', [{ bucket: 'prod' }]], ['a', [{ bucket: 'prod' }]]])],
      ['c', new Map([['a', [{ bucket: 'prod' }]]])],
    ]);
    const cycles = findSimpleCycles(['a', 'b', 'c'], edges);
    const norms = cycles.map(c => c.join('->')).sort();
    expect(norms).toContain('a->b');       // a<->b 二元环
    expect(norms).toContain('a->b->c');    // 三元环，只出现一次
    expect(norms).toHaveLength(2);
  });

  it('renderReport 产出 Markdown 含关键段', () => {
    const dir = makeFixture();
    const g = buildModuleGraph(dir);
    const md = renderReport(g);
    expect(md).toContain('# P2-c 模块依赖显形报告');
    expect(md).toContain('互耦对');
    expect(md).toContain('alpha');
  });
});
