/**
 * Provider registry unit tests (shared package)
 *
 * Covers: built-in definitions, ~/.studio/providers.json deep-merge
 * (tmp files — never touches the real config or installed CLIs),
 * health-probe resolution, and spawn-args templates.
 * The daemon-level buildSpawnArgs integration is covered in
 * apps/api/src/daemon/__tests__/providers.test.ts.
 */

import { describe, test, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BUILTIN_PROVIDERS,
  CODEX_SAFETY_CONFIG_ARGS,
  loadProviderRegistry,
  listScanProviders,
  getProviderDefinition,
  resolveProviderDefinition,
  buildHealthProbeCommand,
  buildArgsFromTemplate,
  resetProviderRegistryCache,
} from '../providers.js';

const tmpFiles: string[] = [];

function writeConfig(content: unknown): string {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'studio-providers-')),
    'providers.json',
  );
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content), 'utf-8');
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  resetProviderRegistryCache();
  for (const p of tmpFiles.splice(0)) {
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
  }
});

describe('provider registry built-ins', () => {
  test('contains claude, kimi, codex, opencode', () => {
    for (const id of ['claude', 'kimi', 'codex', 'opencode']) {
      expect(BUILTIN_PROVIDERS[id], id).toBeDefined();
      expect(BUILTIN_PROVIDERS[id].binaries[0]).toBe(id);
    }
  });

  test('openclaw stays available but is excluded from the default scan list', () => {
    expect(BUILTIN_PROVIDERS.openclaw).toBeDefined();
    expect(BUILTIN_PROVIDERS.openclaw.scanDefault).toBe(false);
    expect(listScanProviders('/nonexistent/providers.json')).toEqual([
      'claude', 'kimi', 'codex', 'opencode',
    ]);
  });
});

describe('loadProviderRegistry config merge', () => {
  test('tolerates a missing config file', () => {
    const registry = loadProviderRegistry('/nonexistent/providers.json');
    expect(Object.keys(registry)).toEqual(['claude', 'kimi', 'codex', 'opencode', 'openclaw']);
  });

  test('tolerates malformed JSON', () => {
    const p = writeConfig('{ not json');
    const registry = loadProviderRegistry(p);
    expect(registry.claude).toBeDefined();
    expect(registry.kimi).toBeDefined();
  });

  test('deep-merges overrides over built-ins', () => {
    const p = writeConfig({
      claude: { healthProbeArgs: ['doctor'], env: { FOO: 'bar' } },
    });
    const def = getProviderDefinition('claude', p)!;
    expect(def.healthProbeArgs).toEqual(['doctor']);
    expect(def.env).toEqual({ FOO: 'bar' });
    // untouched fields survive the merge
    expect(def.binaries).toEqual(['claude']);
    expect(def.spawn.baseArgs).toEqual(BUILTIN_PROVIDERS.claude.spawn.baseArgs);
  });

  test('accepts a { "providers": { ... } } wrapper', () => {
    const p = writeConfig({ providers: { kimi: { displayName: 'Kimi Custom' } } });
    expect(getProviderDefinition('kimi', p)!.displayName).toBe('Kimi Custom');
  });

  test('adds user-defined providers and can re-enable openclaw scan', () => {
    const p = writeConfig({
      mycli: {
        displayName: 'My CLI',
        binaries: ['mycli'],
        versionArgs: ['--version'],
        healthProbeArgs: ['--version'],
        spawn: { baseArgs: [], defaultOutputFormat: 'text', promptViaStdin: true },
      },
      openclaw: { scanDefault: true },
    });
    expect(getProviderDefinition('mycli', p)!.id).toBe('mycli');
    expect(listScanProviders(p)).toEqual(['claude', 'kimi', 'codex', 'opencode', 'openclaw', 'mycli']);
  });
});

describe('health probe resolution', () => {
  test('resolves probe commands per provider', () => {
    expect(buildHealthProbeCommand('claude', '/nonexistent/providers.json')).toBe('claude --version');
    expect(buildHealthProbeCommand('kimi', '/nonexistent/providers.json')).toBe('kimi --version');
    expect(buildHealthProbeCommand('codex', '/nonexistent/providers.json')).toBe('codex --version');
    expect(buildHealthProbeCommand('opencode', '/nonexistent/providers.json')).toBe('opencode --version');
  });

  test('falls back to `<id> --version` for unknown providers', () => {
    const def = resolveProviderDefinition('somecli', '/nonexistent/providers.json');
    expect(def.binaries).toEqual(['somecli']);
    expect(buildHealthProbeCommand('somecli', '/nonexistent/providers.json')).toBe('somecli --version');
  });

  test('honours healthProbeArgs overrides', () => {
    const p = writeConfig({ claude: { healthProbeArgs: ['doctor'] } });
    expect(buildHealthProbeCommand('claude', p)).toBe('claude doctor');
  });
});

