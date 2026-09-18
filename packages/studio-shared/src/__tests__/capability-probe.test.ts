/**
 * capability-probe 测试（#565 阶段 1）
 *
 * AC1/AC2 佐证：
 * - 缓存 key = binary path + version；同 key 二次探测不重复执行（计数断言）
 * - 探测失败 fail-open：返回 undefined（调用方保持全量传参），失败同样入缓存
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  parseHelpFlags,
  warmCapabilityProbe,
  getSupportedFlags,
  resetCapabilityProbeCache,
} from '../capability-probe';

const mockExecFileSync = vi.mocked(execFileSync);

/** 模拟 codex exec --help 输出形态（0.147.0 实测节选，脱敏） */
const CODEX_HELP_SAMPLE = `
Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Options:
  -c, --config <key=value>
      Override a configuration value
  -m, --model <MODEL>
      Model the agent should use
  -s, --sandbox <SANDBOX_MODE>
      Select the sandbox policy
      --dangerously-bypass-approvals-and-sandbox
  -i, --image <FILE>...
`;

const CODEX_HELP_WITH_HOOK_TRUST = `${CODEX_HELP_SAMPLE}
      --dangerously-bypass-hook-trust
      --json
`;

beforeEach(() => {
  vi.clearAllMocks();
  resetCapabilityProbeCache();
});

describe('parseHelpFlags', () => {
  test('从 help 输出提取去重后的 flag 集合', () => {
    const flags = parseHelpFlags(CODEX_HELP_WITH_HOOK_TRUST);
    expect(flags.has('--json')).toBe(true);
    expect(flags.has('--model')).toBe(true);
    expect(flags.has('--dangerously-bypass-hook-trust')).toBe(true);
    expect(flags.has('--dangerously-bypass-approvals-and-sandbox')).toBe(true);
  });

  test('重复出现的 flag 去重', () => {
    const flags = parseHelpFlags('--json foo --json bar --model');
    expect(flags.size).toBe(2);
  });

  test('空输出产出空集合', () => {
    expect(parseHelpFlags('').size).toBe(0);
  });
});

describe('warmCapabilityProbe / getSupportedFlags', () => {
  function mockCodexCli(helpOutput: string) {
    mockExecFileSync.mockImplementation(((cmd: string, args?: readonly string[]) => {
      if (cmd === 'which' && args?.[0] === 'codex') return '/usr/local/bin/codex\n';
      if ((cmd === 'codex' || cmd === '/usr/local/bin/codex') && args?.includes('--version')) return 'codex-cli 0.147.0\n';
      if (cmd === '/usr/local/bin/codex' && args?.join(' ') === 'exec --help') return helpOutput;
      throw new Error(`unexpected call: ${cmd} ${args?.join(' ')}`);
    }) as typeof execFileSync);
  }

  test('codex 声明了 capabilityProbe，探测返回 help 中的 flag 集合', () => {
    mockCodexCli(CODEX_HELP_WITH_HOOK_TRUST);
    const flags = getSupportedFlags('codex');
    expect(flags).toBeDefined();
    expect(flags!.has('--dangerously-bypass-hook-trust')).toBe(true);
    expect(flags!.has('--json')).toBe(true);
  });

  test('help 输出不含 hook-trust flag 时集合中也不含（版本差异场景）', () => {
    mockCodexCli(CODEX_HELP_SAMPLE);
    const flags = getSupportedFlags('codex');
    expect(flags).toBeDefined();
    expect(flags!.has('--dangerously-bypass-hook-trust')).toBe(false);
  });

  test('未声明 capabilityProbe 的 provider 返回 undefined（不过滤）', () => {
    const flags = getSupportedFlags('claude');
    expect(flags).toBeUndefined();
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  test('AC2: 同 binary path + version 二次探测不重复执行', () => {
    mockCodexCli(CODEX_HELP_WITH_HOOK_TRUST);
    const first = getSupportedFlags('codex');
    const callsAfterFirst = mockExecFileSync.mock.calls.length;
    const second = getSupportedFlags('codex');
    expect(second).toBe(first);
    expect(mockExecFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  test('version 变化（CLI 升级）触发重探', () => {
    mockCodexCli(CODEX_HELP_WITH_HOOK_TRUST);
    getSupportedFlags('codex');
    const callsAfterFirst = mockExecFileSync.mock.calls.length;

    // 同 path、不同 version → warm 用新 key 重探
    warmCapabilityProbe('codex', '/usr/local/bin/codex', 'codex-cli 0.148.0');
    expect(mockExecFileSync.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test('warm 后 getSupportedFlags 命中缓存，不再跑 exec --help', () => {
    mockCodexCli(CODEX_HELP_WITH_HOOK_TRUST);
    warmCapabilityProbe('codex', '/usr/local/bin/codex', 'codex-cli 0.147.0');
    // 只清计数，保留 mock 实现
    vi.clearAllMocks();
    const flags = getSupportedFlags('codex');
    expect(flags).toBeDefined();
    expect(flags!.has('--json')).toBe(true);
    const helpCalls = mockExecFileSync.mock.calls.filter(
      c => Array.isArray(c[1]) && (c[1] as string[]).join(' ') === 'exec --help',
    );
    expect(helpCalls.length).toBe(0);
  });

  test('AC2: 探测失败 fail-open — 返回 undefined 且失败入缓存不重试', () => {
    mockExecFileSync.mockImplementation(((cmd: string, args?: readonly string[]) => {
      if (cmd === 'which' && args?.[0] === 'codex') return '/usr/local/bin/codex\n';
      if (cmd === 'codex' && args?.includes('--version')) return 'codex-cli 0.147.0\n';
      throw new Error('help crashed');
    }) as typeof execFileSync);

    expect(getSupportedFlags('codex')).toBeUndefined();
    const callsAfterFirst = mockExecFileSync.mock.calls.length;
    expect(getSupportedFlags('codex')).toBeUndefined();
    expect(mockExecFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  test('help 输出解析为空（异常输出）按失败处理 fail-open', () => {
    mockCodexCli('no flags here at all');
    expect(getSupportedFlags('codex')).toBeUndefined();
  });

  test('CLI 不存在（which 失败）返回 undefined', () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(getSupportedFlags('codex')).toBeUndefined();
  });
});
