/**
 * runner-output 单元测试
 *
 * 覆盖 processSessionOutput（mock output-capture，真实 stream-json 解析）。
 * （#587：同文件的 mtime 探测与 RKB 解法查询两个 helper 随 #562 遗留死面摘除，
 *   相关用例与 FileStore mock 一并移除；RKB 匹配核心的测试在 studio-shared
 *   __tests__/resolutions.test.ts）
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockRecordSessionMetrics, mockEmitSessionEnd, mockEmitToolCall, mockEmitFileChange, mockGetConstraintMeta } = vi.hoisted(() => ({
  mockRecordSessionMetrics: vi.fn(),
  mockEmitSessionEnd: vi.fn(),
  mockEmitToolCall: vi.fn(),
  mockEmitFileChange: vi.fn(),
  mockGetConstraintMeta: vi.fn(),
}));

vi.mock('../output-capture.js', () => ({
  recordSessionMetrics: mockRecordSessionMetrics,
  emitSessionEnd: mockEmitSessionEnd,
  emitToolCall: mockEmitToolCall,
  emitFileChange: mockEmitFileChange,
  getConstraintMeta: mockGetConstraintMeta,
}));

import { processSessionOutput } from '../runner-output.js';

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
    // #602 D4：第 5 参 extras 带真实 success（无配对 tool_result → undefined 不编造）与 caller=agentRole
    expect(mockEmitToolCall).toHaveBeenCalledWith('Write', { file_path: '/tmp/a.ts', content: 'x' }, 'sess-1', 'exec-1', { success: undefined, caller: 'executor' });
    expect(mockEmitToolCall).toHaveBeenCalledWith('Bash', { command: 'ls' }, 'sess-1', 'exec-1', { success: undefined, caller: 'executor' });
    expect(mockEmitFileChange).toHaveBeenCalledTimes(1);
    expect(mockEmitFileChange).toHaveBeenCalledWith('/tmp/a.ts', 'sess-1', 'exec-1');
  });

  test('#602 D4: tool_result is_error 配对 → emitToolCall 带真实 success', async () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pnpm test' } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a.ts' } },
      ] }),
      JSON.stringify({ type: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' },
        { type: 'tool_result', tool_use_id: 't2', is_error: false, content: 'ok' },
      ] }),
    ].join('\n');

    await processSessionOutput(stdout, baseCtx());

    expect(mockEmitToolCall).toHaveBeenCalledWith('Bash', { command: 'pnpm test' }, 'sess-1', 'exec-1', { success: false, caller: 'executor' });
    expect(mockEmitToolCall).toHaveBeenCalledWith('Read', { file_path: '/a.ts' }, 'sess-1', 'exec-1', { success: true, caller: 'executor' });
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
