/**
 * model-probe 测试（#574 provider 动态模型发现）
 *
 * 佐证点：
 * - 三种解析器以实测输出节选（脱敏）为 fixture
 * - 进程内缓存 key = binary path + version；同 key 二次探测不重复执行（计数断言）
 * - 探测失败/超时/解析为空 → 退回静态 fallbackModels（source=fallback），失败入缓存不重试
 * - 未声明 listModels 且无 fallbackModels → undefined
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  parseModelList,
  getProviderModels,
  resetModelProbeCache,
} from '../model-probe';

const mockExecFileSync = vi.mocked(execFileSync);

/** codex 0.147.0 实测 `codex debug models` stdout 节选（脱敏，字段保留原形态） */
const CODEX_DEBUG_MODELS_SAMPLE = JSON.stringify({
  models: [
    { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list' },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'hide' },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide' },
  ],
});

/** kimi 0.38.0 实测 `kimi provider list --json` stdout 节选（脱敏） */
const KIMI_PROVIDER_LIST_SAMPLE = JSON.stringify({
  providers: {
    'managed:kimi-code': { baseUrl: 'https://example.invalid/v1', type: 'kimi' },
  },
  models: {
    'kimi-code/kimi-for-coding': { provider: 'managed:kimi-code', model: 'kimi-for-coding' },
    'kimi-code/kimi-for-coding-highspeed': { provider: 'managed:kimi-code', model: 'kimi-for-coding-highspeed' },
    'kimi-code/k3': { provider: 'managed:kimi-code', model: 'k3' },
  },
});

/** opencode 1.18.18 实测 `opencode models` stdout 节选（每行一个 provider/model） */
const OPENCODE_MODELS_SAMPLE = [
  'opencode/big-pickle',
  'opencode/hy3-free',
  'alibaba-coding-plan/glm-5',
  'openai/gpt-4o',
  '',
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  resetModelProbeCache();
});

describe('parseModelList', () => {
  test('jsonModelSlugs（codex debug models）：取 visibility=list 的 slug', () => {
    expect(parseModelList(CODEX_DEBUG_MODELS_SAMPLE, 'jsonModelSlugs')).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.5',
    ]);
  });

  test('jsonModelKeys（kimi provider list --json）：取 models 对象的键', () => {
    expect(parseModelList(KIMI_PROVIDER_LIST_SAMPLE, 'jsonModelKeys')).toEqual([
      'kimi-code/kimi-for-coding',
      'kimi-code/kimi-for-coding-highspeed',
      'kimi-code/k3',
    ]);
  });

  test('lines（opencode models）：非空行逐行一个模型', () => {
    expect(parseModelList(OPENCODE_MODELS_SAMPLE, 'lines')).toEqual([
      'opencode/big-pickle',
      'opencode/hy3-free',
      'alibaba-coding-plan/glm-5',
      'openai/gpt-4o',
    ]);
  });

  test('非法 JSON / 空输出 → 空数组（调用方按探测失败处理）', () => {
    expect(parseModelList('not json at all', 'jsonModelSlugs')).toEqual([]);
    expect(parseModelList('', 'jsonModelKeys')).toEqual([]);
    expect(parseModelList('', 'lines')).toEqual([]);
  });

  test('JSON 合法但结构不符（无 models 字段）→ 空数组', () => {
    expect(parseModelList('{"foo": 1}', 'jsonModelSlugs')).toEqual([]);
    expect(parseModelList('{"models": "not-an-object"}', 'jsonModelKeys')).toEqual([]);
  });
});

