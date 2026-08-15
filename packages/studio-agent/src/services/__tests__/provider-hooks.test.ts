/**
 * provider-hooks 单元测试（#147 步内前置拦截层；#154 改指 harness 出厂 shim）
 *
 * 覆盖：claude deny 规则生成、shim 路径解析、codex hooks.json 生成、
 * kimi per-worktree home 生成（host 配置复制 + hook 追加 + 凭证软链）与幂等性、
 * #147 旧版生成脚本的存量清理。
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
  resolvePreToolUseHookPath,
  removeLegacyHookScript,
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

// ─── harness 出厂 shim 路径 ───

describe('resolvePreToolUseHookPath（#154）', () => {
  test('解析为 harness 包内 dist/pretool-use-hook.js 路径', () => {
    const p = resolvePreToolUseHookPath();
    expect(p.endsWith(path.join('@dommaker', 'harness', 'dist', 'pretool-use-hook.js'))).toBe(true);
    // 注：文件存在性依赖 harness ≥ 含 #153 shim 的发版（0.19.0 尚无）；
    // 发版前 provider 执行缺失文件 = 非 exit 2 = fail-open 放行，不致断流。
  });
});

// ─── #147 旧版生成脚本清理 ───

describe('removeLegacyHookScript（#154 存量清理）', () => {
  const legacyRel = path.join('.studio', 'command-gate-hook.js');

  test('含 marker 的生成脚本 → 删除', () => {
    const p = path.join(worktree, legacyRel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `// ${HOOK_MARKER} old generated script\n`, 'utf-8');

    removeLegacyHookScript(worktree);

    expect(fs.existsSync(p)).toBe(false);
  });

  test('不含 marker 的同名文件（非我产物）→ 不动', () => {
    const p = path.join(worktree, legacyRel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// hand-written\n', 'utf-8');

    removeLegacyHookScript(worktree);

    expect(fs.existsSync(p)).toBe(true);
  });

  test('无残留 → no-op', () => {
    expect(() => removeLegacyHookScript(worktree)).not.toThrow();
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
  test('结构：PreToolUse matcher Bash → node harness shim，timeout 10', () => {
    const json = buildCodexHooksJson();
    const pre = (json.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>;
    expect(json.description).toContain(HOOK_MARKER);
    expect(pre).toHaveLength(1);
    expect(pre[0].matcher).toBe('Bash');
    const hooks = pre[0].hooks as Array<Record<string, unknown>>;
    expect(hooks[0].type).toBe('command');
    expect(hooks[0].command).toBe(`node ${resolvePreToolUseHookPath()}`);
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
    expect(config).toContain(`node ${resolvePreToolUseHookPath()}`);

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

  test('#147 旧配置（marker 在但指向 worktree 内脚本）→ 重写迁移到 harness shim', () => {
    seedHostKimiHome();
    ensureKimiHookHome(worktree);
    // 模拟 #147 生成版：含 marker，command 指向已废弃的 worktree 内脚本
    const wtConfig = path.join(kimiCodeHomePath(worktree), 'config.toml');
    fs.writeFileSync(wtConfig,
      `default_model = "kimi-code/k3"\n\n# ${HOOK_MARKER} PreToolUse — studio-agent 生成（#147）\n` +
      `[[hooks]]\nevent = "PreToolUse"\nmatcher = "Bash"\n` +
      `command = "node ${path.join(worktree, '.studio', 'command-gate-hook.js')}"\ntimeout = 10\n`, 'utf-8');

    ensureKimiHookHome(worktree);

    const config = fs.readFileSync(wtConfig, 'utf-8');
    expect(config).toContain(`node ${resolvePreToolUseHookPath()}`);
    expect(config).not.toContain('command-gate-hook.js');
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
  test('一次写齐 codex hooks.json + kimi home（均指 harness shim），不再生成 worktree 内 hook 脚本', () => {
    fs.mkdirSync(path.join(hostHome, '.kimi-code'), { recursive: true });
    fs.writeFileSync(path.join(hostHome, '.kimi-code', 'config.toml'), 'x\n', 'utf-8');

    writeProviderEnforcementConfigs({ worktree });

    expect(fs.existsSync(path.join(worktree, '.codex', 'hooks.json'))).toBe(true);
    expect(fs.existsSync(path.join(worktree, '.kimi-code', 'config.toml'))).toBe(true);
    // #154：.studio/ 是纯文档正本进 git，hook 脚本不再落 worktree
    expect(fs.existsSync(path.join(worktree, '.studio', 'command-gate-hook.js'))).toBe(false);
    const codex = JSON.parse(fs.readFileSync(path.join(worktree, '.codex', 'hooks.json'), 'utf-8'));
    expect(codex.hooks.PreToolUse[0].hooks[0].command).toBe(`node ${resolvePreToolUseHookPath()}`);
  });

  test('顺带清理 #147 旧版生成脚本', () => {
    const legacy = path.join(worktree, '.studio', 'command-gate-hook.js');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, `// ${HOOK_MARKER} old\n`, 'utf-8');

    writeProviderEnforcementConfigs({ worktree });

    expect(fs.existsSync(legacy)).toBe(false);
  });
});
