/**
 * Stream-JSON Parser — tests
 *
 * D2: 解析 Claude CLI --output-format stream-json 输出
 */
import { describe, it, expect } from 'vitest';
import { parseStreamEvents, extractToolCalls, extractFilePath, extractResult, extractUsage, extractWriteContent } from '../stream-json-parser.js';

describe('parseStreamEvents', () => {
  it('parses multiple JSON lines', () => {
    const stdout = '{"type":"assistant","content":[{"type":"text","text":"hello"}]}\n{"type":"result","result":"ok","is_error":false}\n';
    const events = parseStreamEvents(stdout);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('assistant');
    expect(events[1].type).toBe('result');
  });

  it('skips empty lines and non-JSON', () => {
    const stdout = '\nnot json\n{"type":"result","result":"ok"}\n\n';
    const events = parseStreamEvents(stdout);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('result');
  });

  it('handles empty stdout', () => {
    expect(parseStreamEvents('')).toHaveLength(0);
  });
});

describe('extractToolCalls', () => {
  it('extracts tool_use from content array', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant',
      content: [
        { type: 'text', text: 'thinking' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/test.ts' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/test.ts', old_string: 'a', new_string: 'b' } },
      ],
    }));
    const tools = extractToolCalls(events);
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('Read');
    expect(tools[1].name).toBe('Edit');
  });

  it('extracts tool_use from message.content', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Grep', input: { pattern: 'test' } },
        ],
      },
    }));
    const tools = extractToolCalls(events);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Grep');
  });

  it('returns empty for events without tool_use', () => {
    const events = parseStreamEvents('{"type":"result","result":"ok"}');
    expect(extractToolCalls(events)).toHaveLength(0);
  });

  it('#602 D4: pairs tool_result by tool_use_id → real success (is_error 取反)', () => {
    const events = parseStreamEvents([
      '{"type":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"cmd":"pnpm test"}},{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/a.ts"}}]}',
      '{"type":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"boom"},{"type":"tool_result","tool_use_id":"t2","is_error":false,"content":"ok"}]}',
    ].join('\n'));
    const tools = extractToolCalls(events);
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ id: 't1', name: 'Bash', success: false });
    expect(tools[1]).toMatchObject({ id: 't2', name: 'Read', success: true });
  });

  it('#602 D4: tool_use without matching tool_result → success unknown (undefined，不编造)', () => {
    const events = parseStreamEvents(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9","name":"Grep","input":{"pattern":"x"}}]}}',
    );
    const tools = extractToolCalls(events);
    expect(tools[0].id).toBe('t9');
    expect(tools[0].success).toBeUndefined();
  });
});

describe('extractFilePath', () => {
  it('extracts file_path from Write tool', () => {
    expect(extractFilePath('Write', { file_path: '/tmp/test.ts' })).toBe('/tmp/test.ts');
  });

  it('extracts file_path from Edit tool', () => {
    expect(extractFilePath('Edit', { file_path: '/tmp/test.ts' })).toBe('/tmp/test.ts');
  });

  it('extracts path fallback', () => {
    expect(extractFilePath('Write', { path: '/tmp/test.ts' })).toBe('/tmp/test.ts');
  });

  it('returns null for non-Write/Edit tools', () => {
    expect(extractFilePath('Read', { file_path: '/tmp/test.ts' })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractFilePath('Write', null)).toBeNull();
  });
});

describe('extractResult', () => {
  it('extracts result text from result event', () => {
    const events = parseStreamEvents('{"type":"result","result":"final text","is_error":false}');
    expect(extractResult(events)).toEqual({ text: 'final text', isError: false });
  });

  it('detects error in result event', () => {
    const events = parseStreamEvents('{"type":"result","result":"error msg","is_error":true}');
    expect(extractResult(events)).toEqual({ text: 'error msg', isError: true });
  });

  it('extracts text from assistant content', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'part1 ' }] }),
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'part2' }] }),
      JSON.stringify({ type: 'result', result: '', is_error: false }),
    ].join('\n');
    const events = parseStreamEvents(stdout);
    expect(extractResult(events).text).toBe('part1 part2');
  });

  it('returns empty for no events', () => {
    expect(extractResult([])).toEqual({ text: '', isError: false });
  });
});

describe('extractResult — 子 agent 事件不参与父 run 完成判定 (#564)', () => {
  it('子 agent 的 error result 不误杀父 run', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, content: [{ type: 'text', text: 'parent ' }] }),
      // 父 run spawn Task 子 agent；子 agent 失败
      JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_task1', content: [{ type: 'text', text: 'child' }] }),
      JSON.stringify({ type: 'result', parent_tool_use_id: 'toolu_task1', result: 'child boom', is_error: true }),
      // 父 run 自身成功收尾
      JSON.stringify({ type: 'result', parent_tool_use_id: null, result: 'parent ok', is_error: false }),
    ].join('\n');
    const events = parseStreamEvents(stdout);
    expect(extractResult(events)).toEqual({ text: 'parent ok', isError: false });
  });

  it('子 agent 的 result 不覆盖父 run 的结果文本（子 result 在父 result 之后到达）', () => {
    const stdout = [
      JSON.stringify({ type: 'result', parent_tool_use_id: null, result: 'parent final', is_error: false }),
      JSON.stringify({ type: 'result', parent_tool_use_id: 'toolu_task1', result: 'child final', is_error: false }),
    ].join('\n');
    const events = parseStreamEvents(stdout);
    expect(extractResult(events)).toEqual({ text: 'parent final', isError: false });
  });
});

