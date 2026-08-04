/**
 * Provider registry tests (F4)
 *
 * Covers: built-in definitions, ~/.studio/providers.json deep-merge
 * (tmp files — never touches the real config or installed CLIs),
 * health-probe resolution, and per-provider spawn-args.
 * The claude template must stay byte-identical to the pre-F4 adapter.
 */

import { describe, test, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BUILTIN_PROVIDERS,
  loadProviderRegistry,
  listScanProviders,
  getProviderDefinition,
  resolveProviderDefinition,
  buildHealthProbeCommand,
  buildArgsFromTemplate,
  resetProviderRegistryCache,
} from '@dommaker/studio-shared/node';

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

  /**
   * 防回归：health probe 绝不能调 LLM。
   * health probe 只检查二进制可用性（--version），不应产生任何 API 调用。
   */
  test('health probe never triggers LLM calls', () => {
    const llmTriggerPatterns = ['--print', '-p ', 'chat/completions', '"ok"', '--prompt'];
    for (const providerId of ['claude', 'kimi', 'codex', 'opencode']) {
      const cmd = buildHealthProbeCommand(providerId, '/nonexistent/providers.json');
      for (const pattern of llmTriggerPatterns) {
        expect(cmd, `${providerId} probe "${cmd}" must not contain "${pattern}"`).not.toContain(pattern);
      }
    }
  });
});

describe('buildArgsFromTemplate', () => {
  test('substitutes {outputFormat} through the provider format map', () => {
    const { args } = buildArgsFromTemplate(BUILTIN_PROVIDERS.opencode, { outputFormat: 'stream-json' });
    expect(args).toEqual(['run', '--format', 'json']);
  });

  test('ignores params the provider has no flag for', () => {
    const { args } = buildArgsFromTemplate(BUILTIN_PROVIDERS.kimi, { maxTurns: 5 });
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('5');
  });
});
