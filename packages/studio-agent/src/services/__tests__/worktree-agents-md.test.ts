/**
 * §10 P0 — worktree AGENTS.md / CLAUDE.md 生成 + skill 全文落盘（index-on-demand）
 *
 * - propagateHarnessConfig 写 AGENTS.md（skill 索引 + 全文指针 + SDD 落盘要求）与 CLAUDE.md（内容一致），
 *   并把活跃 skill 的 SKILL.md 原文复制到 `.studio/skills/<name>/SKILL.md`
 * - status=draft 的 skill 不进索引也不落盘；`_` 前缀目录跳过；已有 CLAUDE.md（工程级）不被覆盖
 * - manifest 读取失败 / 复制失败 → 静默跳过（不抛错）
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

describe('propagateHarnessConfig → AGENTS.md / CLAUDE.md（§10 P0）', () => {
  test('writes AGENTS.md with skill index lines + SDD requirements; CLAUDE.md identical', async () => {
    writeSkill('feature-dev', ['name: feature-dev', 'description: "功能开发流程"', 'status: published']);
    writeSkill('tdd-implement', ['name: tdd-implement', 'description: "TDD 实施"']);
    writeSkill('draft-skill', ['name: draft-skill', 'description: "草稿不进索引"', 'status: draft']);

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    const agentsMd = fs.readFileSync(path.join(worktree, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('## 可用 Skills');
    expect(agentsMd).toContain('**feature-dev** — 功能开发流程');
    expect(agentsMd).toContain('**tdd-implement** — TDD 实施');
    expect(agentsMd).not.toContain('draft-skill');
    expect(agentsMd).toContain('.studio/skills/<name>/SKILL.md');
    expect(agentsMd).toContain('docs/sdd/<slug>/requirement.md');
    expect(agentsMd).toContain('docs/sdd/_index.md');

    const claudeMd = fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toBe(agentsMd);

    // 活跃 skill 的 SKILL.md 原文落盘；draft 不落盘
    const featureDevSrc = fs.readFileSync(path.join(testSkillsDir, 'feature-dev', 'SKILL.md'), 'utf-8');
    expect(fs.readFileSync(path.join(worktree, '.studio', 'skills', 'feature-dev', 'SKILL.md'), 'utf-8')).toBe(featureDevSrc);
    expect(fs.existsSync(path.join(worktree, '.studio', 'skills', 'tdd-implement', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.studio', 'skills', 'draft-skill', 'SKILL.md'))).toBe(false);
  });

  test('_-prefixed skill dir is skipped (index + copy)', async () => {
    writeSkill('_wip-skill', ['name: _wip-skill', 'description: "内部草稿"']);

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    const agentsMd = fs.readFileSync(path.join(worktree, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).not.toContain('_wip-skill');
    expect(fs.existsSync(path.join(worktree, '.studio', 'skills', '_wip-skill', 'SKILL.md'))).toBe(false);
  });

  test('skill copy failure → silent (AGENTS.md still written)', async () => {
    writeSkill('feature-dev', ['name: feature-dev', 'description: "功能开发流程"']);
    // 目标路径预置为普通文件 → mkdirSync 抛 EEXIST → 静默跳过
    fs.mkdirSync(path.join(worktree, '.studio', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.studio', 'skills', 'feature-dev'), 'block', 'utf-8');

    await expect(propagateHarnessConfig(worktree, 'task-1', 'exec-1')).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(worktree, 'AGENTS.md'))).toBe(true);
  });

  test('does not overwrite an existing CLAUDE.md (repo-propagated)', async () => {
    writeSkill('feature-dev', ['name: feature-dev', 'description: "功能开发流程"']);
    fs.writeFileSync(path.join(worktree, 'CLAUDE.md'), '# 工程级约束\n', 'utf-8');

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    expect(fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8')).toBe('# 工程级约束\n');
    expect(fs.existsSync(path.join(worktree, 'AGENTS.md'))).toBe(true);
  });

  test('manifest load failure → skip silently (no throw, no files)', async () => {
    // 把 SKILLS_DIR 替换成一个普通文件：readdirSync 抛 ENOTDIR → 静默跳过
    fs.rmSync(testSkillsDir, { recursive: true, force: true });
    fs.writeFileSync(testSkillsDir, 'not a directory', 'utf-8');

    await expect(propagateHarnessConfig(worktree, 'task-1', 'exec-1')).resolves.toBeUndefined();
    expect(buildAgentsMdContent()).toBeNull();
    expect(fs.existsSync(path.join(worktree, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, 'CLAUDE.md'))).toBe(false);

    // 恢复目录供后续用例
    fs.rmSync(testSkillsDir, { force: true });
    fs.mkdirSync(testSkillsDir, { recursive: true });
  });
});
