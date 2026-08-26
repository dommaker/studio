import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectProvider, scanAllProviders, hasDocker, KNOWN_PROVIDERS } from '../cli-scanner';

// Mock child_process（detectProvider 走 execFileSync，hasDocker 走 execSync）
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

import { execSync, execFileSync } from 'child_process';
const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

describe('cli-scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectProvider', () => {
    test('returns runtime info when CLI is found', () => {
      mockExecFileSync
        .mockReturnValueOnce('/usr/local/bin/claude\n') // which
        .mockReturnValueOnce('claude 1.2.3\n');          // --version

      const result = detectProvider('claude');
      expect(result).toEqual({
        provider: 'claude',
        path: '/usr/local/bin/claude',
        version: 'claude 1.2.3',
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
      expect(result).toEqual({
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
