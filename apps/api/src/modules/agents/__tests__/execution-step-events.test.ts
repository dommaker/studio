/**
 * execution-step-events 单测（WU 过程可视化：执行步事件提炼 + 发布）
 *
 * 覆盖：
 *  - summarizeToolInput：Read/Edit/Write→file_path、Bash→command、Glob/Grep→pattern、未知工具→JSON 截断
 *  - extractThinking：thinking 块提取（content / message.content 两种载体、text 兜底、条数/长度上限）
 *  - buildExecutionStepEvent：stream-json 全量解析（thinking/toolCalls/text/usage/skills）、
 *    空内容 → null（不产空信号）、截断纪律
 *  - emitExecutionStepEvent：落盘 studio-events（STUDIO_EVENTS_FILE 隔离）+ 永不抛出
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  summarizeToolInput,
  extractThinking,
  buildExecutionStepEvent,
  emitExecutionStepEvent,
  EXECUTION_STEP_EVENT_TYPE,
} from '../execution-step-events.js';

/** 造一段 claude stream-json stdout（assistant 事件 + result 事件） */
function streamJson(lines: Array<Record<string, unknown>>): string {
  return lines.map(l => JSON.stringify(l)).join('\n');
}

const ASSISTANT = (content: Array<Record<string, unknown>>, usage?: Record<string, unknown>) => ({
  type: 'assistant',
  message: { content },
  ...(usage ? { usage } : {}),
});

