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

  it('P0 修复 5: vitest 下写入 os.tmpdir()/studio-test-logs，不污染生产 ~/.studio/logs', () => {
    // 用未来日期 + 唯一 session 名，避免与真实日志/其他测试撞文件
    const log: TaskLog = {
      timestamp: '2099-01-01T10:00:00.000Z',
      session: 'iso-test-session-xq9',
      sessionId: 'sess-iso',
      taskIndex: 1,
      phase: 'executor',
      command: 'test',
      durationMs: 1,
      success: true,
      inputTokens: 1,
      outputTokens: 1,
      cacheHitTokens: 0,
    };

    const isolatedFile = path.join(os.tmpdir(), 'studio-test-logs', 'tasks-2099-01-01.jsonl');
    fs.rmSync(isolatedFile, { force: true });
    try {
      writeTaskLog(log);

      // 写入落在隔离目录
      expect(fs.existsSync(isolatedFile)).toBe(true);
      const rows = fs.readFileSync(isolatedFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(rows.some(r => r.session === 'iso-test-session-xq9')).toBe(true);

      // 生产路径（若存在同名文件）不含本条测试记录
      const prodFile = path.join(os.homedir(), '.studio', 'logs', 'tasks-2099-01-01.jsonl');
      if (fs.existsSync(prodFile)) {
        expect(fs.readFileSync(prodFile, 'utf-8')).not.toContain('iso-test-session-xq9');
      }
    } finally {
      fs.rmSync(isolatedFile, { force: true });
    }
  });
});
