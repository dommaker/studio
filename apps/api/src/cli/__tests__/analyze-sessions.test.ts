/**
 * analyze-sessions 命令测试（随 ADR-0019 自 harness 迁移；原 O6）
 *
 * Seam：analyzeSessions(options) 公开入口。
 * 隔离面：
 *   - os.homedir → 测试临时目录（vi.hoisted + require 补丁 module.exports；
 *     vi.mock('os') 对本仓 vitest 4 内建模块不生效，见 auditor-agent.test.ts 头注）
 *   - readTranscriptSessions → fixture 会话（extractCorrectionMatches/tokenize 等纯函数保持真实）
 *   - CLAUDE_TRANSCRIPTS_DIR → 测试临时目录（决定 transcripts 目录是否存在）
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { captureIO, lastJsonOutput, type CapturingIO } from '../command-contract.js';
import { analyzeSessions } from '../analyze-sessions.js';
import { readTranscriptSessions, type MinedSession } from '../session-mining/index.js';

const { TEST_HOME, origHomedir } = vi.hoisted(() => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const orig = os.homedir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-analyze-test-home-'));
  os.homedir = () => tmp;
  return { TEST_HOME: tmp, origHomedir: orig };
});

vi.mock('../session-mining/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readTranscriptSessions: vi.fn(),
}));

const mockReadTranscriptSessions = readTranscriptSessions as vi.Mock;

const TRANSCRIPTS_DIR = path.join(TEST_HOME, 'transcripts');

function mkSession(partial: Partial<MinedSession> = {}): MinedSession {
  return {
    id: 'session-1',
    date: '2026-08-15',
    mtimeMs: Date.now(),
    turns: [
      { role: 'user', content: '我不是说要用中文吗' },
      { role: 'assistant', content: '收到，改用中文' },
    ],
    toolCalls: [],
    ...partial,
  };
}

let io: CapturingIO;
beforeEach(() => {
  io = captureIO();
});

afterAll(() => {
  require('node:os').homedir = origHomedir;
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('analyze-sessions command', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdirSync(path.join(TEST_HOME, '.claude', 'projects', '-root-projects', 'memory'), { recursive: true });
    fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    process.env.CLAUDE_TRANSCRIPTS_DIR = TRANSCRIPTS_DIR;
  });

  afterEach(() => {
    delete process.env.CLAUDE_TRANSCRIPTS_DIR;
    fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
    fs.rmSync(TRANSCRIPTS_DIR, { recursive: true, force: true });
  });

  test('transcripts 目录不存在：提示 No transcripts directory found', async () => {
    process.env.CLAUDE_TRANSCRIPTS_DIR = path.join(TEST_HOME, 'missing-dir');

    const result = await analyzeSessions({}, io);

    expect(io.outText()).toContain('No transcripts directory found');
    expect(result).toEqual({ kind: 'skip', reason: expect.stringContaining('会话记录目录不存在') });
    expect(mockReadTranscriptSessions).not.toHaveBeenCalled();
  });

  test('窗口内无会话：提示 No sessions found（默认最近 7 天）', async () => {
    const before = Date.now() - 7 * 86_400_000;
    mockReadTranscriptSessions.mockReturnValue([]);

    const result = await analyzeSessions({}, io);
    const after = Date.now() - 7 * 86_400_000;

    expect(io.outText()).toContain('No sessions found in the last 7 days');
    expect(result).toEqual({ kind: 'skip', reason: '最近 7 天没有会话' });
    // since 过滤下推到 seam：默认窗口 7 天
    const filter = mockReadTranscriptSessions.mock.calls[0][1] as { since?: number };
    expect(filter.since).toBeGreaterThanOrEqual(before);
    expect(filter.since).toBeLessThanOrEqual(after);
  });

  test('--days 1：since 过滤下推到 seam（mtimeMs 窗口）', async () => {
    const before = Date.now() - 86_400_000;
    mockReadTranscriptSessions.mockReturnValue([mkSession({ id: 'today' })]);

    await analyzeSessions({ days: 1 }, io);
    const after = Date.now() - 86_400_000;

    expect(io.outText()).toContain('Analyzing 1 sessions (last 1 days)');
    const filter = mockReadTranscriptSessions.mock.calls[0][1] as { since?: number };
    expect(filter.since).toBeGreaterThanOrEqual(before);
    expect(filter.since).toBeLessThanOrEqual(after);
  });

  test('缺省 --days：窗口为 7 天，两天前会话仍计入', async () => {
    mockReadTranscriptSessions.mockReturnValue([
      mkSession({ id: 'today' }),
      mkSession({ id: 'two-days-ago', mtimeMs: Date.now() - 2 * 86_400_000 }),
    ]);

    await analyzeSessions({}, io);

    expect(io.outText()).toContain('Analyzing 2 sessions (last 7 days)');
  });

  test('--json：纠正句跨 3 会话聚合为 correction 候选', async () => {
    mockReadTranscriptSessions.mockReturnValue([
      mkSession({ id: 's1' }),
      mkSession({ id: 's2' }),
      mkSession({ id: 's3' }),
    ]);

    await analyzeSessions({ json: true }, io);

    const output = lastJsonOutput(io);
    expect(output.sessions).toBe(3);
    expect(output.corrections).toBe(3);
    expect(output.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'correction',
          frequency: 3,
          pattern: '我不是说',
        }),
      ]),
    );
  });

  test('--json：跨会话重复概念产出 ngram 候选', async () => {
    const ngramText = { role: 'user', content: '数据库迁移方案的详细讨论' };
    mockReadTranscriptSessions.mockReturnValue([
      mkSession({
        id: 's1',
        turns: [ngramText, { role: 'assistant', content: '好的' }],
      }),
      mkSession({
        id: 's2',
        turns: [ngramText, { role: 'assistant', content: '明白' }],
      }),
    ]);

    await analyzeSessions({ json: true }, io);

    const output = lastJsonOutput(io);
    const ngramCandidates = (output.candidates as Array<{ source: string }>)
      .filter(c => c.source === 'ngram');
    expect(ngramCandidates.length).toBeGreaterThan(0);
  });
});