describe('getProviderModels', () => {
  function mockCli(binary: string, versionArgsHit: string, probeArgs: string[], probeOutput: string) {
    mockExecFileSync.mockImplementation(((cmd: string, args?: readonly string[]) => {
      if (cmd === 'which' && args?.[0] === binary) return `/usr/local/bin/${binary}\n`;
      if (args?.join(' ') === probeArgs.join(' ')) return probeOutput;
      throw new Error(`unexpected call: ${cmd} ${args?.join(' ')}`);
    }) as typeof execFileSync);
  }

  test('codex：探测成功 → live 模型列表', () => {
    mockCli('codex', '0.147.0', ['debug', 'models'], CODEX_DEBUG_MODELS_SAMPLE);
    const result = getProviderModels('codex', '/usr/local/bin/codex', 'codex-cli 0.147.0');
    expect(result).toEqual({
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5'],
      source: 'live',
    });
  });

  test('kimi：探测成功 → live 模型列表', () => {
    mockCli('kimi', '0.38.0', ['provider', 'list', '--json'], KIMI_PROVIDER_LIST_SAMPLE);
    const result = getProviderModels('kimi', '/usr/local/bin/kimi', '0.38.0');
    expect(result).toEqual({
      models: ['kimi-code/kimi-for-coding', 'kimi-code/kimi-for-coding-highspeed', 'kimi-code/k3'],
      source: 'live',
    });
  });

  test('opencode：探测成功 → live 模型列表', () => {
    mockCli('opencode', '1.18.18', ['models'], OPENCODE_MODELS_SAMPLE);
    const result = getProviderModels('opencode', '/usr/local/bin/opencode', '1.18.18');
    expect(result?.source).toBe('live');
    expect(result?.models).toContain('opencode/big-pickle');
  });

  test('探测失败（进程非零退出）→ 退回静态 fallbackModels', () => {
    mockExecFileSync.mockImplementation(((cmd: string) => {
      if (cmd === 'which') return '/usr/local/bin/codex\n';
      throw new Error('Command failed');
    }) as typeof execFileSync);

    const result = getProviderModels('codex', '/usr/local/bin/codex', 'codex-cli 0.147.0');
    expect(result?.source).toBe('fallback');
    expect(result?.models.length).toBeGreaterThan(0);
  });

  test('探测输出解析为空 → 退回 fallbackModels，且失败入缓存不重试', () => {
    mockCli('codex', '0.147.0', ['debug', 'models'], 'garbage output');

    const first = getProviderModels('codex', '/usr/local/bin/codex', 'codex-cli 0.147.0');
    expect(first?.source).toBe('fallback');
    const callsAfterFirst = mockExecFileSync.mock.calls.length;

    const second = getProviderModels('codex', '/usr/local/bin/codex', 'codex-cli 0.147.0');
    expect(second).toEqual(first);
    expect(mockExecFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  test('同 binary@version 二次探测命中缓存，不重复执行探测进程', () => {
    mockCli('codex', '0.147.0', ['debug', 'models'], CODEX_DEBUG_MODELS_SAMPLE);
    const first = getProviderModels('codex', '/usr/local/bin/codex', 'codex-cli 0.147.0');
    const callsAfterFirst = mockExecFileSync.mock.calls.length;

    const second = getProviderModels('codex', '/usr/local/bin/codex', 'codex-cli 0.147.0');
    expect(second).toEqual(first);
    expect(mockExecFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  test('version 变化（CLI 升级）触发重探', () => {
    mockCli('codex', '0.147.0', ['debug', 'models'], CODEX_DEBUG_MODELS_SAMPLE);
    getProviderModels('codex', '/usr/local/bin/codex', 'codex-cli 0.147.0');
    const callsAfterFirst = mockExecFileSync.mock.calls.length;

    getProviderModels('codex', '/usr/local/bin/codex', 'codex-cli 0.148.0');
    expect(mockExecFileSync.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test('claude：未声明 listModels → 恒 fallback（实测无模型列表命令）', () => {
    const result = getProviderModels('claude', '/usr/local/bin/claude', '2.1.273');
    expect(result?.source).toBe('fallback');
    expect(result?.models.length).toBeGreaterThan(0);
    // 不发起任何探测进程
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  test('未声明 listModels 且无 fallbackModels → undefined', () => {
    // openclaw（config-only legacy）未声明 listModels 也无 fallbackModels
    const result = getProviderModels('openclaw', '/usr/local/bin/openclaw', 'unknown');
    expect(result).toBeUndefined();
  });
});
