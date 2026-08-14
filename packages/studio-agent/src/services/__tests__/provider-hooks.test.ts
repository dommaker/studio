/**
 * provider-hooks 单元测试（#147 步内前置拦截层）
 *
 * 覆盖：claude deny 规则生成、hook 脚本落盘、codex hooks.json 生成、
 * kimi per-worktree home 生成（host 配置复制 + hook 追加 + 凭证软链）与幂等性。
 * 用真实临时目录（os.homedir mock 到假 host home），断言产物内容与结构。
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

import {
  HOOK_MARKER,
  hookScriptPath,
  resolveCommandGatePath,
  buildHookScriptContent,
  writeHookScript,
  buildClaudeDenyRules,
  buildCodexHooksJson,
  writeCodexHooks,
  ensureKimiHookHome,
  kimiCodeHomePath,
  kimiCodeHomeReady,
  hostKimiCodeHome,
  writeProviderEnforcementConfigs,
} from '../provider-hooks.js';

let hostHome: string;
let worktree: string;

beforeEach(() => {
  hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-host-'));
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-wt-'));
  homedirHolder.home = hostHome;
});

afterEach(() => {
  try { fs.rmSync(hostHome, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── hook 脚本 ───

describe('buildHookScriptContent / writeHookScript', () => {
  test('脚本含 marker、harness CommandGate 引用与 exit 2 阻断', () => {
    const content = buildHookScriptContent();
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain('require(');
    expect(content).toContain('CommandGate');
    expect(content).toContain('process.exit(2)');
    expect(content).toContain('tool_input');
  });

  test('resolveCommandGatePath 指向真实存在的 harness dist 文件', () => {
    const p = resolveCommandGatePath();
    expect(p.endsWith(path.join('dist', 'gates', 'command.js'))).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  test('writeHookScript 落盘到 .studio/ 且幂等（二次调用内容一致）', () => {
    writeHookScript(worktree);
    const p = hookScriptPath(worktree);
    expect(fs.existsSync(p)).toBe(true);
    const first = fs.readFileSync(p, 'utf-8');
    writeHookScript(worktree);
    expect(fs.readFileSync(p, 'utf-8')).toBe(first);
  });
});

// ─── claude deny 规则 ───

describe('buildClaudeDenyRules', () => {
  test('含 3 条静态命令规则 + ~/.studio 越界写', () => {
    const deny = buildClaudeDenyRules({ worktree });
    expect(deny).toEqual(expect.arrayContaining([
      'Bash(rm -rf *)',
      'Bash(git push --force*)',
      'Bash(git reset --hard*)',
      'Write(~/.studio/**)',
      'Edit(~/.studio/**)',
    ]));
  });

  test('worktree 在主仓库外 → 追加主仓库绝对路径 Write/Edit deny', () => {
    const deny = buildClaudeDenyRules({ worktree: '/worktrees/wt-1', repoDir: '/root/projects/studio' });
    expect(deny).toContain('Write(//root/projects/studio/**)');
    expect(deny).toContain('Edit(//root/projects/studio/**)');
  });

  test('worktree 在主仓库内（VPS 子目录形态）→ 不加主仓库 deny（防误伤合法写）', () => {
    const deny = buildClaudeDenyRules({ worktree: '/root/projects/studio/.worktrees/wt-1', repoDir: '/root/projects/studio' });
    expect(deny.find(r => r.includes('//root/projects/studio'))).toBeUndefined();
  });

  test('repoDir 缺省 → 只出静态 + ~/.studio 规则', () => {
    const deny = buildClaudeDenyRules({ worktree });
    expect(deny.filter(r => r.startsWith('Edit(//') || r.startsWith('Write(//'))).toEqual([]);
  });
});

// ─── codex hooks.json ───

describe('buildCodexHooksJson / writeCodexHooks', () => {
  test('结构：PreToolUse matcher Bash → node hook 脚本，timeout 10', () => {
    const json = buildCodexHooksJson(worktree);
    const pre = (json.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>;
    expect(json.description).toContain(HOOK_MARKER);
    expect(pre).toHaveLength(1);
    expect(pre[0].matcher).toBe('Bash');
    const hooks = pre[0].hooks as Array<Record<string, unknown>>;
    expect(hooks[0].type).toBe('command');
    expect(hooks[0].command).toBe(`node ${hookScriptPath(worktree)}`);
    expect(hooks[0].timeout).toBe(10);
  });

  test('writeCodexHooks 落盘 <worktree>/.codex/hooks.json 且幂等', () => {
    writeCodexHooks(worktree);
    const p = path.join(worktree, '.codex', 'hooks.json');
    expect(fs.existsSync(p)).toBe(true);
    const first = fs.readFileSync(p, 'utf-8');
    writeCodexHooks(worktree);
    expect(fs.readFileSync(p, 'utf-8')).toBe(first);
  });
});

// ─── kimi per-worktree home ───

describe('ensureKimiHookHome', () => {
  function seedHostKimiHome(): void {
    fs.mkdirSync(path.join(hostHome, '.kimi-code', 'credentials'), { recursive: true });
    fs.mkdirSync(path.join(hostHome, '.kimi-code', 'oauth'), { recursive: true });
    fs.writeFileSync(path.join(hostHome, '.kimi-code', 'credentials', 'token.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(hostHome, '.kimi-code', 'device_id'), 'dev-123', 'utf-8');
    fs.writeFileSync(path.join(hostHome, '.kimi-code', 'config.toml'), 'default_model = "kimi-code/k3"\n', 'utf-8');
  }

  test('复制 host 配置 + 追加 PreToolUse hook 段 + 凭证/oauth 软链 + device_id 复制', () => {
    seedHostKimiHome();
    ensureKimiHookHome(worktree);

    const wtHome = kimiCodeHomePath(worktree);
    expect(hostKimiCodeHome()).toBe(path.join(hostHome, '.kimi-code'));
    expect(kimiCodeHomeReady(worktree)).toBe(true);
    expect(kimiCodeHomeReady(path.join(worktree, 'no-such'))).toBe(false);
    expect(fs.existsSync(path.join(wtHome, 'config.toml'))).toBe(true);

    const config = fs.readFileSync(path.join(wtHome, 'config.toml'), 'utf-8');
    expect(config).toContain('default_model = "kimi-code/k3"');
    expect(config).toContain(HOOK_MARKER);
    expect(config).toContain('event = "PreToolUse"');
    expect(config).toContain('matcher = "Bash"');
    expect(config).toContain(`node ${hookScriptPath(worktree)}`);

    expect(fs.lstatSync(path.join(wtHome, 'credentials')).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(wtHome, 'oauth')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(wtHome, 'device_id'), 'utf-8')).toBe('dev-123');
  });

  test('幂等：二次调用不重复追加 hook 段', () => {
    seedHostKimiHome();
    ensureKimiHookHome(worktree);
    ensureKimiHookHome(worktree);

    const config = fs.readFileSync(path.join(kimiCodeHomePath(worktree), 'config.toml'), 'utf-8');
    expect(config.match(/event = "PreToolUse"/g)).toHaveLength(1);
  });

  test('config.toml 被删（agent 篡改）→ 重写自愈', () => {
    seedHostKimiHome();
    ensureKimiHookHome(worktree);
    fs.rmSync(path.join(kimiCodeHomePath(worktree), 'config.toml'), { force: true });
    ensureKimiHookHome(worktree);
    expect(fs.readFileSync(path.join(kimiCodeHomePath(worktree), 'config.toml'), 'utf-8')).toContain(HOOK_MARKER);
  });

  test('host 无 .kimi-code/config.toml（kimi 未初始化）→ 不生成', () => {
    ensureKimiHookHome(worktree);
    expect(fs.existsSync(kimiCodeHomePath(worktree))).toBe(false);
  });
});

// ─── 汇总入口 ───

describe('writeProviderEnforcementConfigs', () => {
  test('一次写齐 hook 脚本 + codex hooks.json + kimi home', () => {
    fs.mkdirSync(path.join(hostHome, '.kimi-code'), { recursive: true });
    fs.writeFileSync(path.join(hostHome, '.kimi-code', 'config.toml'), 'x\n', 'utf-8');

    writeProviderEnforcementConfigs({ worktree });

    expect(fs.existsSync(hookScriptPath(worktree))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.codex', 'hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.kimi-code', 'config.toml'))).toBe(true);
  });
});
