/**
 * update-user-model 命令测试（随 ADR-0019 自 harness 迁移；
 * 原 O1：--days flag + --json/--dry-run 兼容）
 *
 * Seam：updateUserModel(options) 公开入口。
 * 隔离面：
 *   - os.homedir → 测试临时目录（vi.hoisted + require 补丁 module.exports；
 *     vi.mock('os') 对本仓 vitest 4 内建模块不生效，见 auditor-agent.test.ts 头注）
 *   - readTranscriptSessions → fixture 会话（extractCorrectionMatches 等纯函数保持真实）
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { captureIO, lastJsonOutput, type CapturingIO } from '../command-contract.js';
import { updateUserModel, resolveUserModelPaths } from '../update-user-model.js';
import { readTranscriptSessions, type MinedSession } from '../session-mining/index.js';

const { TEST_HOME, origHomedir } = vi.hoisted(() => {
  const os = require('node:os');
  const path = require('node:path');
  const fs = require('node:fs');
  const orig = os.homedir;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-uum-test-home-'));
  os.homedir = () => tmp;
  return { TEST_HOME: tmp, origHomedir: orig };
});

vi.mock('../session-mining/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readTranscriptSessions: vi.fn(),
}));

const mockReadTranscriptSessions = readTranscriptSessions as vi.Mock;

const STATE_FILE = path.join(TEST_HOME, '.claude', 'user-model-state.json');
const PROFILE_FILE = path.join(TEST_HOME, '.claude', 'projects', '-root-projects', 'memory', 'user_profile.md');

function todayStr(offsetDays = 0): string {
  return new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function mkSession(partial: Partial<MinedSession> = {}): MinedSession {
  return {
    id: 'session-1',
    date: todayStr(),
    mtimeMs: Date.now(),
    turns: [
      { role: 'user', content: '数据库迁移方案需要执行' },
      { role: 'assistant', content: '好的' },
    ],
    toolCalls: ['Read'],
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

describe('update-user-model command', () => {

  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdirSync(path.join(TEST_HOME, '.claude', 'projects', '-root-projects', 'memory'), { recursive: true });
    process.env.CLAUDE_TRANSCRIPTS_DIR = path.join(TEST_HOME, 'transcripts');
  });

  afterEach(() => {
    delete process.env.CLAUDE_TRANSCRIPTS_DIR;
    delete process.env.HARNESS_UUM_STATE_FILE;
    delete process.env.HARNESS_UUM_PROFILE_FILE;
    fs.rmSync(path.join(TEST_HOME, '.claude'), { recursive: true, force: true });
    fs.rmSync(path.join(TEST_HOME, 'custom'), { recursive: true, force: true });
  });

  // 路径解析：默认值保持原行为，env 覆盖生效
  test('resolveUserModelPaths 默认：homedir 下的原路径（现行为不变）', () => {
    expect(resolveUserModelPaths({})).toEqual({
      stateFile: STATE_FILE,
      profileFile: PROFILE_FILE,
    });
  });

  test('resolveUserModelPaths env 覆盖：HARNESS_UUM_STATE_FILE / HARNESS_UUM_PROFILE_FILE', () => {
    expect(resolveUserModelPaths({
      HARNESS_UUM_STATE_FILE: '/custom/state.json',
      HARNESS_UUM_PROFILE_FILE: '/custom/profile.md',
    })).toEqual({
      stateFile: '/custom/state.json',
      profileFile: '/custom/profile.md',
    });
  });

  test('env 覆盖端到端：state 落 env 指定路径，不写默认路径', async () => {
    const customState = path.join(TEST_HOME, 'custom', 'state.json');
    process.env.HARNESS_UUM_STATE_FILE = customState;
    mockReadTranscriptSessions.mockReturnValue([mkSession({ id: 'session-a' })]);

    await updateUserModel({}, io);

    expect(fs.existsSync(customState)).toBe(true);
    expect(fs.existsSync(STATE_FILE)).toBe(false);
    const state = JSON.parse(fs.readFileSync(customState, 'utf-8'));
    expect(state.sessionsProcessed).toContain('session-a');
  });

  test('无新会话：提示 No new sessions to process', async () => {
    mockReadTranscriptSessions.mockReturnValue([]);

    await updateUserModel({}, io);

    expect(io.outText()).toContain('No new sessions to process');
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  test('--json：输出 newSessions 与 new_pattern 变化', async () => {
    mockReadTranscriptSessions.mockReturnValue([
      mkSession({ id: 'session-a' }),
      mkSession({ id: 'session-b' }),
    ]);

    await updateUserModel({ json: true, dryRun: true }, io);

    const output = lastJsonOutput(io);
    expect(output.newSessions).toBe(2);
    expect(output.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'new_pattern',
          key: '数据库迁移方案需要执行',
        }),
      ]),
    );
  });

  test('--dry-run：只展示变化，不写 state 文件', async () => {
    mockReadTranscriptSessions.mockReturnValue([mkSession({ id: 'session-a' })]);

    await updateUserModel({ dryRun: true }, io);

    expect(io.outText()).toContain('Processed 1 new sessions');
    expect(fs.existsSync(STATE_FILE)).toBe(false);
  });

  test('默认（非 dry-run）：落盘 state 并记录已处理会话', async () => {
    mockReadTranscriptSessions.mockReturnValue([mkSession({ id: 'session-a' })]);

    await updateUserModel({}, io);

    expect(fs.existsSync(STATE_FILE)).toBe(true);
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    expect(state.sessionsProcessed).toContain('session-a');
  });

  test('--days 1：since 过滤下推到 seam（自然日窗口，含今天）', async () => {
    mockReadTranscriptSessions.mockReturnValue([mkSession({ id: 'today' })]);

    await updateUserModel({ json: true, dryRun: true, days: 1 }, io);

    const output = lastJsonOutput(io);
    expect(output.newSessions).toBe(1);
    // date >= 今日 ⟺ mtimeMs >= 今日 UTC 零点，过滤在 seam 内 stat 级完成
    expect(mockReadTranscriptSessions).toHaveBeenCalledWith(
      process.env.CLAUDE_TRANSCRIPTS_DIR,
      { excludeIds: [], since: Date.parse(todayStr()) },
    );
  });

  test('缺省 --days：处理全部未处理会话（向后兼容）', async () => {
    mockReadTranscriptSessions.mockReturnValue([
      mkSession({ id: 'today' }),
      mkSession({
        id: 'three-days-ago',
        date: todayStr(3),
        turns: [
          { role: 'user', content: '旧会话概念内容测试' },
          { role: 'assistant', content: '' },
        ],
      }),
    ]);

    await updateUserModel({ json: true, dryRun: true }, io);

    const output = lastJsonOutput(io);
    expect(output.newSessions).toBe(2);
    // 缺省 days：不下推 since（向后兼容全量）
    expect(mockReadTranscriptSessions).toHaveBeenCalledWith(
      process.env.CLAUDE_TRANSCRIPTS_DIR,
      { excludeIds: [] },
    );
  });

  test('同一 concept 只计一次：occurrences 等于 merged 聚合值（双计 bug 回归）', async () => {
    mockReadTranscriptSessions.mockReturnValue([mkSession({ id: 'session-a' })]);

    await updateUserModel({}, io);

    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    // userText 整条中文序列恰为一个 concept（count=1）；聚合后只应出现一次，
    // 双计 bug 下会被 merged 循环 + per-session 循环各加一次变成 2
    expect(state.patterns['数据库迁移方案需要执行'].occurrences).toBe(1);
    expect(state.patterns['数据库迁移方案需要执行'].sessions).toEqual(['session-a']);
  });

  test('correction phrase 的 ×3 加权不受影响（buildMergedConcepts 内）', async () => {
    mockReadTranscriptSessions.mockReturnValue([
      mkSession({
        id: 'session-a',
        turns: [
          { role: 'user', content: '这种问题反复出现' },
          { role: 'assistant', content: '' },
        ],
      }),
    ]);

    await updateUserModel({}, io);

    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    // 纠正语句提取的 concept 按 ×3 计入（裁决：权重在 buildMergedConcepts，删循环不影响）
    expect(state.patterns['这种问题'].occurrences).toBe(3);
  });

  test('sessionsProcessed 去重：已处理会话经 excludeIds 下推排除', async () => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({
        lastUpdated: '',
        sessionsProcessed: ['session-a'],
        patterns: {},
        lensWeights: {},
        principleWeights: {},
        evolutionLog: [],
      }),
      'utf-8',
    );
    mockReadTranscriptSessions.mockReturnValue([mkSession({ id: 'session-b' })]);

    await updateUserModel({ json: true, dryRun: true, days: 7 }, io);

    const output = lastJsonOutput(io);
    expect(output.newSessions).toBe(1);
    expect(mockReadTranscriptSessions).toHaveBeenCalledWith(
      process.env.CLAUDE_TRANSCRIPTS_DIR,
      { excludeIds: ['session-a'], since: expect.any(Number) },
    );
  });
});
