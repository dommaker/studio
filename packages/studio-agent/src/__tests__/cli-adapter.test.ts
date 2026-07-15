import { describe, it, expect } from 'vitest';
import { buildSpawnArgs } from '../cli-adapter.js';

describe('buildSpawnArgs', () => {
  describe('claude provider', () => {
    it('returns claude command', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test' });
      expect(result.command).toBe('claude');
    });

    it('includes --print, --output-format, stream-json by default', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test' });
      expect(result.args).toContain('--print');
      expect(result.args).toContain('--output-format');
      expect(result.args).toContain('stream-json');
    });

    it('includes --session-id when sessionId is provided', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test', sessionId: 'sess-123' });
      expect(result.args).toContain('--session-id');
      expect(result.args).toContain('sess-123');
    });

    it('includes --max-turns when maxTurns is provided', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test', maxTurns: 50 });
      expect(result.args).toContain('--max-turns');
      expect(result.args).toContain('50');
    });

    it('omits --session-id when sessionId is undefined', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test' });
      expect(result.args).not.toContain('--session-id');
    });

    it('omits --max-turns when maxTurns is undefined', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test' });
      expect(result.args).not.toContain('--max-turns');
    });
  });

  describe('codex provider', () => {
    it('returns codex command', () => {
      const result = buildSpawnArgs('codex', { worktreeDir: '/tmp/test' });
      expect(result.command).toBe('codex');
    });

    it('uses --session flag for sessionId', () => {
      const result = buildSpawnArgs('codex', { worktreeDir: '/tmp/test', sessionId: 'sess-123' });
      expect(result.args).toContain('--session');
      expect(result.args).toContain('sess-123');
    });

    it('includes --print and --output-format by default', () => {
      const result = buildSpawnArgs('codex', { worktreeDir: '/tmp/test' });
      expect(result.args).toContain('--print');
      expect(result.args).toContain('--output-format');
    });
  });

  describe('openclaw provider', () => {
    it('returns openclaw command', () => {
      const result = buildSpawnArgs('openclaw', { worktreeDir: '/tmp/test' });
      expect(result.command).toBe('openclaw');
    });

    it('uses --session flag for sessionId', () => {
      const result = buildSpawnArgs('openclaw', { worktreeDir: '/tmp/test', sessionId: 'sess-123' });
      expect(result.args).toContain('--session');
      expect(result.args).toContain('sess-123');
    });
  });

  describe('opencode provider', () => {
    it('returns opencode command', () => {
      const result = buildSpawnArgs('opencode', { worktreeDir: '/tmp/test' });
      expect(result.command).toBe('opencode');
    });

    it('does not include session flags (session via file context)', () => {
      const result = buildSpawnArgs('opencode', { worktreeDir: '/tmp/test', sessionId: 'sess-123' });
      expect(result.args).not.toContain('--session');
      expect(result.args).not.toContain('--session-id');
    });

    it('includes --print and --output-format by default', () => {
      const result = buildSpawnArgs('opencode', { worktreeDir: '/tmp/test' });
      expect(result.args).toContain('--print');
      expect(result.args).toContain('--output-format');
    });
  });
});