describe('spawn-args templates', () => {
  test('claude defaults are byte-identical to the pre-F4 adapter', () => {
    const { args, promptViaStdin } = buildArgsFromTemplate(BUILTIN_PROVIDERS.claude, {});
    expect(args).toEqual(['--print', '--output-format', 'stream-json', '--verbose']);
    expect(promptViaStdin).toBe(true);
  });

  test('claude full params keep flag order and values', () => {
    const { args } = buildArgsFromTemplate(BUILTIN_PROVIDERS.claude, {
      outputFormat: 'json',
      sessionId: 'abc-123',
      maxTurns: 10,
      extraArgs: ['--allowedTools', 'Read'],
    });
    expect(args).toEqual([
      '--print', '--output-format', 'json', '--verbose',
      '--session-id', 'abc-123',
      '--max-turns', '10',
      '--allowedTools', 'Read',
    ]);
  });

  test('kimi: print mode via --prompt flag, session via --session, no stdin', () => {
    const { args, promptViaStdin } = buildArgsFromTemplate(BUILTIN_PROVIDERS.kimi, {
      prompt: 'do it', sessionId: '01HZX', model: 'k2',
    });
    expect(args).toEqual([
      '--output-format', 'stream-json',
      '--session', '01HZX',
      '--model', 'k2',
      '--prompt', 'do it',
    ]);
    expect(promptViaStdin).toBe(false);
  });

  test('codex: exec --json + hook-trust bypass + 安全基线 -c 覆盖, resume subcommand for sessions, positional prompt', () => {
    // #147：exec 非交互下未信任 hook 一律跳过，需 --dangerously-bypass-hook-trust 才能执行
    // project hooks.json（0.147.0 实测）；studio 经 propagateHarnessConfig 自行审查 hook 来源。
    expect(buildArgsFromTemplate(BUILTIN_PROVIDERS.codex, {}).args)
      .toEqual(['exec', '--json', '--dangerously-bypass-hook-trust', ...CODEX_SAFETY_CONFIG_ARGS]);
    expect(buildArgsFromTemplate(BUILTIN_PROVIDERS.codex, {}).promptViaStdin).toBe(true);

    const resumed = buildArgsFromTemplate(BUILTIN_PROVIDERS.codex, { sessionId: 'sess-1', prompt: 'continue' });
    expect(resumed.args).toEqual(['exec', 'resume', 'sess-1', '--json', '--dangerously-bypass-hook-trust', ...CODEX_SAFETY_CONFIG_ARGS, 'continue']);
    expect(resumed.promptViaStdin).toBe(false);
  });

  test('codex 安全基线（0.154.0 实测）：workspace-write 沙箱 + 显式开网 + shell env core 白名单', () => {
    // workspace-write 沙箱档位（写隔离到工作目录）
    expect(CODEX_SAFETY_CONFIG_ARGS).toContain(`'sandbox_mode="workspace-write"'`);
    // 默认断网必须显式开（agent 装依赖/git 远端操作需要），不许静默断网
    expect(CODEX_SAFETY_CONFIG_ARGS).toContain('sandbox_workspace_write.network_access=true');
    // shell 子进程 env 白名单：凭证类不进 agent 内 shell；codex 进程自身 env 不受影响
    expect(CODEX_SAFETY_CONFIG_ARGS).toContain(`'shell_environment_policy.inherit="core"'`);
    // base/resume 两条路径都带齐（resume 无 -s flag，只有 -c 覆盖可用）
    const base = buildArgsFromTemplate(BUILTIN_PROVIDERS.codex, {}).args;
    const resume = buildArgsFromTemplate(BUILTIN_PROVIDERS.codex, { sessionId: 's' }).args;
    for (const token of CODEX_SAFETY_CONFIG_ARGS) {
      expect(base).toContain(token);
      expect(resume).toContain(token);
    }
  });

  test('opencode: run --format json, --session, positional prompt', () => {
    const { args, promptViaStdin } = buildArgsFromTemplate(BUILTIN_PROVIDERS.opencode, {
      outputFormat: 'stream-json', sessionId: 's1', prompt: 'hi',
    });
    expect(args).toEqual(['run', '--format', 'json', '--session', 's1', 'hi']);
    expect(promptViaStdin).toBe(false);
  });

  test('substitutes {outputFormat} through the provider format map', () => {
    const { args } = buildArgsFromTemplate(BUILTIN_PROVIDERS.opencode, { outputFormat: 'stream-json' });
    expect(args).toEqual(['run', '--format', 'json']);
  });

  test('ignores params the provider has no flag for', () => {
    const { args } = buildArgsFromTemplate(BUILTIN_PROVIDERS.kimi, { maxTurns: 5 });
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('5');
  });

  test('unknown provider falls back to generic flags', () => {
    const def = resolveProviderDefinition('weirdcli', '/nonexistent/providers.json');
    const { args, promptViaStdin } = buildArgsFromTemplate(def, { outputFormat: 'json', sessionId: 'x' });
    expect(args).toEqual(['--session-id', 'x', '--output-format', 'json']);
    expect(promptViaStdin).toBe(true);
  });
});

