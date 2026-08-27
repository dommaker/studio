/**
 * runner-output 单元测试
 *
 * 覆盖 hasRecentActivity（真实 tmpdir）、queryResolutionHints（mock FileStore）
 * 与 processSessionOutput（mock output-capture，真实 stream-json 解析）。
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockListDocs, mockReadDoc, mockRecordSessionMetrics, mockEmitSessionEnd, mockEmitToolCall, mockEmitFileChange, mockGetConstraintMeta } = vi.hoisted(() => ({
  mockListDocs: vi.fn(),
  mockReadDoc: vi.fn(),
  mockRecordSessionMetrics: vi.fn(),
  mockEmitSessionEnd: vi.fn(),
  mockEmitToolCall: vi.fn(),
  mockEmitFileChange: vi.fn(),
  mockGetConstraintMeta: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: class {
      listDocs = mockListDocs;
      readDoc = mockReadDoc;
    },
  };
});

vi.mock('../output-capture.js', () => ({
  recordSessionMetrics: mockRecordSessionMetrics,
  emitSessionEnd: mockEmitSessionEnd,
  emitToolCall: mockEmitToolCall,
  emitFileChange: mockEmitFileChange,
  getConstraintMeta: mockGetConstraintMeta,
}));

import { hasRecentActivity, queryResolutionHints, processSessionOutput } from '../runner-output.js';

describe('hasRecentActivity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-output-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('空目录 → false', () => {
    expect(hasRecentActivity(tmpDir)).toBe(false);
  });

  test('阈值内有文件改动 → true', () => {
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export {}');
    expect(hasRecentActivity(tmpDir)).toBe(true);
  });

  test('文件 mtime 超出阈值 → false', () => {
    const filePath = path.join(tmpDir, 'old.ts');
    fs.writeFileSync(filePath, 'old');
    const oldTime = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(filePath, oldTime, oldTime);
    expect(hasRecentActivity(tmpDir, 3 * 60 * 1000)).toBe(false);
  });

  test('.progress.json / .agent.log / node_modules 不计入', () => {
    fs.writeFileSync(path.join(tmpDir, '.progress.json'), '{}');
    fs.writeFileSync(path.join(tmpDir, '.agent.log'), 'log');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'x');
    expect(hasRecentActivity(tmpDir)).toBe(false);
  });

  test('目录不存在 → false', () => {
    expect(hasRecentActivity('/nonexistent/path/xyz')).toBe(false);
  });
});

describe('queryResolutionHints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListDocs.mockResolvedValue(['resolution-abc', 'note-x']);
    mockReadDoc.mockImplementation(async (_dir: string, key: string) => {
      if (key !== 'resolution-abc') return null;
      return {
        meta: { maturity: 'verified', pattern: 'boom error', title: 'Boom', verifyCount: 3 },
        body: '# Boom\n## Solution\napply the fix',
      };
    });
  });

  test('错误信息命中 resolution 模式 → 返回 hint 文本', async () => {
    const hint = await queryResolutionHints('a BOOM ERROR happened');
    expect(hint).toContain('已知解法 (RKB)');
    expect(hint).toContain('- **Boom**: apply the fix');
  });

  test('无匹配 → 返回空串', async () => {
    expect(await queryResolutionHints('some unrelated failure')).toBe('');
  });

  test('非 verified/canonical 文档被过滤', async () => {
    mockReadDoc.mockResolvedValue({
      meta: { maturity: 'draft', pattern: 'boom error', title: 'Boom', verifyCount: 0 },
      body: '# Boom\nfix',
    });
    expect(await queryResolutionHints('a boom error happened')).toBe('');
  });

  test('查询失败（listDocs 抛错）→ 返回空串', async () => {
    mockListDocs.mockRejectedValue(new Error('fs error'));
    expect(await queryResolutionHints('a boom error happened')).toBe('');
  });
});

describe('processSessionOutput', () => {
  let tmpDir: string;
  let logFile: string;

  const baseCtx = () => ({
    logFile,
    sessionId: 'sess-1',
    executionId: 'exec-1',
    sessionCount: 2,
    isFirstSession: false,
    sessionMs: 1234,
    agentRole: 'executor',
    stage: 'dev',
    promptSize: 42,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConstraintMeta.mockResolvedValue({ hash: 'abc', size: 100 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-output-pso-'));
    logFile = path.join(tmpDir, '.agent.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('落盘 .agent.log，解析 result/usage 并返回解析结果', async () => {
    const stdout = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      'not-json line',
      JSON.stringify({ type: 'result', result: 'all done', is_error: false, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, model: 'claude-x' } }),
    ].join('\n');

    const out = await processSessionOutput(stdout, baseCtx());

    expect(fs.readFileSync(logFile, 'utf-8')).toBe(stdout);
    expect(out.text).toBe('all done');
    expect(out.isError).toBe(false);
    expect(out.streamUsage).toEqual({
      inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1, model: 'claude-x',
    });
    expect(out.events).toHaveLength(2);
  });

  test('tool_use 事件 → emitToolCall；Write/Edit 另发 emitFileChange', async () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', content: [
        { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/a.ts', content: 'x' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ] }),
      JSON.stringify({ type: 'result', result: 'ok', is_error: false }),
    ].join('\n');

    await processSessionOutput(stdout, baseCtx());

    expect(mockEmitToolCall).toHaveBeenCalledTimes(2);
    expect(mockEmitToolCall).toHaveBeenCalledWith('Write', { file_path: '/tmp/a.ts', content: 'x' }, 'sess-1', 'exec-1');
    expect(mockEmitToolCall).toHaveBeenCalledWith('Bash', { command: 'ls' }, 'sess-1', 'exec-1');
    expect(mockEmitFileChange).toHaveBeenCalledTimes(1);
    expect(mockEmitFileChange).toHaveBeenCalledWith('/tmp/a.ts', 'sess-1', 'exec-1');
  });

  test('recordSessionMetrics 收到 ctx 字段 + 约束 meta + streamUsage；emitSessionEnd 带 sessionCount', async () => {
    const stdout = JSON.stringify({ type: 'result', result: 'ok', is_error: false, usage: { input_tokens: 7, output_tokens: 3 } });

    await processSessionOutput(stdout, baseCtx());

    expect(mockRecordSessionMetrics).toHaveBeenCalledTimes(1);
    expect(mockRecordSessionMetrics).toHaveBeenCalledWith({
      stdout,
      executionId: 'exec-1',
      agentRole: 'executor',
      stage: 'dev',
      sessionCount: 2,
      isFirstSession: false,
      sessionMs: 1234,
      promptSize: 42,
      constraintHash: 'abc',
      constraintSize: 100,
      streamUsage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, model: '' },
    });
    expect(mockEmitSessionEnd).toHaveBeenCalledTimes(1);
    // #361: sessionExtras 未传时为 undefined（payload 形态与 start 保持单一）
    expect(mockEmitSessionEnd).toHaveBeenCalledWith('sess-1', 'exec-1', 2, undefined);
  });

  test('#361: ctx.sessionExtras 透传给 session:end（修 end/start 双 payload 形态）', async () => {
    const stdout = JSON.stringify({ type: 'result', result: 'ok', is_error: false });
    const sessionExtras = { workUnitId: 'wu-9', transcriptPath: '/t/wu-9.jsonl' };

    await processSessionOutput(stdout, { ...baseCtx(), sessionExtras });

    expect(mockEmitSessionEnd).toHaveBeenCalledWith('sess-1', 'exec-1', 2, sessionExtras);
  });

  test('is_error result → isError 为 true，事件/指标仍照常落盘', async () => {
    const stdout = JSON.stringify({ type: 'result', result: 'boom', is_error: true });

    const out = await processSessionOutput(stdout, baseCtx());

    expect(out.isError).toBe(true);
    expect(out.text).toBe('boom');
    expect(mockRecordSessionMetrics).toHaveBeenCalledTimes(1);
    expect(mockEmitSessionEnd).toHaveBeenCalledTimes(1);
  });

  test('无 usage 事件 → streamUsage 各项为 0', async () => {
    const stdout = JSON.stringify({ type: 'result', result: 'ok', is_error: false });

    const out = await processSessionOutput(stdout, baseCtx());

    expect(out.streamUsage).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: '',
    });
  });
});
