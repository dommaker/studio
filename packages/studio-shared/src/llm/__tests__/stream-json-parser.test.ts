/**
 * Stream-JSON Parser — tests
 *
 * D2: 解析 Claude CLI --output-format stream-json 输出
 */
import { describe, it, expect } from 'vitest';
import { parseStreamEvents, extractToolCalls, extractFilePath, extractResult, extractUsage } from '../stream-json-parser.js';

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