describe('extractUsage — 子 agent 事件不计入父 run 用量 (#564)', () => {
  it('子 agent 的 usage 不参与父 run 聚合（父子双计修复）', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant', parent_tool_use_id: null,
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, model: 'claude-sonnet-4-20250514' },
      }),
      JSON.stringify({
        type: 'assistant', parent_tool_use_id: 'toolu_task1',
        content: [{ type: 'text', text: 'child' }],
        usage: { input_tokens: 999, output_tokens: 888, cache_creation_input_tokens: 777 },
      }),
      JSON.stringify({
        type: 'result', parent_tool_use_id: 'toolu_task1',
        result: 'child done', is_error: false,
        usage: { input_tokens: 500, output_tokens: 400 },
      }),
      JSON.stringify({ type: 'result', parent_tool_use_id: null, result: 'done', is_error: false }),
    ].join('\n');
    const events = parseStreamEvents(stdout);
    const usage = extractUsage(events);
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(50);
    expect(usage.cacheReadTokens).toBe(10);
    expect(usage.cacheCreationTokens).toBe(0);
    expect(usage.model).toBe('claude-sonnet-4-20250514');
  });

  it('parent_tool_use_id 缺省/null 视为父 run 事件（向后兼容旧 fixture）', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', usage: { input_tokens: 10, output_tokens: 5 } }),
      JSON.stringify({ type: 'assistant', parent_tool_use_id: null, usage: { input_tokens: 20, output_tokens: 10 } }),
      JSON.stringify({ type: 'result', parent_tool_use_id: null, result: 'ok', is_error: false }),
    ].join('\n');
    const events = parseStreamEvents(stdout);
    const usage = extractUsage(events);
    expect(usage.inputTokens).toBe(30);
    expect(usage.outputTokens).toBe(15);
    expect(extractResult(events)).toEqual({ text: 'ok', isError: false });
  });
});

describe('extractUsage', () => {
  it('extracts token counts from usage fields', () => {
    const stdout = [
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 } }),
      JSON.stringify({ type: 'assistant', content: [{ type: 'text', text: 'more' }], usage: { input_tokens: 200, output_tokens: 80 } }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ].join('\n');
    const events = parseStreamEvents(stdout);
    const usage = extractUsage(events);
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(130);
    expect(usage.cacheReadTokens).toBe(20);
  });

  it('returns zeros for events without usage', () => {
    const events = parseStreamEvents('{"type":"result","result":"ok"}');
    const usage = extractUsage(events);
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBe(0);
  });

  it('extracts model from usage', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 5, model: 'claude-sonnet-4-20250514' },
    }));
    const usage = extractUsage(events);
    expect(usage.model).toBe('claude-sonnet-4-20250514');
  });

  it('returns empty for no events', () => {
    const usage = extractUsage([]);
    expect(usage.inputTokens).toBe(0);
    expect(usage.model).toBe('');
  });
});

describe('extractWriteContent', () => {
  it('extracts content from Write tool_use (message.content format)', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/tmp/output.json', content: '{"title":"test"}' },
        }],
      },
    }));
    expect(extractWriteContent(events, '/tmp/output.json')).toBe('{"title":"test"}');
  });

  it('extracts content from Write tool_use (direct content format)', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant',
      content: [{
        type: 'tool_use',
        name: 'Write',
        input: { file_path: '/tmp/output.json', content: '{"data":true}' },
      }],
    }));
    expect(extractWriteContent(events, '/tmp/output.json')).toBe('{"data":true}');
  });

  it('returns null when no Write matches target path', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant',
      content: [{
        type: 'tool_use',
        name: 'Write',
        input: { file_path: '/tmp/other.json', content: 'data' },
      }],
    }));
    expect(extractWriteContent(events, '/tmp/output.json')).toBeNull();
  });

  it('returns null when no Write events exist', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
    }));
    expect(extractWriteContent(events, '/tmp/output.json')).toBeNull();
  });

  it('returns the LAST Write content when multiple writes to same file', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/out.json', content: 'v1' } }],
      }),
      JSON.stringify({
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/out.json', content: 'v2' } }],
      }),
    ].join('\n');
    const events = parseStreamEvents(stdout);
    expect(extractWriteContent(events, '/tmp/out.json')).toBe('v2');
  });

  it('ignores non-Write tools (Edit/Read)', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant',
      content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/out.json', old_string: 'a', new_string: 'b' } }],
    }));
    expect(extractWriteContent(events, '/tmp/out.json')).toBeNull();
  });

  it('handles path normalization (relative vs absolute)', () => {
    const events = parseStreamEvents(JSON.stringify({
      type: 'assistant',
      content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/out.json', content: 'data' } }],
    }));
    // Same path, different string representation
    expect(extractWriteContent(events, '/tmp/./out.json')).toBe('data');
  });
});
