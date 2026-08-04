/**
 * Behavioral tests for AgentExecutor stream-json migration (D4)
 *
 * AC:
 * - CLI uses --output-format stream-json --verbose
 * - stdout parsed via parseStreamEvents + extractResult
 * - tool:call events emitted for each tool_use
 * - file:change events emitted for Write/Edit tools
 * - Error results handled correctly
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock all heavy dependencies (vi.hoisted ensures availability before vi.mock hoisting)
const { mockExecSh } = vi.hoisted(() => ({
  mockExecSh: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('@dommaker/studio-shared/node', () => ({
  execSh: mockExecSh,
  resolveSessionId: vi.fn(() => 'resolved-session-id'),
  readSessionIdFile: vi.fn(() => null),
}));

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { loadAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../worktree-resolver.js', () => ({
  createWorktree: vi.fn().mockResolvedValue('/tmp/test-worktree'),
  resolveWorkspace: vi.fn().mockResolvedValue({ worktree: '/tmp/test-worktree', isNew: false }),
  propagateHarnessConfig: vi.fn(),
  buildCachePrefix: vi.fn().mockResolvedValue(''),
  writeRequirementsMd: vi.fn(),
  writeContractTests: vi.fn(),
  ensureDeps: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../output-capture.js', () => ({
  readProgress: vi.fn().mockReturnValue({ allComplete: true, testResults: { failed: 0 }, sessionCount: 1 }),
  collectOutputFiles: vi.fn().mockResolvedValue([]),
  recordSessionMetrics: vi.fn(),
  emitSessionStart: vi.fn(),
  emitSessionEnd: vi.fn(),
  recordExecutionError: vi.fn(),
  getConstraintMeta: vi.fn().mockResolvedValue({ hash: 'abc', size: 100 }),
}));

vi.mock('@dommaker/studio-shared/harness/hooks', () => ({
  beforeAgentExecute: vi.fn().mockResolvedValue({ prompt: 'enhanced prompt', blocked: false }),
  buildAgentConstraintPrompt: vi.fn().mockResolvedValue('constraint prompt'),
}));

import { AgentExecutor } from '../session-manager.js';

// Build a minimal stream-json stdout
function buildStreamStdout(opts?: { toolCalls?: Array<{ name: string; input: unknown }>; resultText?: string; isError?: boolean }): string {
  const lines: string[] = [];
  // System init event
  lines.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-123' }));
  // Assistant message with tool_use blocks
  if (opts?.toolCalls?.length) {
    lines.push(JSON.stringify({
      type: 'assistant',
      content: opts.toolCalls.map(tc => ({ type: 'tool_use', name: tc.name, input: tc.input })),
    }));
  }
  // Result event
  lines.push(JSON.stringify({
    type: 'result',
    result: opts?.resultText || 'Task completed successfully',
    is_error: opts?.isError || false,
    usage: { input_tokens: 100, output_tokens: 50 },
  }));
  return lines.join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecSh.mockResolvedValue({ stdout: buildStreamStdout() });
});

describe('AgentExecutor stream-json migration', () => {
  test('uses stream-json output via the provider registry in CLI command', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../session-manager.ts', import.meta.url).pathname, 'utf-8'
    );

    // F4: `--output-format stream-json` moved from a hardcoded literal into the shared
    // provider registry (claude def); session-manager resolves binary + args via
    // buildSpawnArgs(provider). --verbose stays as the claude fallback literal.
    expect(src).toContain('buildSpawnArgs(provider');
    expect(src).toContain('--verbose');
    // Should NOT contain old format in code (comments OK)
    const codeLines = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const codeBlock = codeLines.join('\n');
    expect(codeBlock).not.toContain("'--output-format json'");
  });

  test('parseStreamEvents extracts tool calls from stream-json stdout', async () => {
    const { parseStreamEvents, extractToolCalls } = await import('@dommaker/studio-shared');
    const stdout = buildStreamStdout({
      toolCalls: [
        { name: 'Read', input: { file_path: '/src/foo.ts' } },
        { name: 'Edit', input: { file_path: '/src/bar.ts', old_string: 'a', new_string: 'b' } },
      ],
    });

    const events = parseStreamEvents(stdout);
    const tools = extractToolCalls(events);

    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ name: 'Read', input: { file_path: '/src/foo.ts' } });
    expect(tools[1]).toEqual({ name: 'Edit', input: { file_path: '/src/bar.ts', old_string: 'a', new_string: 'b' } });
  });

  test('extractResult returns text and isError from stream events', async () => {
    const { parseStreamEvents, extractResult } = await import('@dommaker/studio-shared');
    const stdout = buildStreamStdout({ resultText: 'All tests passed', isError: false });

    const events = parseStreamEvents(stdout);
    const result = extractResult(events);

    expect(result.text).toBe('All tests passed');
    expect(result.isError).toBe(false);
  });

  test('extractResult handles error results', async () => {
    const { parseStreamEvents, extractResult } = await import('@dommaker/studio-shared');
    const stdout = buildStreamStdout({ resultText: 'Build failed', isError: true });

    const events = parseStreamEvents(stdout);
    const result = extractResult(events);

    expect(result.text).toBe('Build failed');
    expect(result.isError).toBe(true);
  });

  test('extractFilePath returns path for Write/Edit tools', async () => {
    const { extractFilePath } = await import('@dommaker/studio-shared');

    expect(extractFilePath('Write', { file_path: '/src/foo.ts' })).toBe('/src/foo.ts');
    expect(extractFilePath('Edit', { file_path: '/src/bar.ts' })).toBe('/src/bar.ts');
    expect(extractFilePath('Read', { file_path: '/src/foo.ts' })).toBeNull();
    expect(extractFilePath('Write', null)).toBeNull();
  });
});
