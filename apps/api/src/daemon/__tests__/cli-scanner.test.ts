import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { promisify } from 'node:util';
import { resetCapabilityProbeCache, resetModelProbeCache } from '@dommaker/studio-shared/node';
import { detectProvider, detectProviderAsync, scanAllProviders, scanAllProvidersAsync, hasDocker, KNOWN_PROVIDERS } from '../cli-scanner';

// Mock child_process（detectProvider 走 execFileSync，hasDocker 走 execSync，
// detectProviderAsync 走 execFile 的 promisify.custom——模块 import 期即取值，必须挂在 mock 上）
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: Object.assign(vi.fn(), { [promisify.custom]: vi.fn() }),
}));

import { execSync, execFileSync, execFile } from 'child_process';
const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExecFileAsync = vi.mocked((execFile as any)[promisify.custom] as (...args: any[]) => Promise<{ stdout: string; stderr: string }>);

describe('cli-scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #565/#574: studio-shared 探测模块是进程内缓存（key=binary@version），
    // 用例间必须复位，避免跨用例污染
    resetCapabilityProbeCache();
    resetModelProbeCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectProvider', () => {
    test('returns runtime info when CLI is found', () => {
      mockExecFileSync
        .mockReturnValueOnce('/usr/local/bin/claude\n') // which
        .mockReturnValueOnce('claude 1.2.3\n')          // --version
        .mockReturnValueOnce('{\n  "loggedIn": true\n}\n'); // auth status

      const result = detectProvider('claude');
      expect(result).toEqual({
        provider: 'claude',
        path: '/usr/local/bin/claude',
        version: 'claude 1.2.3',
        auth: 'ok',
        authCheckedAt: expect.any(String),
        // #574: claude 未声明 listModels（实测无模型列表命令）→ 静态兜底
        models: ['opus', 'sonnet'],
        modelsSource: 'fallback',
      });
    });

    test('returns null when CLI is not found (which fails)', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = detectProvider('claude');
      expect(result).toBeNull();
    });

    test('returns version "unknown" when --version fails and -v fails', () => {
      mockExecFileSync
        .mockReturnValueOnce('/usr/local/bin/codex\n') // which
        .mockImplementationOnce(() => { throw new Error('no --version'); }) // --version
        .mockImplementationOnce(() => { throw new Error('no -v'); });       // -v

      const result = detectProvider('codex');
      expect(result).toMatchObject({
        provider: 'codex',
        path: '/usr/local/bin/codex',
        version: 'unknown',
      });
    });

    test('tries -v fallback when --version fails', () => {
      mockExecFileSync
        .mockReturnValueOnce('/usr/local/bin/opencode\n') // which
        .mockImplementationOnce(() => { throw new Error('no --version'); }) // --version
        .mockReturnValueOnce('opencode v0.5.0\n');                         // -v

      const result = detectProvider('opencode');
      expect(result).toEqual({
        provider: 'opencode',
        path: '/usr/local/bin/opencode',
        version: 'opencode v0.5.0',
        auth: 'unknown', // opencode 不声明 authProbe（#565：无可靠探测手段）
        authCheckedAt: expect.any(String),
        // #574: opencode 声明了 listModels，但本用例 mock 无第四次返回（探测失败）→ 静态兜底
        models: ['opencode/big-pickle'],
        modelsSource: 'fallback',
      });
    });

    test('detects kimi via its registry definition', () => {
      mockExecFileSync
        .mockReturnValueOnce('/root/.kimi-code/bin/kimi\n') // which
        .mockReturnValueOnce('0.27.0\n');                    // --version

      const result = detectProvider('kimi');
      expect(result).toEqual({
        provider: 'kimi',
        path: '/root/.kimi-code/bin/kimi',
        version: '0.27.0',
        auth: 'unknown', // kimi 不声明 authProbe（#565：login 无 status 子命令）
        authCheckedAt: expect.any(String),
        // #574: kimi 声明了 listModels，但本用例 mock 无第三次返回（探测失败）→ 静态兜底
        models: [
          'kimi-code/kimi-for-coding',
          'kimi-code/kimi-for-coding-highspeed',
          'kimi-code/k3',
          'kimi-code/k3-256k',
        ],
        modelsSource: 'fallback',
      });
    });

    test('returns null when which returns empty string', () => {
      mockExecFileSync.mockReturnValueOnce('');

      const result = detectProvider('openclaw');
      expect(result).toBeNull();
    });
  });

  describe('scanAllProviders', () => {
    test('returns array of detected providers', () => {
      // First provider found, others not
      let callCount = 0;
      mockExecFileSync.mockImplementation(((cmd: string, args?: readonly string[]) => {
        callCount++;
        if (cmd === 'which' && args?.[0] === 'claude') {
          return '/usr/local/bin/claude\n';
        }
        if (cmd === 'claude' && args?.includes('--version')) {
          return 'claude 1.0.0\n';
        }
        throw new Error('not found');
      }) as typeof execFileSync);

      const results = scanAllProviders();
      expect(results).toHaveLength(1);
      expect(results[0].provider).toBe('claude');
    });

    test('returns empty array when no providers found', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const results = scanAllProviders();
      expect(results).toEqual([]);
    });

    test('scans all known providers', () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('not found');
      });

      scanAllProviders();
      // Each provider triggers 1 `which` call (and throws, so no --version calls)
      const whichCalls = mockExecFileSync.mock.calls.filter(
        (call) => call[0] === 'which',
      );
      expect(whichCalls.length).toBe(KNOWN_PROVIDERS.length);
    });
  });

  describe('hasDocker', () => {
    test('returns true when docker is available', () => {
      mockExecSync.mockReturnValueOnce('Docker version 24.0.0\n');
      expect(hasDocker()).toBe(true);
    });

    test('returns false when docker is not available', () => {
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('not found');
      });
      expect(hasDocker()).toBe(false);
    });
  });

  describe('异步扫描链（2026-10-03 冷启动修复）', () => {
    test('detectProviderAsync：与 sync 同形状（path/version/auth/models fallback）', async () => {
      mockExecFileAsync.mockImplementation(async (cmd: string, args?: readonly string[]) => {
        if (cmd === 'which' && args?.[0] === 'claude') return { stdout: '/usr/local/bin/claude\n', stderr: '' };
        // 探测调用走解析后的完整路径（/usr/local/bin/claude），按结尾匹配
        if (cmd.endsWith('claude') && args?.includes('--version')) return { stdout: 'claude 1.2.3\n', stderr: '' };
        if (cmd.endsWith('claude')) return { stdout: '{\n  "loggedIn": true\n}\n', stderr: '' };
        throw new Error(`unexpected: ${cmd} ${args?.join(' ')}`);
      });

      const result = await detectProviderAsync('claude');
      expect(result).toEqual({
        provider: 'claude',
        path: '/usr/local/bin/claude',
        version: 'claude 1.2.3',
        auth: 'ok',
        authCheckedAt: expect.any(String),
        models: ['opus', 'sonnet'],
        modelsSource: 'fallback',
      });
      // 全程未碰 sync 原语
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    test('detectProviderAsync：which 失败（CLI 不存在）→ null', async () => {
      mockExecFileAsync.mockImplementation(async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      });

      expect(await detectProviderAsync('claude')).toBeNull();
    });

    test('detectProviderAsync：auth 非零退出（数字 code）→ failed；spawn 失败 → unknown', async () => {
      mockExecFileAsync.mockImplementation(async (cmd: string, args?: readonly string[]) => {
        if (cmd === 'which') return { stdout: '/usr/local/bin/claude\n', stderr: '' };
        if (args?.includes('--version')) return { stdout: '1.0.0\n', stderr: '' };
        throw Object.assign(new Error('exit 3'), { code: 3 });
      });
      const failed = await detectProviderAsync('claude');
      expect(failed?.auth).toBe('failed');

      vi.clearAllMocks();
      mockExecFileAsync.mockImplementation(async (cmd: string, args?: readonly string[]) => {
        if (cmd === 'which') return { stdout: '/usr/local/bin/claude\n', stderr: '' };
        if (args?.includes('--version')) return { stdout: '1.0.0\n', stderr: '' };
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      });
      const unknown = await detectProviderAsync('claude');
      expect(unknown?.auth).toBe('unknown');
    });

    test('scanAllProvidersAsync：保 KNOWN_PROVIDERS 顺序，每个 provider 一次 which', async () => {
      mockExecFileAsync.mockImplementation(async (cmd: string, args?: readonly string[]) => {
        if (cmd === 'which' && args?.[0] === 'kimi') return { stdout: '/usr/local/bin/kimi\n', stderr: '' };
        if (cmd === 'kimi' && args?.includes('--version')) return { stdout: 'kimi 1.0.0\n', stderr: '' };
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      });

      const results = await scanAllProvidersAsync();
      expect(results.map(r => r.provider)).toEqual(['kimi']);
      const whichCalls = mockExecFileAsync.mock.calls.filter(c => c[0] === 'which');
      expect(whichCalls.length).toBe(KNOWN_PROVIDERS.length);
    });

    test('scanAllProvidersAsync：全部不存在 → 空数组', async () => {
      mockExecFileAsync.mockImplementation(async () => {
        throw Object.assign(new Error('not found'), { code: 'ENOENT' });
      });
      expect(await scanAllProvidersAsync()).toEqual([]);
    });
  });

  describe('auth probe（#565 AC3：三态，未声明恒 unknown，不猜配置目录）', () => {
    test('claude：auth status 输出 loggedIn=true → ok', () => {
      mockExecFileSync
        .mockReturnValueOnce('/usr/local/bin/claude\n')
        .mockReturnValueOnce('2.1.273\n')
        .mockReturnValueOnce('{\n  "loggedIn": true,\n  "authMethod": "oauth_token"\n}\n');

      const result = detectProvider('claude');
      expect(result?.auth).toBe('ok');
      expect(result?.authHint).toBeUndefined();
      expect(result?.authCheckedAt).toEqual(expect.any(String));
    });

    test('claude：输出命中 loggedIn=false 模式 → failed + 修复 hint', () => {
      mockExecFileSync
        .mockReturnValueOnce('/usr/local/bin/claude\n')
        .mockReturnValueOnce('2.1.273\n')
        .mockReturnValueOnce('{\n  "loggedIn": false\n}\n');

      const result = detectProvider('claude');
      expect(result?.auth).toBe('failed');
      expect(result?.authHint).toContain('claude login');
    });

    test('codex：login status 非零退出（进程跑起来了）→ failed + 修复 hint', () => {
      mockExecFileSync.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'which') return '/usr/local/bin/codex\n';
        if (args?.includes('--version')) return 'codex-cli 0.147.0\n';
        if (args?.join(' ') === 'exec --help') return 'Usage: codex exec --json\n'; // capability warm
        if (args?.join(' ') === 'login status') {
          // 0.147.0 实测：未登录 exit 1 + "Not logged in"
          const err = new Error('Command failed') as Error & { status: number; stderr: string };
          err.status = 1;
          err.stderr = 'Not logged in';
          throw err;
        }
        throw new Error(`unexpected: ${cmd} ${args?.join(' ')}`);
      }) as typeof execFileSync);

      const result = detectProvider('codex');
      expect(result?.auth).toBe('failed');
      expect(result?.authHint).toContain('codex login');
    });

    test('探测自身出错（spawn 失败，无 exit status）→ unknown，不误报 failed', () => {
      mockExecFileSync.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'which') return '/usr/local/bin/claude\n';
        if (args?.includes('--version')) return '2.1.273\n';
        // auth status spawn 失败（如 ENOENT/超时）：没有 status 字段
        throw new Error('spawn claude ENOENT');
      }) as typeof execFileSync);

      const result = detectProvider('claude');
      expect(result?.auth).toBe('unknown');
      expect(result?.authHint).toBeUndefined();
    });

    test('未声明 authProbe 的 provider（kimi）恒 unknown，且不发起 auth 探测进程', () => {
      mockExecFileSync
        .mockReturnValueOnce('/root/.kimi-code/bin/kimi\n')
        .mockReturnValueOnce('0.38.0\n');

      const result = detectProvider('kimi');
      expect(result?.auth).toBe('unknown');
      // which + --version + #574 模型列表探测（provider list --json，mock 无返回 → 兜底）
      // 共三次进程调用，无第四次 auth 探测
      expect(mockExecFileSync).toHaveBeenCalledTimes(3);
      const authCalls = mockExecFileSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && (call[1] as string[]).includes('login'),
      );
      expect(authCalls.length).toBe(0);
    });
  });

  describe('models probe（#574：listModels 活模型 + fallback 兜底）', () => {
    const CODEX_DEBUG_MODELS = JSON.stringify({
      models: [
        { slug: 'gpt-5.6-sol', visibility: 'list' },
        { slug: 'gpt-5.5', visibility: 'list' },
        { slug: 'gpt-5.4', visibility: 'hide' },
      ],
    });

    function mockCodexCli(debugModelsOutput: string) {
      mockExecFileSync.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'which') return '/usr/local/bin/codex\n';
        if (args?.includes('--version')) return 'codex-cli 0.147.0\n';
        if (args?.join(' ') === 'exec --help') return 'Usage: codex exec --json\n'; // capability warm
        if (args?.join(' ') === 'login status') return 'Logged in\n';
        if (args?.join(' ') === 'debug models') return debugModelsOutput;
        throw new Error(`unexpected: ${cmd} ${args?.join(' ')}`);
      }) as typeof execFileSync);
    }

    test('codex：`debug models` 探测成功 → models 为实测可见 slug，source=live', () => {
      mockCodexCli(CODEX_DEBUG_MODELS);
      const result = detectProvider('codex');
      expect(result?.models).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
      expect(result?.modelsSource).toBe('live');
    });

    test('codex：探测失败 → 退回注册表静态 fallbackModels，source=fallback', () => {
      mockExecFileSync.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'which') return '/usr/local/bin/codex\n';
        if (args?.includes('--version')) return 'codex-cli 0.147.0\n';
        if (args?.join(' ') === 'exec --help') return 'Usage: codex exec --json\n';
        if (args?.join(' ') === 'login status') return 'Logged in\n';
        throw new Error('Command failed'); // debug models 非零退出
      }) as typeof execFileSync);

      const result = detectProvider('codex');
      expect(result?.modelsSource).toBe('fallback');
      expect(result?.models).toContain('gpt-5.6-sol');
    });

    test('同 binary@version 重扫命中进程内缓存，不重复跑 debug models', () => {
      mockCodexCli(CODEX_DEBUG_MODELS);
      detectProvider('codex');
      const callsAfterFirst = mockExecFileSync.mock.calls.length;

      const second = detectProvider('codex');
      expect(second?.models).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
      const probeCalls = mockExecFileSync.mock.calls.filter(
        (call) => Array.isArray(call[1]) && (call[1] as string[]).join(' ') === 'debug models',
      );
      expect(probeCalls.length).toBe(1);
      // 第二次扫描仍有 which/version/auth 开销，仅探测进程被缓存省掉
      expect(mockExecFileSync.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });

  describe('KNOWN_PROVIDERS', () => {
    test('contains expected providers (F4: kimi in, openclaw out of defaults)', () => {
      expect(KNOWN_PROVIDERS).toContain('claude');
      expect(KNOWN_PROVIDERS).toContain('kimi');
      expect(KNOWN_PROVIDERS).toContain('codex');
      expect(KNOWN_PROVIDERS).toContain('opencode');
      expect(KNOWN_PROVIDERS).not.toContain('openclaw');
      expect(KNOWN_PROVIDERS).toHaveLength(4);
    });
  });
});
