/**
 * p2c-public-surface — 立界 codemod 单元测试（P2-c）
 * parseBindings / parseDynamicNames / resolveDeepTarget / renderIndex / planPublicSurface / applyRewrites
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBindings,
  parseDynamicNames,
  analyzeDynamicUsages,
  resolveDeepTarget,
  indexSpecifier,
  renderIndex,
  planPublicSurface,
  applyRewrites,
  scanSpecifiers,
} from '../p2c-public-surface.mjs';

describe('scanSpecifiers offset 保真', () => {
  it('行注释不导致 offset 漂移（改写安全性）', () => {
    const content = `// 顶部注释 import { fake } from './fake.js';\nimport { real } from '../workunit/service.js'; // 行尾注释\n/* 块 import x from './y.js' */\nconst m = await import('../agents/loop/loop.js');`;
    const occs = scanSpecifiers(content);
    expect(occs).toHaveLength(2);
    for (const occ of occs) {
      // offset 必须精确指向原文件中的 specifier 文本
      expect(content.slice(occ.start, occ.end)).toBe(occ.spec);
      expect(content.slice(occ.stmtStart, occ.stmtEnd)).toBe(occ.statement);
    }
    expect(occs.map(o => o.spec)).toEqual(['../workunit/service.js', '../agents/loop/loop.js']);
  });
});


describe('parseBindings', () => {
  it('各种 import 形态', () => {
    expect(parseBindings(`import foo from './x.js'`).defaultName).toBe('foo');
    expect(parseBindings(`import foo, { a, b as c } from './x.js'`)).toMatchObject({
      defaultName: 'foo',
      named: [{ imported: 'a', local: 'a', isType: false }, { imported: 'b', local: 'c', isType: false }],
    });
    expect(parseBindings(`import type { A, B } from './x.js'`)).toMatchObject({ typeOnly: true });
    expect(parseBindings(`import { type A, b } from './x.js'`).named).toEqual([
      { imported: 'A', local: 'A', isType: true },
      { imported: 'b', local: 'b', isType: false },
    ]);
    expect(parseBindings(`import * as ns from './x.js'`).namespaceName).toBe('ns');
    expect(parseBindings(`export { a } from './x.js'`).isExport).toBe(true);
  });
  it('多行 import', () => {
    const b = parseBindings(`import {\n  alpha,\n  beta as b2,\n} from './x.js'`);
    expect(b.named.map(n => n.imported)).toEqual(['alpha', 'beta']);
  });
});

describe('parseDynamicNames', () => {
  it('await 解构 / .then 解构 / .then 箭头取属性', () => {
    const c1 = `const { a, b: b2 } = await import('./x.js');`;
    expect(parseDynamicNames(c1, scanSpecifiers(c1)[0]).map(n => n.imported)).toEqual(['a', 'b']);
    const c2 = `import('./x.js').then(({ a }) => a());`;
    expect(parseDynamicNames(c2, scanSpecifiers(c2)[0]).map(n => n.imported)).toEqual(['a']);
    const c3 = `import('./x.js').then(m => m.default);`;
    expect(parseDynamicNames(c3, scanSpecifiers(c3)[0]).map(n => n.imported)).toEqual(['default']);
  });
  it('require 解构', () => {
    const c = `const { WorkUnitService } = require('../workunit/workunit.service.js') as typeof import('../workunit/workunit.service.js');`;
    const occs = scanSpecifiers(c);
    const req = occs.find(o => o.kind === 'require');
    expect(parseDynamicNames(c, req).map(n => n.imported)).toEqual(['WorkUnitService']);
    expect(occs.filter(o => o.kind === 'dynamic')).toHaveLength(1); // typeof import 也算 dynamic 位
  });
});

describe('analyzeDynamicUsages', () => {
  it('命名空间持有：x.foo() 成员进公共面', () => {
    const c = `const skills = await import('../skills/review-adapter.js');\nskills.getSkillReviewAdapter();\nskills.other();`;
    const occ = scanSpecifiers(c)[0];
    const names = analyzeDynamicUsages(c).get(occ.stmtStart).map(n => n.imported);
    expect(names).toEqual(['getSkillReviewAdapter', 'other']);
  });
  it('Promise.all 位置解构：第 i 个对象模式归第 i 个 import', () => {
    const c = `const [{ RequirementService }, { selectProjectSnapshots }] = await Promise.all([\n  import('../requirements/requirement.service.js'),\n  import('../pmo/evidence-summary.js'),\n]);`;
    const occs = scanSpecifiers(c);
    const usages = analyzeDynamicUsages(c);
    expect(usages.get(occs[0].stmtStart).map(n => n.imported)).toEqual(['RequirementService']);
    expect(usages.get(occs[1].stmtStart).map(n => n.imported)).toEqual(['selectProjectSnapshots']);
  });
  it('Promise.all 标识符数组解构 + 成员访问', () => {
    const c = `const [skills, knowledge] = await Promise.all([\n  import('../skills/review-adapter.js'),\n  import('../knowledge/review-adapter.js'),\n]);\nskills.getSkillReviewAdapter();\nknowledge.getKnowledgeReviewAdapter();`;
    const occs = scanSpecifiers(c);
    const usages = analyzeDynamicUsages(c);
    expect(usages.get(occs[0].stmtStart).map(n => n.imported)).toEqual(['getSkillReviewAdapter']);
    expect(usages.get(occs[1].stmtStart).map(n => n.imported)).toEqual(['getKnowledgeReviewAdapter']);
  });
  it('同名命名空间变量重声明截断（mod 一次性变量不张冠李戴）', () => {
    const c = [
      `async function a() { const mod = await import('../knowledge/knowledge-service.js'); return mod.knowledgeService; }`,
      `async function b() { const mod = await import('../pmo/project.service.js'); return mod.projectService; }`,
    ].join('\n');
    const occs = scanSpecifiers(c);
    const usages = analyzeDynamicUsages(c);
    expect(usages.get(occs[0].stmtStart).map(n => n.imported)).toEqual(['knowledgeService']);
    expect(usages.get(occs[1].stmtStart).map(n => n.imported)).toEqual(['projectService']);
  });
});

describe('resolveDeepTarget / indexSpecifier', () => {
  it('深路径判定', () => {
    expect(resolveDeepTarget('modules/channels/foo.ts', '../workunit/workunit.service.js'))
      .toEqual({ mod: 'workunit', deepPath: 'workunit.service.ts' });
    expect(resolveDeepTarget('modules/channels/sub/foo.ts', '../../agents/loop/agent-loop.js'))
      .toEqual({ mod: 'agents', deepPath: 'loop/agent-loop.ts' });
    expect(resolveDeepTarget('app.ts', './modules/pmo/routes.js'))
      .toEqual({ mod: 'pmo', deepPath: 'routes.ts' });
    expect(resolveDeepTarget('modules/channels/foo.ts', '../workunit/index.js')).toBeNull();
    // 同模块深路径也返回 target（是否跳过由 planPublicSurface 的 consumerMod 判定负责）
    expect(resolveDeepTarget('modules/channels/foo.ts', './local.js'))
      .toEqual({ mod: 'channels', deepPath: 'local.ts' });
    expect(resolveDeepTarget('modules/channels/foo.ts', '@dommaker/studio-shared')).toBeNull();
  });
  it('index specifier 相对路径', () => {
    expect(indexSpecifier('modules/channels/foo.ts', 'workunit')).toBe('../workunit/index.js');
    expect(indexSpecifier('modules/channels/sub/foo.ts', 'workunit')).toBe('../../workunit/index.js');
    expect(indexSpecifier('app.ts', 'workunit')).toBe('./modules/workunit/index.js');
  });
});

describe('renderIndex', () => {
  it('按来源分组、值/类型分行、default 转 named', () => {
    const entries = new Map([
      ['bType', { source: './b.js', kind: 'type' }],
      ['aVal', { source: './a.js', kind: 'named' }],
      ['myDefault', { source: './a.js', kind: 'default' }],
    ]);
    const md = renderIndex('demo', entries);
    expect(md).toContain(`export { aVal, default as myDefault } from './a.js';`);
    expect(md).toContain(`export type { bType } from './b.js';`);
  });
});

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p2c-surface-'));
  const files = {
    'modules/alpha/service.ts': `export class AlphaService {}\nexport const ALPHA_FLAG = 1;`,
    'modules/alpha/routes.ts': `export default 'router';`,
    'modules/alpha/types.ts': `export type AlphaMeta = { x: number };`,
    'modules/beta/consumer.ts': [
      `import { AlphaService, ALPHA_FLAG } from '../alpha/service.js';`,
      `import type { AlphaMeta } from '../alpha/types.js';`,
      `import alphaRoutes from '../alpha/routes.js';`,
      `export async function go() { const { AlphaService: AS2 } = await import('../alpha/service.js'); return AS2; }`,
    ].join('\n'),
    'modules/beta/__tests__/consumer.test.ts': `import { AlphaService } from '../../alpha/service.js';`,
    'route-registry.ts': `const r = import('./modules/alpha/routes.js').then(m => m.default);`,
  };
  for (const [rel, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), c);
  }
  return dir;
}

describe('planPublicSurface + applyRewrites（fixture 端到端）', () => {
  it('公共面反推 + 白名单豁免 + 改写落盘', () => {
    const dir = makeFixture();
    const { surface, conflicts, rewrites } = planPublicSurface(dir);
    expect(conflicts).toEqual([]);
    const alpha = surface.get('alpha');
    expect(alpha.get('AlphaService')).toEqual({ source: './service.js', kind: 'named' });
    expect(alpha.get('ALPHA_FLAG')).toEqual({ source: './service.js', kind: 'named' });
    expect(alpha.get('AlphaMeta')).toEqual({ source: './types.js', kind: 'type' });
    // default export canonical 名 = 消费方 local 名
    expect(alpha.get('alphaRoutes')).toEqual({ source: './routes.js', kind: 'default' });
    // route-registry 白名单：不改写
    expect(rewrites.has('route-registry.ts')).toBe(false);
    // 测试白名单：不改写
    expect(rewrites.has('modules/beta/__tests__/consumer.test.ts')).toBe(false);

    const r = applyRewrites(rewrites, dir);
    expect(r.fileCount).toBe(1);
    const out = fs.readFileSync(path.join(dir, 'modules/beta/consumer.ts'), 'utf8');
    expect(out).toContain(`import { alphaRoutes } from '../alpha/index.js';`);
    expect(out).toContain(`import { AlphaService, ALPHA_FLAG } from '../alpha/index.js';`);
    expect(out).toContain(`import type { AlphaMeta } from '../alpha/index.js';`);
    expect(out).toContain(`await import('../alpha/index.js')`);
    expect(out).not.toContain('../alpha/service.js');
  });
});