let tmpDir: string;
let eventsFile: string;
const prevEnv = process.env.STUDIO_EVENTS_FILE;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-step-events-'));
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  process.env.STUDIO_EVENTS_FILE = eventsFile;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.STUDIO_EVENTS_FILE;
  else process.env.STUDIO_EVENTS_FILE = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('summarizeToolInput', () => {
  it('Read/Edit/Write → file_path；Bash → command；Glob/Grep → pattern', () => {
    expect(summarizeToolInput('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts');
    expect(summarizeToolInput('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('/a/b.ts');
    expect(summarizeToolInput('Write', { file_path: '/a/b.ts', content: 'x'.repeat(1000) })).toBe('/a/b.ts');
    expect(summarizeToolInput('Bash', { command: 'git status' })).toBe('git status');
    expect(summarizeToolInput('Grep', { pattern: 'foo', path: '/a' })).toBe('foo');
    expect(summarizeToolInput('Task', { description: '探索代码库', prompt: 'y'.repeat(500) })).toBe('探索代码库');
  });

  it('多行/长输入压成单行并截断；未知工具 JSON 截断；无输入 → 空串', () => {
    const long = summarizeToolInput('Bash', { command: `a\nb\t${'c'.repeat(500)}` });
    expect(long.includes('\n')).toBe(false);
    expect(long.length).toBeLessThanOrEqual(161); // 160 + …
    const unknown = summarizeToolInput('CustomTool', { foo: 'bar' });
    expect(unknown).toContain('foo');
    expect(summarizeToolInput('Read', null)).toBe('');
  });
});

describe('extractThinking', () => {
  it('提取 thinking 块（message.content 载体），忽略 text/tool_use', () => {
    const events = [
      ASSISTANT([
        { type: 'thinking', thinking: '先看一下现有实现' },
        { type: 'text', text: '我来读取文件' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/a' } },
      ]),
    ];
    // parseStreamEvents 的 StreamEvent 结构兼容 message.content —— 直接传对象形态
    const thinking = extractThinking(events as any);
    expect(thinking).toEqual(['先看一下现有实现']);
  });

  it('thinking 缺省时 text 兜底；条数上限 3、单条 500 字符截断', () => {
    const events = [
      ASSISTANT([
        { type: 'thinking', text: '兜底文本' },
        { type: 'thinking', thinking: 't2' },
        { type: 'thinking', thinking: 't3' },
        { type: 'thinking', thinking: 't4-应被条数上限丢弃' },
      ]),
    ];
    const thinking = extractThinking(events as any);
    expect(thinking).toEqual(['兜底文本', 't2', 't3']);

    const longThinking = extractThinking([ASSISTANT([{ type: 'thinking', thinking: 'x'.repeat(800) }])] as any);
    expect(longThinking[0].length).toBeLessThanOrEqual(501);
  });
});

describe('buildExecutionStepEvent', () => {
  it('从 stream-json 提炼 thinking/toolCalls/text/usage + skills 透传', () => {
    const raw = streamJson([
      { type: 'system', subtype: 'init' },
      ASSISTANT(
        [
          { type: 'thinking', thinking: '需要先看 workunit 服务' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/root/x/workunit.service.ts' } },
        ],
        { input_tokens: 1200, output_tokens: 300, model: 'claude-x' },
      ),
      ASSISTANT([{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }]),
      { type: 'result', result: 'ACTION: COMPLETE: 完成', usage: { input_tokens: 10, output_tokens: 5 } },
      '这不是 JSON 行，应被跳过',
    ]);

    const payload = buildExecutionStepEvent({
      workUnitId: 'wu-1',
      executionId: 'exec-1',
      sessionId: 'sess-1',
      step: 2,
      action: 'complete',
      rawOutput: raw,
      skills: ['tdd-implement', 'code-review'],
    });

    expect(payload).not.toBeNull();
    expect(payload!.workUnitId).toBe('wu-1');
    expect(payload!.step).toBe(2);
    expect(payload!.thinking).toEqual(['需要先看 workunit 服务']);
    expect(payload!.toolCalls).toEqual([
      { tool: 'Read', summary: '/root/x/workunit.service.ts' },
      { tool: 'Bash', summary: 'pnpm test' },
    ]);
    expect(payload!.skills).toEqual(['tdd-implement', 'code-review']);
    expect(payload!.usage).toEqual({ inputTokens: 1210, outputTokens: 305, model: 'claude-x' });
    expect(payload!.text).toContain('ACTION: COMPLETE');
  });

  it('空/不可解析输出且无其他信号 → null（不产空事件）', () => {
    expect(buildExecutionStepEvent({ workUnitId: 'w', executionId: 'e', step: 1, rawOutput: '' })).toBeNull();
    expect(buildExecutionStepEvent({ workUnitId: 'w', executionId: 'e', step: 1, rawOutput: null })).toBeNull();
    expect(buildExecutionStepEvent({ workUnitId: 'w', executionId: 'e', step: 1, rawOutput: 'garbage\nnot json' })).toBeNull();
  });

  it('toolCalls 超 30 条截断到 30', () => {
    const calls = Array.from({ length: 40 }, (_, i) => ({ type: 'tool_use', name: 'Read', input: { file_path: `/f${i}` } }));
    const payload = buildExecutionStepEvent({
      workUnitId: 'w', executionId: 'e', step: 1,
      rawOutput: streamJson([ASSISTANT(calls)]),
    });
    expect(payload!.toolCalls.length).toBe(30);
    expect(payload!.toolCalls[29].summary).toBe('/f29');
  });
});

describe('emitExecutionStepEvent', () => {
  it('落盘 workunit:execution_step 事件（REST 回放数据源），返回 true', async () => {
    const ok = await emitExecutionStepEvent({
      workUnitId: 'wu-9',
      executionId: 'exec-9',
      step: 1,
      rawOutput: streamJson([ASSISTANT([{ type: 'thinking', thinking: '想' }])]),
      skills: [],
    });
    expect(ok).toBe(true);

    const lines = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const event = JSON.parse(lines[0]);
    expect(event.type).toBe(EXECUTION_STEP_EVENT_TYPE);
    const payload = JSON.parse(event.payload);
    expect(payload.workUnitId).toBe('wu-9');
    expect(payload.thinking).toEqual(['想']);
  });

  it('null 内容 → false 且不落盘；异常输入不抛出', async () => {
    const ok = await emitExecutionStepEvent({ workUnitId: 'w', executionId: 'e', step: 1, rawOutput: '' });
    expect(ok).toBe(false);
    expect(fs.existsSync(eventsFile)).toBe(false);
  });
});
