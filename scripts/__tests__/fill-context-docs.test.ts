/**
 * fill-context-docs.ts — CONTEXT.md LLM 填充器测试
 *
 * 核心逻辑覆盖：
 *   - 占位检测（HTML 注释 / harness 默认问题行 / 人工内容区分）
 *   - STALE_SINCE 与 ⚠️ 标记清除（保留人工内容与修复历史）
 *   - 变更检测（git 最后提交 vs 填充记录）与增量决策
 *   - 合并策略（只填占位/工具小节，人工小节永不覆盖）
 *   - runFill 端到端（tmp 仓库，generate/git 注入 mock，验证 dry-run 不写盘）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  analyzeContext,
  decide,
  stripStaleMarkers,
  isPlaceholderBody,
  mergeGenerated,
  collectSourceDigest,
  estimateTokens,
  buildPrompts,
  buildImportIndex,
  collectDownstream,
  findContextFiles,
  runFill,
  loadState,
  type GeneratedSections,
} from '../fill-context-docs';

// ─── fixtures ───

const TEMPLATE_CTX = `# skills

> 此文件描述 apps/api/src/modules/skills 目录的职责和上下文。

## 职责

<!-- 本目录的核心职责是什么 -->

## 核心导出

<!-- 本目录对外暴露的主要模块/函数 -->

## 依赖关系

<!-- 本目录依赖哪些其他模块，谁依赖本目录 -->

## 注意事项

<!-- 开发时需要注意的约束或约定 -->

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ \`abc123\`: 历史修复记录
`;

const STALE_MARKERS = `<!-- STALE_SINCE: 2026-07-18 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/skills/skill-loader.ts
`;

const HUMAN_CTX = `# knowledge

> 此文件描述 apps/api/src/modules/knowledge 目录的职责和上下文

${STALE_MARKERS}
## 职责

知识引擎：让系统越来越聪明。三层分离架构（Producer → Engine → Consumer）。

## 核心导出

| 模块 | 路径 | 职责 |
|------|------|------|
| \`knowledgeBus\` | \`knowledge-bus.service.ts\` | 兼容层 |

## 依赖关系

- **上游**: \`@dommaker/harness\`

## 注意事项

- Resolution 和 Incident 是独立子系统

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ \`def456\`: 另一条修复
`;

// ─── isPlaceholderBody / analyzeContext ───

describe('isPlaceholderBody', () => {
  it('空体 → 占位', () => {
    expect(isPlaceholderBody('')).toBe(true);
    expect(isPlaceholderBody('\n\n  \n')).toBe(true);
  });

  it('纯 HTML 注释 → 占位', () => {
    expect(isPlaceholderBody('\n<!-- 本目录的核心职责是什么 -->\n')).toBe(true);
  });

  it('harness 默认问题行 → 占位', () => {
    expect(isPlaceholderBody('\n本目录的核心职责是？\n')).toBe(true);
    expect(isPlaceholderBody('开发时需要注意的约束或约定：')).toBe(true);
  });

  it('人工内容 → 非占位', () => {
    expect(isPlaceholderBody('\n知识引擎：三层分离架构。\n')).toBe(false);
  });

  it('注释 + 人工内容混合 → 非占位（保守保留）', () => {
    expect(isPlaceholderBody('<!-- 注释 -->\n真实内容')).toBe(false);
  });

  it('仅 STALE 标记残留 → 占位', () => {
    expect(isPlaceholderBody('<!-- STALE_SINCE: 2026-07-18 -->\n⚠️ 以下文件已变更，本节可能过期: x.ts')).toBe(true);
  });
});

describe('analyzeContext', () => {
  it('模板骨架：四个小节全是占位', () => {
    const a = analyzeContext(TEMPLATE_CTX);
    expect(a.placeholders).toEqual(['职责', '核心导出', '依赖关系', '注意事项']);
    expect(a.humanManaged).toEqual([]);
    expect(a.hasStaleMarkers).toBe(false);
  });

  it('人工文档 + 过期标记：无占位，有标记', () => {
    const a = analyzeContext(HUMAN_CTX);
    expect(a.placeholders).toEqual([]);
    expect(a.humanManaged).toEqual(['职责', '核心导出', '依赖关系', '注意事项']);
    expect(a.hasStaleMarkers).toBe(true);
  });

  it('缺失受管小节 → missingManaged', () => {
    const a = analyzeContext('# x\n\n## 核心导出\n\n- foo\n');
    expect(a.missingManaged).toEqual(['职责', '依赖关系', '注意事项']);
    expect(a.humanManaged).toEqual(['核心导出']);
  });
});

// ─── stripStaleMarkers ───

describe('stripStaleMarkers', () => {
  it('删除 STALE_SINCE 与 ⚠️ 行，保留其余内容', () => {
    const out = stripStaleMarkers(HUMAN_CTX);
    expect(out).not.toContain('STALE_SINCE');
    expect(out).not.toContain('⚠️');
    expect(out).toContain('知识引擎');
    expect(out).toContain('## 修复历史');
    expect(out).toContain('def456');
  });

  it('不产生三连空行', () => {
    const out = stripStaleMarkers(HUMAN_CTX);
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('无标记时原样返回', () => {
    const clean = '# x\n\n## 职责\n\n真实职责内容。\n';
    expect(stripStaleMarkers(clean)).toBe(clean);
  });

  it('混在人工内容里的模板占位注释也被剔除', () => {
    const mixed = '## 核心导出\n\n<!-- 本目录对外暴露的主要模块/函数 -->\n\n- `foo` — 真实导出\n';
    const out = stripStaleMarkers(mixed);
    expect(out).not.toContain('<!-- 本目录对外暴露的主要模块/函数 -->');
    expect(out).toContain('- `foo` — 真实导出');
  });
});

// ─── decide（变更检测 + 增量决策） ───

describe('decide', () => {
  const allPlaceholder = analyzeContext(TEMPLATE_CTX);
  const humanStale = analyzeContext(HUMAN_CTX);
  const cleanHuman = analyzeContext(stripStaleMarkers(HUMAN_CTX));

  it('干净文档无触发 → skip', () => {
    const d = decide(cleanHuman, undefined, false, false);
    expect(d.action).toBe('skip');
  });

  it('仅有过期标记 → strip（不调 LLM）', () => {
    const d = decide(humanStale, undefined, false, false);
    expect(d.action).toBe('strip');
    expect(d.sectionsToFill).toEqual([]);
  });

  it('占位小节 → fill', () => {
    const d = decide(allPlaceholder, undefined, false, false);
    expect(d.action).toBe('fill');
    expect(d.sectionsToFill).toEqual(['职责', '核心导出', '依赖关系', '注意事项']);
  });

  it('源码变更 → 重填工具小节（不含人工小节）', () => {
    const record = { filledAt: '2026-07-01T00:00:00Z', sourceCommit: 'abc', toolSections: ['职责', '核心导出'] };
    const d = decide(cleanHuman, record, true, false);
    expect(d.action).toBe('fill');
    expect(d.reasons).toContain('source-changed');
    expect(d.sectionsToFill).toEqual(['职责', '核心导出']);
  });

  it('源码变更但无记录 → 不重填人工文档', () => {
    const d = decide(cleanHuman, undefined, true, false);
    expect(d.action).toBe('skip');
  });

  it('force → 重填工具小节', () => {
    const record = { filledAt: '2026-07-19T00:00:00Z', sourceCommit: 'abc', toolSections: ['依赖关系'] };
    const d = decide(cleanHuman, record, false, true);
    expect(d.action).toBe('fill');
    expect(d.sectionsToFill).toEqual(['依赖关系']);
  });
});

// ─── mergeGenerated（人工内容保留） ───

describe('mergeGenerated', () => {
  it('只填充指定小节，人工小节与修复历史原样保留', () => {
    const generated: GeneratedSections = {
      '职责': '技能加载与提案管理。',
      '核心导出': '| 导出 | 文件 | 说明 |\n|---|---|---|\n| `loadSkill` | `skill-loader.ts` | 加载技能 |',
      '依赖关系': '- 上游: `@dommaker/studio-skill`',
      '注意事项': '- 新增技能需注册到 loader',
    };
    const out = mergeGenerated(TEMPLATE_CTX + '', generated, ['职责', '核心导出', '依赖关系', '注意事项']);
    expect(out).toContain('技能加载与提案管理。');
    expect(out).toContain('`loadSkill`');
    // 占位注释清除
    expect(out).not.toContain('<!-- 本目录的核心职责是什么 -->');
    // 修复历史逐字保留
    expect(out).toContain('## 修复历史');
    expect(out).toContain('<!-- SESSION_SUMMARY_FIXES -->');
    expect(out).toContain('- ✅ `abc123`: 历史修复记录');
  });

  it('填充同时清除过期标记', () => {
    const ctx = TEMPLATE_CTX.replace('## 职责', `${STALE_MARKERS}\n## 职责`);
    const out = mergeGenerated(ctx, { '职责': '新职责。' }, ['职责']);
    expect(out).not.toContain('STALE_SINCE');
    expect(out).not.toContain('⚠️');
    expect(out).toContain('新职责。');
    // 未指定小节的占位注释同样被清除（空体下轮仍被识别为占位再填）
    expect(out).not.toContain('<!-- 本目录对外暴露的主要模块/函数 -->');
  });

  it('生成内容为空的小节不写入生成内容（安全兜底，占位注释已清）', () => {
    const out = mergeGenerated(TEMPLATE_CTX, {}, ['职责']);
    expect(out).not.toContain('<!-- 本目录的核心职责是什么 -->');
    expect(out).toContain('## 职责');
  });

  it('人工小节节永不覆盖', () => {
    const out = mergeGenerated(HUMAN_CTX, { '职责': 'LLM 乱写的' }, ['核心导出']);
    expect(out).toContain('知识引擎：让系统越来越聪明。');
    expect(out).not.toContain('LLM 乱写的');
  });

  it('生成内容里残留的占位 HTML 注释被剔除', () => {
    const generated: GeneratedSections = {
      '核心导出': '<!-- 本目录对外暴露的主要模块/函数 -->\n\n- `foo` — 真正的导出',
    };
    const out = mergeGenerated(TEMPLATE_CTX, generated, ['核心导出']);
    expect(out).not.toContain('<!-- 本目录对外暴露的主要模块/函数 -->');
    expect(out).toContain('- `foo` — 真正的导出');
  });
});

// ─── collectSourceDigest ───

describe('collectSourceDigest', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
    fs.mkdirSync(path.join(tmp, '__tests__'));
    fs.writeFileSync(path.join(tmp, 'a.service.ts'), `/**\n * A 服务\n */\nexport class A {}\n${'// pad\n'.repeat(200)}`);
    fs.writeFileSync(path.join(tmp, 'b.test.ts'), 'export const t = 1;');
    fs.writeFileSync(path.join(tmp, '__tests__', 'c.test.ts'), 'export const t = 1;');
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('跳过测试文件与 __tests__，含文件头注释与行数', () => {
    const digest = collectSourceDigest(tmp, 'x/y');
    expect(digest).toContain('### a.service.ts');
    expect(digest).toContain('A 服务');
    expect(digest).not.toContain('b.test.ts');
    expect(digest).not.toContain('__tests__');
  });

  it('按 perFileLines 截断单文件', () => {
    const digest = collectSourceDigest(tmp, 'x/y', { perFileLines: 10, maxChars: 100_000 });
    expect(digest).not.toContain('// pad\n'.repeat(50));
  });

  it('按 maxChars 封顶并标注截断', () => {
    const digest = collectSourceDigest(tmp, 'x/y', { perFileLines: 80, maxChars: 200 });
    expect(digest).toContain('已截断');
  });
});

// ─── buildPrompts / estimateTokens ───

describe('buildPrompts / estimateTokens', () => {
  it('prompt 含目录、待填小节与源码摘要', () => {
    const { system, user } = buildPrompts('apps/x', '### a.ts\nfoo', '# x', ['职责', '核心导出']);
    expect(system).toContain('JSON');
    expect(user).toContain('apps/x');
    expect(user).toContain('职责、核心导出');
    expect(user).toContain('### a.ts');
  });

  it('estimateTokens ≈ chars/4', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });
});

// ─── buildImportIndex / collectDownstream ───

describe('buildImportIndex / collectDownstream', () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'import-idx-'));
    // 目标目录：apps/api/src/modules/skills
    fs.mkdirSync(path.join(repo, 'apps/api/src/modules/skills'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps/api/src/modules/skills/skill-loader.ts'), 'export const x = 1;');
    // 目标目录：packages/studio-shared/src（包名 @dommaker/studio-shared）
    fs.mkdirSync(path.join(repo, 'packages/studio-shared/src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages/studio-shared/package.json'), JSON.stringify({ name: '@dommaker/studio-shared' }));
    fs.writeFileSync(path.join(repo, 'packages/studio-shared/src/index.ts'), 'export const y = 1;');
    // 下游引用方
    fs.mkdirSync(path.join(repo, 'apps/api/src/modules/workunit'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'apps/api/src/modules/workunit/workunit.service.ts'),
      `import { x } from '../skills/skill-loader.js';\nimport { y } from '@dommaker/studio-shared';\n`,
    );
    // 非引用方
    fs.mkdirSync(path.join(repo, 'apps/api/src/modules/wiki'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'apps/api/src/modules/wiki/wiki.ts'), 'export const w = 1;');
    // 目录内部互相引用不算下游
    fs.writeFileSync(path.join(repo, 'apps/api/src/modules/skills/routes.ts'), `import { x } from './skill-loader.js';\n`);
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('相对 import 命中间解析到目标目录', () => {
    const idx = buildImportIndex(repo);
    expect(collectDownstream(idx, repo, 'apps/api/src/modules/skills')).toEqual([
      'apps/api/src/modules/workunit/workunit.service.ts',
    ]);
  });

  it('包名 import 命中 workspace 包（含 src 子目录）', () => {
    const idx = buildImportIndex(repo);
    expect(collectDownstream(idx, repo, 'packages/studio-shared/src')).toEqual([
      'apps/api/src/modules/workunit/workunit.service.ts',
    ]);
    expect(collectDownstream(idx, repo, 'packages/studio-shared')).toEqual([
      'apps/api/src/modules/workunit/workunit.service.ts',
    ]);
  });

  it('无引用方 → 空列表', () => {
    const idx = buildImportIndex(repo);
    expect(collectDownstream(idx, repo, 'apps/api/src/modules/wiki')).toEqual([]);
  });

  it('prompt 包含下游引用列表', () => {
    const { user } = buildPrompts('d', 'digest', '# d', ['依赖关系'], ['apps/api/src/modules/workunit/workunit.service.ts']);
    expect(user).toContain('下游引用');
    expect(user).toContain('workunit.service.ts');
  });
});

// ─── runFill 端到端（mock LLM + mock git） ───

describe('runFill', () => {
  let repo: string;
  const DIR = 'apps/api/src/modules/skills';
  const HUMAN_DIR = 'packages/studio-shared/src';

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-repo-'));
    fs.mkdirSync(path.join(repo, DIR), { recursive: true });
    fs.writeFileSync(path.join(repo, DIR, 'CONTEXT.md'), TEMPLATE_CTX.replace('## 职责', `${STALE_MARKERS}\n## 职责`));
    fs.writeFileSync(path.join(repo, DIR, 'skill-loader.ts'), '/** 技能加载器 */\nexport function loadSkill() {}\n');

    fs.mkdirSync(path.join(repo, HUMAN_DIR), { recursive: true });
    fs.writeFileSync(path.join(repo, HUMAN_DIR, 'CONTEXT.md'), HUMAN_CTX);
    fs.writeFileSync(path.join(repo, HUMAN_DIR, 'index.ts'), 'export const x = 1;\n');
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const mockGenerate = async (): Promise<GeneratedSections> => ({
    '职责': '技能加载与提案管理。',
    '核心导出': '| 导出 | 文件 | 说明 |\n|---|---|---|\n| `loadSkill` | `skill-loader.ts` | 加载技能 |',
    '依赖关系': '- 上游: `@dommaker/studio-skill`',
    '注意事项': '- 约定一',
  });

  const deps = (gitTs: number | null, generate = mockGenerate) => ({
    generate,
    gitLastCommitTs: () => gitTs,
    now: () => new Date('2026-07-19T12:00:00Z'),
  });

  it('findContextFiles 发现所有 CONTEXT.md', () => {
    expect(findContextFiles(repo).sort()).toEqual([DIR, HUMAN_DIR].sort());
  });

  it('dry-run：不写文件、不调 LLM、输出计划', async () => {
    let called = 0;
    const summary = await runFill(
      { repoRoot: repo, target: 'all', dryRun: true },
      { ...deps(1000, async () => { called++; return {}; }) },
    );
    expect(called).toBe(0);
    const fillPlan = summary.plans.find(p => p.dir === DIR)!;
    expect(fillPlan.decision.action).toBe('fill');
    expect(fillPlan.estTokens).toBeGreaterThan(0);
    const stripPlan = summary.plans.find(p => p.dir === HUMAN_DIR)!;
    expect(stripPlan.decision.action).toBe('strip');
    // 文件未被改动
    expect(fs.readFileSync(path.join(repo, DIR, 'CONTEXT.md'), 'utf-8')).toContain('<!-- 本目录的核心职责是什么 -->');
    expect(fs.readFileSync(path.join(repo, HUMAN_DIR, 'CONTEXT.md'), 'utf-8')).toContain('STALE_SINCE');
  });

  it('fill：占位目录被 LLM 填充 + 标记清除；人工目录仅清标记；状态落盘', async () => {
    const statePath = path.join(repo, '.harness', 'state.json');
    const summary = await runFill(
      { repoRoot: repo, target: 'all', dryRun: false, statePath },
      deps(1000),
    );
    expect(summary.filled).toEqual([DIR]);
    expect(summary.stripped).toEqual([HUMAN_DIR]);
    expect(summary.errors).toEqual([]);

    const filled = fs.readFileSync(path.join(repo, DIR, 'CONTEXT.md'), 'utf-8');
    expect(filled).toContain('技能加载与提案管理。');
    expect(filled).not.toContain('STALE_SINCE');
    expect(filled).not.toContain('⚠️');
    expect(filled).toContain('## 修复历史');

    const stripped = fs.readFileSync(path.join(repo, HUMAN_DIR, 'CONTEXT.md'), 'utf-8');
    expect(stripped).not.toContain('STALE_SINCE');
    expect(stripped).toContain('知识引擎');

    const state = loadState(statePath);
    expect(state[DIR].toolSections).toEqual(['职责', '核心导出', '依赖关系', '注意事项']);
    expect(state[DIR].filledAt).toBe('2026-07-19T12:00:00.000Z');
    expect(state[HUMAN_DIR]).toBeUndefined(); // strip 不写填充记录
  });

  it('增量：记录新鲜（源码提交早于 filledAt）→ 全部 skip，零 LLM', async () => {
    const statePath = path.join(repo, '.harness', 'state.json');
    // 先填一轮（此时带标记/占位，强制处理）
    await runFill({ repoRoot: repo, target: 'all', dryRun: false, statePath }, deps(1000));
    // 第二轮：文件干净，git 提交 1000 < filledAt
    let called = 0;
    const summary = await runFill(
      { repoRoot: repo, target: 'all', dryRun: false, statePath },
      { generate: async () => { called++; return {}; }, gitLastCommitTs: () => 1000, now: () => new Date('2026-07-20T00:00:00Z') },
    );
    expect(called).toBe(0);
    expect(summary.skipped.sort()).toEqual([DIR, HUMAN_DIR].sort());
  });

  it('增量：源码变更（git ts 晚于 filledAt）→ 重填工具小节', async () => {
    const statePath = path.join(repo, '.harness', 'state.json');
    await runFill({ repoRoot: repo, target: 'all', dryRun: false, statePath }, deps(1000));
    const later = Date.parse('2026-07-20T00:00:00Z') / 1000;
    const summary = await runFill(
      { repoRoot: repo, target: 'all', dryRun: false, statePath },
      {
        generate: async () => ({ '职责': '更新后的职责。', '核心导出': '新表', '依赖关系': '新依赖', '注意事项': '新约定' }),
        gitLastCommitTs: (dir: string) => (dir === DIR ? later : 1000),
        now: () => new Date('2026-07-21T00:00:00Z'),
      },
    );
    expect(summary.filled).toEqual([DIR]);
    const refilled = fs.readFileSync(path.join(repo, DIR, 'CONTEXT.md'), 'utf-8');
    expect(refilled).toContain('更新后的职责。');
  });

  it('--fill 单目录：只处理目标', async () => {
    const summary = await runFill(
      { repoRoot: repo, target: DIR, dryRun: false, statePath: path.join(repo, '.harness', 's.json') },
      deps(1000),
    );
    expect(summary.filled).toEqual([DIR]);
    expect(fs.readFileSync(path.join(repo, HUMAN_DIR, 'CONTEXT.md'), 'utf-8')).toContain('STALE_SINCE');
  });

  it('LLM 失败 → 记录 error，不写文件', async () => {
    const summary = await runFill(
      { repoRoot: repo, target: DIR, dryRun: false, statePath: path.join(repo, '.harness', 's.json') },
      { generate: async () => { throw new Error('HTTP 429'); }, gitLastCommitTs: () => 1000 },
    );
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0].error).toContain('429');
    expect(fs.readFileSync(path.join(repo, DIR, 'CONTEXT.md'), 'utf-8')).toContain('<!-- 本目录的核心职责是什么 -->');
  });
});