describe('capability probe declarations（#565 AC1）', () => {
  test('codex 声明 capabilityProbe.helpArgs 与 conditionalFlags（0.147.0 实测 codex exec --help 含该 flag）', () => {
    expect(BUILTIN_PROVIDERS.codex.capabilityProbe).toEqual({ helpArgs: ['exec', '--help'] });
    expect(BUILTIN_PROVIDERS.codex.spawn.conditionalFlags).toEqual(['--dangerously-bypass-hook-trust']);
  });

  test('其余内置 provider 第一批不声明 conditionalFlags（核心协议 flag 不做探测剔除）', () => {
    expect(BUILTIN_PROVIDERS.claude.spawn.conditionalFlags).toBeUndefined();
    expect(BUILTIN_PROVIDERS.kimi.spawn.conditionalFlags).toBeUndefined();
    expect(BUILTIN_PROVIDERS.opencode.spawn.conditionalFlags).toBeUndefined();
  });
});

describe('auth probe declarations（#565 AC3）', () => {
  test('claude/codex 声明实测验证过的 auth 探测命令', () => {
    // 2.1.273 实测 `claude auth status` 输出 JSON loggedIn 字段
    expect(BUILTIN_PROVIDERS.claude.authProbe?.args).toEqual(['auth', 'status']);
    // 0.147.0 实测 `codex login status` 未登录 exit 1 + "Not logged in"
    expect(BUILTIN_PROVIDERS.codex.authProbe?.args).toEqual(['login', 'status']);
  });

  test('kimi/opencode 不声明 authProbe（实测无可靠探测手段 → 恒 unknown，不猜配置目录）', () => {
    expect(BUILTIN_PROVIDERS.kimi.authProbe).toBeUndefined();
    expect(BUILTIN_PROVIDERS.opencode.authProbe).toBeUndefined();
  });
});

describe('listModels declarations（#574 动态模型发现）', () => {
  test('codex/kimi/opencode 声明实测验证过的模型列表探测命令（2026-09-16 本机实测）', () => {
    // 0.147.0 实测 `codex debug models`：stdout JSON，取 visibility==="list" 的 slug
    expect(BUILTIN_PROVIDERS.codex.listModels).toEqual({ args: ['debug', 'models'], parser: 'jsonModelSlugs' });
    // 0.38.0 实测 `kimi provider list --json`：JSON，models 对象的键即模型 alias
    expect(BUILTIN_PROVIDERS.kimi.listModels).toEqual({ args: ['provider', 'list', '--json'], parser: 'jsonModelKeys' });
    // 1.18.18 实测 `opencode models`：每行一个 provider/model
    expect(BUILTIN_PROVIDERS.opencode.listModels).toEqual({ args: ['models'], parser: 'lines' });
  });

  test('claude 不声明 listModels（2.1.273 实测无模型列表命令），四内置均有静态 fallbackModels', () => {
    expect(BUILTIN_PROVIDERS.claude.listModels).toBeUndefined();
    for (const id of ['claude', 'kimi', 'codex', 'opencode'] as const) {
      expect(BUILTIN_PROVIDERS[id].fallbackModels?.length).toBeGreaterThan(0);
    }
  });

  test('providers.json 用户覆盖优先级不变：可覆盖 fallbackModels 与 listModels', () => {
    const p = writeConfig({
      claude: { fallbackModels: ['my-claude-model'] },
      mycli: {
        displayName: 'My CLI',
        binaries: ['mycli'],
        versionArgs: ['--version'],
        healthProbeArgs: ['--version'],
        spawn: { baseArgs: [], defaultOutputFormat: 'text', promptViaStdin: true },
        listModels: { args: ['models', '--json'], parser: 'jsonModelKeys' },
        fallbackModels: ['mycli/default'],
      },
    });
    expect(getProviderDefinition('claude', p)!.fallbackModels).toEqual(['my-claude-model']);
    const mycli = getProviderDefinition('mycli', p)!;
    expect(mycli.listModels).toEqual({ args: ['models', '--json'], parser: 'jsonModelKeys' });
    expect(mycli.fallbackModels).toEqual(['mycli/default']);
  });
});
