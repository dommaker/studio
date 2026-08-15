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

  describe('sessionResume (fix/guard-and-resume)', () => {
    it('claude: resume uses --resume instead of --session-id', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test', sessionId: 'sess-123', sessionResume: true });
      expect(result.args).toContain('--resume');
      expect(result.args).toContain('sess-123');
      expect(result.args).not.toContain('--session-id');
      // baseArgs 保留（--print/--output-format/--verbose）
      expect(result.args).toContain('--print');
      expect(result.args).toContain('stream-json');
    });

    it('claude: resume keeps --max-turns', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test', sessionId: 'sess-123', sessionResume: true, maxTurns: 50 });
      expect(result.args).toContain('--resume');
      expect(result.args).toContain('--max-turns');
      expect(result.args).toContain('50');
    });

    it('claude: sessionResume without sessionId stays flag-free (新建行为不变)', () => {
      const result = buildSpawnArgs('claude', { worktreeDir: '/tmp/test', sessionResume: true });
      expect(result.args).not.toContain('--resume');
      expect(result.args).not.toContain('--session-id');
    });

    it('kimi: resume 改 --continue（cwd 维度续用，0.29.0 实测；Studio UUID 不接）', () => {
      const result = buildSpawnArgs('kimi', { worktreeDir: '/tmp/test', sessionId: '01HZX', sessionResume: true });
      expect(result.args).toEqual(['--output-format', 'stream-json', '--continue']);
    });

    it('codex: resume 改 exec resume --last（cwd 过滤最新会话；仅 --help 实证）', () => {
      const result = buildSpawnArgs('codex', { worktreeDir: '/tmp/test', sessionId: 'sess-123', sessionResume: true });
      expect(result.args).toEqual(['exec', 'resume', '--last', '--json', '--dangerously-bypass-hook-trust']);
    });

    it('opencode: resume 改 --continue（cwd 维度续用，1.18.4 实测；Studio UUID 不接）', () => {
      const result = buildSpawnArgs('opencode', { worktreeDir: '/tmp/test', sessionId: 'sess-123', sessionResume: true });
      expect(result.args).toEqual(['run', '--format', 'json', '--continue']);
    });
  });

  describe('codex provider', () => {
    it('returns codex command', () => {
      const result = buildSpawnArgs('codex', { worktreeDir: '/tmp/test' });
      expect(result.command).toBe('codex');
    });

    it('uses exec --json --dangerously-bypass-hook-trust for non-interactive runs（#147 trust 门）', () => {
      const result = buildSpawnArgs('codex', { worktreeDir: '/tmp/test' });
      expect(result.args).toEqual(['exec', '--json', '--dangerously-bypass-hook-trust']);
    });

    it('新建时丢弃 sessionId（exec resume 是续用语义，未知 id 会报错）', () => {
      const result = buildSpawnArgs('codex', { worktreeDir: '/tmp/test', sessionId: 'sess-123' });
      expect(result.args).toEqual(['exec', '--json', '--dangerously-bypass-hook-trust']);
    });
  });

  describe('kimi provider', () => {
    it('returns kimi command', () => {
      const result = buildSpawnArgs('kimi', { worktreeDir: '/tmp/test' });
      expect(result.command).toBe('kimi');
    });

    it('uses --output-format stream-json; 新建丢弃 sessionId（--session 为续用语义，0.29.0 实测未知 id 报错）', () => {
      const result = buildSpawnArgs('kimi', { worktreeDir: '/tmp/test', sessionId: '01HZX' });
      expect(result.args).toEqual(['--output-format', 'stream-json']);
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

    it('uses run --format json for non-interactive runs', () => {
      const result = buildSpawnArgs('opencode', { worktreeDir: '/tmp/test' });
      expect(result.args).toEqual(['run', '--format', 'json']);
    });

    it('新建丢弃 sessionId（--session 为续用语义，1.18.4 实测未知 id 报 Session not found）', () => {
      const result = buildSpawnArgs('opencode', { worktreeDir: '/tmp/test', sessionId: 'sess-123' });
      expect(result.args).toEqual(['run', '--format', 'json']);
    });
  });
});
