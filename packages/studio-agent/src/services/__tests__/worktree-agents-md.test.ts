/**
 * worktree AGENTS.md / skill 落盘停用后的 propagateHarnessConfig 行为
 *
 * 治理决策（docs/plans/2026-07-27-agents-md-skill-governance.md 决策 6）：
 * runtime 全面停写 AGENTS.md / CLAUDE.md（合成）/ skill 文件拷贝，prompt 为唯一注入通道。
 * 保留：repoDir CLAUDE.md 复制、.harness 配置传播、.claude/settings.json（MCP）。
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ESM 模块命名空间不可 spyOn → 用 vi.mock('os') + hoisted holder 控制 homedir
const { homedirHolder } = vi.hoisted(() => ({ homedirHolder: { home: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => homedirHolder.home };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

const { propagateHarnessConfig } = await import('../worktree-resolver.js');

let worktree: string;
let hostHome: string;

beforeEach(() => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-wt-'));
  // 预建 .harness，跳过 harness 模板拷贝分支（与本测试无关）
  fs.mkdirSync(path.join(worktree, '.harness'), { recursive: true });
  // 假 host home（无 .kimi-code）→ ensureKimiHookHome 直接跳过，测试聚焦 claude settings
  hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-host-'));
  homedirHolder.home = hostHome;
});

afterEach(() => {
  try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(hostHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('propagateHarnessConfig → 停写 AGENTS.md / CLAUDE.md / skill 拷贝（决策 6）', () => {
  test('不写 AGENTS.md、不合成 CLAUDE.md、不复制 skill 文件', async () => {
    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    expect(fs.existsSync(path.join(worktree, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(worktree, 'CLAUDE.md'))).toBe(false);
    // .studio/ 只承载 #147 生成的执法 hook 脚本，无 skill 拷贝
    expect(fs.readdirSync(path.join(worktree, '.studio'))).toEqual(['command-gate-hook.js']);
  });

  test('仍写 .claude/settings.json（bypassPermissions + studio MCP + deny 规则 #147）', async () => {
    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    const settings = JSON.parse(
      fs.readFileSync(path.join(worktree, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
    expect(settings.mcpServers.studio.type).toBe('sse');
    expect(settings.mcpServers.studio.url).toBeTruthy();
    expect(settings.mcpServers['local-rag']).toBeTruthy();
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      'Bash(rm -rf *)',
      'Bash(git push --force*)',
      'Bash(git reset --hard*)',
      'Write(~/.studio/**)',
      'Edit(~/.studio/**)',
    ]));
    // claude --print 下 PreToolUse hook 不触发（#138 §3.1）：不给 claude 写 hook
    expect(settings.hooks).toBeUndefined();
  });

  test('repoDir 的 CLAUDE.md 仍复制到 worktree', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-repo-'));
    try {
      fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# 工程级约束\n', 'utf-8');

      await propagateHarnessConfig(worktree, 'task-1', 'exec-1', repoDir);

      expect(fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8')).toBe('# 工程级约束\n');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('worktree 已有 CLAUDE.md 时不被 repoDir 版本覆盖', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-repo-'));
    try {
      fs.writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# repo 版\n', 'utf-8');
      fs.writeFileSync(path.join(worktree, 'CLAUDE.md'), '# worktree 版\n', 'utf-8');

      await propagateHarnessConfig(worktree, 'task-1', 'exec-1', repoDir);

      expect(fs.readFileSync(path.join(worktree, 'CLAUDE.md'), 'utf-8')).toBe('# worktree 版\n');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  test('settings.json 已存在时幂等合并：保留既有字段 + 确保 deny 就位（#147）', async () => {
    fs.mkdirSync(path.join(worktree, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.claude', 'settings.json'), '{"custom":true}\n', 'utf-8');

    await propagateHarnessConfig(worktree, 'task-1', 'exec-1');

    const settings = JSON.parse(
      fs.readFileSync(path.join(worktree, '.claude', 'settings.json'), 'utf-8'),
    );
    expect(settings.custom).toBe(true);
    expect(settings.permissions.defaultMode).toBe('bypassPermissions');
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      'Bash(rm -rf *)',
      'Bash(git push --force*)',
      'Bash(git reset --hard*)',
    ]));
    expect(settings.mcpServers).toBeTruthy();
  });
});
