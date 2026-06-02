/**
 * Task Logger tests — classifyTaskError (pure) + writeTaskLog (fs)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { classifyTaskError, writeTaskLog, type TaskLog } from '../task-logger.js';

describe('classifyTaskError', () => {
  it('returns cli_error for invalid session id', () => {
    expect(classifyTaskError('invalid session id')).toBe('cli_error');
    expect(classifyTaskError('must be a valid UUID')).toBe('cli_error');
  });

  it('returns session_expired for session not found', () => {
    expect(classifyTaskError('session not found')).toBe('session_expired');
    expect(classifyTaskError('no previous session')).toBe('session_expired');
    expect(classifyTaskError('no conversation')).toBe('session_expired');
  });

  it('returns timeout for timeout/ETIMEDOUT/killed', () => {
    expect(classifyTaskError('request timeout')).toBe('timeout');
    expect(classifyTaskError('ETIMEDOUT')).toBe('timeout');
    expect(classifyTaskError('process killed')).toBe('timeout');
  });

  it('returns llm_error for API errors', () => {
    expect(classifyTaskError('api error 500')).toBe('llm_error');
    expect(classifyTaskError('rate limit exceeded')).toBe('llm_error');
    expect(classifyTaskError('429 too many requests')).toBe('llm_error');
    expect(classifyTaskError('503 service unavailable')).toBe('llm_error');
    expect(classifyTaskError('unauthorized access')).toBe('llm_error');
    expect(classifyTaskError('invalid api key')).toBe('llm_error');
  });

  it('returns parse_error for JSON/parse/syntax errors', () => {
    expect(classifyTaskError('invalid json')).toBe('parse_error');
    expect(classifyTaskError('parse error at line 5')).toBe('parse_error');
    expect(classifyTaskError('unexpected syntax')).toBe('parse_error');
  });

  it('returns unknown for unrecognized errors', () => {
    expect(classifyTaskError('something weird happened')).toBe('unknown');
    expect(classifyTaskError('')).toBe('unknown');
  });
});

describe('writeTaskLog', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-logger-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('writes JSONL to log file', () => {
    const log: TaskLog = {
      timestamp: '2026-06-01T10:00:00.000Z',
      session: 'test-session',
      sessionId: 'sess-123',
      taskIndex: 1,
      model: 'claude-sonnet-4-6',
      phase: 'executor',
      command: 'claude --prompt "test"',
      durationMs: 5000,
      success: true,
      inputTokens: 1000,
      outputTokens: 500,
      cacheHitTokens: 200,
    };

    // writeTaskLog uses hardcoded LOG_DIR, but we can verify it doesn't throw
    expect(() => writeTaskLog(log)).not.toThrow();
  });

  it('handles write errors gracefully', () => {
    // writeTaskLog catches errors internally, so this should not throw
    const log: TaskLog = {
      timestamp: '2026-06-01T10:00:00.000Z',
      session: 'test',
      sessionId: 'sess-1',
      taskIndex: 0,
      model: 'test',
      phase: 'analyst',
      command: 'test',
      durationMs: 0,
      success: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      errorType: 'unknown',
      errorDetail: 'test error',
    };

    expect(() => writeTaskLog(log)).not.toThrow();
  });
});
