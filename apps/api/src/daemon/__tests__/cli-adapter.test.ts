import { describe, test, expect } from 'vitest';
import { buildSpawnArgs } from '../cli-adapter';
import type { AgentCliParams } from '../cli-adapter';

describe('cli-adapter', () => {
  describe('buildSpawnArgs for claude', () => {
    test('includes --print and --output-format json', () => {
      const result = buildSpawnArgs('claude', {});
      expect(result.args).toContain('--print');
      expect(result.args).toContain('--output-format');
      expect(result.args).toContain('json');
      expect(result.promptViaStdin).toBe(true);
    });

    test('adds --session-id when provided', () => {
      const result = buildSpawnArgs('claude', { sessionId: 'abc-123' });
      const idx = result.args.indexOf('--session-id');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('abc-123');
    });

    test('adds --max-turns when provided', () => {
      const result = buildSpawnArgs('claude', { maxTurns: 10 });
      const idx = result.args.indexOf('--max-turns');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('10');
    });

    test('adds --verbose for stream-json output', () => {
      const result = buildSpawnArgs('claude', { outputFormat: 'stream-json' });
      expect(result.args).toContain('--verbose');
    });

    test('uses custom command path', () => {
      const result = buildSpawnArgs('claude', {}, '/opt/claude/bin/claude');
      expect(result.command).toBe('/opt/claude/bin/claude');
    });

    test('passes extra args', () => {
      const result = buildSpawnArgs('claude', { extraArgs: ['--allowedTools', 'Read'] });
      expect(result.args).toContain('--allowedTools');
      expect(result.args).toContain('Read');
    });
  });

  describe('buildSpawnArgs for codex', () => {
    test('adds --model when provided', () => {
      const result = buildSpawnArgs('codex', { model: 'gpt-4' });
      const idx = result.args.indexOf('--model');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('gpt-4');
    });

    test('adds --session when provided', () => {
      const result = buildSpawnArgs('codex', { sessionId: 'sess-1' });
      const idx = result.args.indexOf('--session');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('sess-1');
    });

    test('adds --max-steps for maxTurns', () => {
      const result = buildSpawnArgs('codex', { maxTurns: 5 });
      const idx = result.args.indexOf('--max-steps');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('5');
    });

    test('uses prompt as positional arg when provided', () => {
      const result = buildSpawnArgs('codex', { prompt: 'do something' });
      expect(result.promptViaStdin).toBe(false);
      expect(result.args).toContain('do something');
    });

    test('uses stdin when no prompt provided', () => {
      const result = buildSpawnArgs('codex', {});
      expect(result.promptViaStdin).toBe(true);
    });
  });

  describe('buildSpawnArgs for opencode', () => {
    test('starts with run subcommand', () => {
      const result = buildSpawnArgs('opencode', {});
      expect(result.args[0]).toBe('run');
    });

    test('adds --model when provided', () => {
      const result = buildSpawnArgs('opencode', { model: 'claude-3' });
      const idx = result.args.indexOf('--model');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('claude-3');
    });

    test('adds --output for outputFormat', () => {
      const result = buildSpawnArgs('opencode', { outputFormat: 'json' });
      const idx = result.args.indexOf('--output');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('json');
    });

    test('adds --max-turns when provided', () => {
      const result = buildSpawnArgs('opencode', { maxTurns: 20 });
      const idx = result.args.indexOf('--max-turns');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('20');
    });
  });

  describe('buildSpawnArgs for openclaw', () => {
    test('adds --model when provided', () => {
      const result = buildSpawnArgs('openclaw', { model: 'test-model' });
      const idx = result.args.indexOf('--model');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('test-model');
    });

    test('adds --session when provided', () => {
      const result = buildSpawnArgs('openclaw', { sessionId: 'sess-2' });
      const idx = result.args.indexOf('--session');
      expect(idx).not.toBe(-1);
      expect(result.args[idx + 1]).toBe('sess-2');
    });

    test('uses stdin for prompt', () => {
      const result = buildSpawnArgs('openclaw', {});
      expect(result.promptViaStdin).toBe(true);
    });
  });

  describe('claude with all params', () => {
    test('adds --output-format, --session-id, --max-turns', () => {
      const result = buildSpawnArgs('claude', {
        model: 'test',
        outputFormat: 'json',
        sessionId: 'sid',
        maxTurns: 3,
      });
      // claude uses ANTHROPIC_MODEL env var, not --model flag
      expect(result.args).toContain('--print');
      expect(result.args).toContain('--output-format');
      expect(result.args).toContain('--session-id');
      expect(result.args).toContain('--max-turns');
    });
  });
});
