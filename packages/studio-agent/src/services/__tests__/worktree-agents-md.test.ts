/**
 * §10 P0（2026-07-28 修订）— worktree 工作区指南传播（index-on-demand）
 *
 * 新语义（P2 修复：杜绝 untracked 污染误伤 §10.5 提交守卫）：
 * - 仓库已有 AGENTS.md / CLAUDE.md → 一律不覆盖（对齐原 CLAUDE.md 行为），也不写生成品
 * - 两者都没有 → 不写根目录新文件（untracked 会误伤提交守卫），生成内容改落
 *   `.studio/AGENTS.generated.md`（在工具产物 exclude 内，git status 不可见）
 * - 活跃 skill 的 SKILL.md 原文仍复制到 `.studio/skills/<name>/SKILL.md`（agent-loop
 *   prompt 的 skill 段已指向该路径）
 * - status=draft 的 skill 不进索引也不落盘；`_` 前缀目录跳过
 * - manifest 读取失败 / 复制失败 → 静默跳过（不抛错）
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'node:child_process';

// SKILLS_DIR 在 worktree-resolver 模块加载时读取 —— 必须先设再 import
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-skills-'));
process.env.SKILLS_DIR = testSkillsDir;

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

// 动态 import：保证 process.env.SKILLS_DIR 赋值先于 worktree-resolver 模块加载
const { propagateHarnessConfig, buildAgentsMdContent } = await import('../worktree-resolver.js');

function writeSkill(dirName: string, frontmatterLines: string[]) {
  const dir = path.join(testSkillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatterLines.join('\n')}\n---\n\n# ${dirName}\n`,
    'utf-8',
  );
}

const GENERATED_PATH = path.join('.studio', 'AGENTS.generated.md');

let worktree: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-wt-'));
  // 预建 .harness，跳过 harness 模板拷贝分支（与本测试无关）
  fs.mkdirSync(path.join(worktree, '.harness'), { recursive: true });
  for (const d of fs.readdirSync(testSkillsDir)) {
    fs.rmSync(path.join(testSkillsDir, d), { recursive: true, force: true });
  }
});

afterEach(() => {
  try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('propagateHarnessConfig → 工作区指南（P2 修订语义）', () => {
  test('无 AGENTS.md/CLAUDE.md → 写 .studio/AGENTS.generated.md（skill 索引 + SDD），根目录不写新文件', async () => {
    writeSkill('feature-dev', ['name: feature-dev', 'description: "功能开发流程"', 'status: published']);
    writeSkill('tdd-implement', ['name: tdd-implement', 'description: "TDD 实施"']);
    writeSkill('draft-skill', ['name: draft-skill', 'description: "草稿不进索引"', 'status: draft']);

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    // 根目录零污染（untracked 文件会误伤提交守卫）
    expect(fs.existsSync(path.join(worktree, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, 'CLAUDE.md'))).toBe(false);

    const generated = fs.readFileSync(path.join(worktree, GENERATED_PATH), 'utf-8');
    expect(generated).toContain('## 可用 Skills');
    expect(generated).toContain('**feature-dev** — 功能开发流程');
    expect(generated).toContain('**tdd-implement** — TDD 实施');
    expect(generated).not.toContain('draft-skill');
    expect(generated).toContain('.studio/skills/<name>/SKILL.md');
    expect(generated).toContain('docs/sdd/<slug>/requirement.md');
    expect(generated).toContain('docs/sdd/_index.md');

    // 活跃 skill 的 SKILL.md 原文落盘；draft 不落盘
    const featureDevSrc = fs.readFileSync(path.join(testSkillsDir, 'feature-dev', 'SKILL.md'), 'utf-8');
    expect(fs.readFileSync(path.join(worktree, '.studio', 'skills', 'feature-dev', 'SKILL.md'), 'utf-8')).toBe(featureDevSrc);
    expect(fs.existsSync(path.join(worktree, '.studio', 'skills', 'tdd-implement', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.studio', 'skills', 'draft-skill', 'SKILL.md'))).toBe(false);
  });

  test('已有 AGENTS.md → 不覆盖、不写生成品（skill 索引漂移不再制造未提交改动）', async () => {
    writeSkill('feature-dev', ['name: feature-dev', 'description: "功能开发流程"']);
    fs.writeFileSync(path.join(worktree, 'AGENTS.md'), '# 仓库自有指南\n', 'utf-8');

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    expect(fs.readFileSync(path.join(worktree, 'AGENTS.md'), 'utf-8')).toBe('# 仓库自有指南\n');
    expect(fs.existsSync(path.join(worktree, GENERATED_PATH))).toBe(false);
    // skill 全文落盘不受影响
    expect(fs.existsSync(path.join(worktree, '.studio', 'skills', 'feature-dev', 'SKILL.md'))).toBe(true);
  });

  test('已有 AGENTS.md 且内容与生成品不同 → 仍保持原内容（不漂移）', async () => {
    writeSkill('feature-dev', ['name: feature-dev', 'description: "功能开发流程"']);
    const original = '# Team Guide\n\n与 buildAgentsMdContent 生成内容完全不同。\n';
    fs.writeFileSync(path.join(worktree, 'AGENTS.md'), original, 'utf-8');
    expect(buildAgentsMdContent()).not.toBe(original);

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    expect(fs.readFileSync(path.join(worktree, 'AGENTS.md'), 'utf-8')).toBe(original);
    expect(fs.existsSync(path.join(worktree, GENERATED_PATH))).toBe(false);
  });

  test('已有 CLAUDE.md（工程级约束）→ 不覆盖、不写生成品', async () => {
    writeSkill('feature-dev', ['name: feature-dev', 'description: "功能开发流程"']);
    fs.writeFileSync(path.join(worktree, 'CLAUDE.md'), '# 工程级约束\n', 'utf-8');

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    expect(fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8')).toBe('# 工程级约束\n');
    expect(fs.existsSync(path.join(worktree, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, GENERATED_PATH))).toBe(false);
  });

  test('_-prefixed skill dir is skipped (index + copy)', async () => {
    writeSkill('_wip-skill', ['name: _wip-skill', 'description: "内部草稿"']);

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    const generated = fs.readFileSync(path.join(worktree, GENERATED_PATH), 'utf-8');
    expect(generated).not.toContain('_wip-skill');
    expect(fs.existsSync(path.join(worktree, '.studio', 'skills', '_wip-skill', 'SKILL.md'))).toBe(false);
  });

  test('skill copy failure → silent (generated file still written)', async () => {
    writeSkill('feature-dev', ['name: feature-dev', 'description: "功能开发流程"']);
    // 目标路径预置为普通文件 → mkdirSync 抛 EEXIST → 静默跳过
    fs.mkdirSync(path.join(worktree, '.studio', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.studio', 'skills', 'feature-dev'), 'block', 'utf-8');

    await expect(propagateHarnessConfig(worktree, 'task-1', 'exec-1')).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(worktree, GENERATED_PATH))).toBe(true);
  });

  test('manifest load failure → skip silently (no throw, no files)', async () => {
    // 把 SKILLS_DIR 替换成一个普通文件：readdirSync 抛 ENOTDIR → 静默跳过
    fs.rmSync(testSkillsDir, { recursive: true, force: true });
    fs.writeFileSync(testSkillsDir, 'not a directory', 'utf-8');

    await expect(propagateHarnessConfig(worktree, 'task-1', 'exec-1')).resolves.toBeUndefined();
    expect(buildAgentsMdContent()).toBeNull();
    expect(fs.existsSync(path.join(worktree, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, GENERATED_PATH))).toBe(false);

    // 恢复目录供后续用例
    fs.rmSync(testSkillsDir, { force: true });
    fs.mkdirSync(testSkillsDir, { recursive: true });
  });
});

describe('propagateHarnessConfig → repoDir CLAUDE.md 传播（2026-07-28 同仓限定）', () => {
  // 跨仓复制 = untracked 内容文件污染源（§10.5 提交守卫恒非空，e2e 实测 16 步空转）。
  // 同仓传播是 FIX #3 原意图（worktree checkout 一般已含 CLAUDE.md，缺失才补）。
  const git = (cwd: string, cmd: string) =>
    execSync(`git -C "${cwd}" ${cmd}`, { stdio: 'pipe' });

  function makeRepo(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-repo-'));
    git(repo, 'init -q');
    fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
    git(repo, 'add README.md');
    git(repo, '-c user.name=t -c user.email=t@t commit -qm init');
    return repo;
  }

  test('跨仓：repoDir 与 worktree 属于不同 git 仓库 → 不复制（杜绝 untracked 污染）', async () => {
    const repoA = makeRepo();  // 扮演 studio 默认仓（带 CLAUDE.md）
    fs.writeFileSync(path.join(repoA, 'CLAUDE.md'), '# studio 约束\n');
    const repoB = makeRepo();  // 扮演 WU 工程仓
    const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-wts-')), 'wt');
    git(repoB, `worktree add "${wt}" -q`);

    await propagateHarnessConfig(wt, 'task-1', 'exec-1', repoA);

    expect(fs.existsSync(path.join(wt, 'CLAUDE.md'))).toBe(false);
    // 工具产物（.claude/.studio/.harness）由 createWorktree 的 exclude 机制覆盖，
    // 本用例只断言 CLAUDE.md 不成为污染源
    expect(git(wt, 'status --porcelain').toString()).not.toContain('CLAUDE.md');
  });

  test('同仓：worktree 属于 repoDir 同一仓库且缺 CLAUDE.md → 复制（FIX #3 原意图保留）', async () => {
    const repo = makeRepo();
    // CLAUDE.md 只在主 checkout（untracked），worktree checkout 没有
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# 工程级约束\n');
    const wt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-wts-')), 'wt');
    git(repo, `worktree add "${wt}" -q`);
    expect(fs.existsSync(path.join(wt, 'CLAUDE.md'))).toBe(false);

    await propagateHarnessConfig(wt, 'task-1', 'exec-1', repo);

    expect(fs.readFileSync(path.join(wt, 'CLAUDE.md'), 'utf-8')).toBe('# 工程级约束\n');
  });

  test('非 git 目录（判定失败）→ 不复制（宁可不传播也不污染）', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudemd-nogit-'));
    fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# x\n');

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1', repoDir);

    expect(fs.existsSync(path.join(worktree, 'CLAUDE.md'))).toBe(false);
  });
});
