/**
 * sanitizeJson + parse chain tests
 *
 * Verifies that common LLM JSON output issues are handled gracefully.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──
vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  modelGateway: { isAvailable: vi.fn(() => false), promptJson: vi.fn() },
}));

vi.mock('../../../daemon/studio-daemon.js', () => ({
  daemon: { submitAdhocJob: vi.fn() },
}));

vi.mock('../analyst-knowledge.js', () => ({
  ensureWorktree: vi.fn(),
}));

vi.mock('../../../daemon/metrics.js', () => ({
  parseClaudeUsage: vi.fn(() => ({ inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 })),
}));

import { sanitizeJson } from '../analyst-executor.js';

describe('sanitizeJson', () => {
  it('strips BOM', () => {
    const input = '\uFEFF{"key": "value"}';
    const result = sanitizeJson(input);
    expect(JSON.parse(result)).toEqual({ key: 'value' });
  });

  it('strips markdown code fences', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = sanitizeJson(input);
    expect(JSON.parse(result)).toEqual({ key: 'value' });
  });

  it('fixes invalid escape sequences (\\: \\. \\*)', () => {
    const input = '{"desc": "foo\\:bar\\.baz\\*qux"}';
    const result = sanitizeJson(input);
    expect(JSON.parse(result)).toEqual({ desc: 'foo:bar.baz*qux' });
  });

  it('removes control characters', () => {
    const input = '{"key": "val\x01ue"}';
    const result = sanitizeJson(input);
    expect(JSON.parse(result)).toEqual({ key: 'value' });
  });

  it('fixes trailing commas before } and ]', () => {
    const input = '{"a": 1, "b": [1, 2,],}';
    const result = sanitizeJson(input);
    expect(JSON.parse(result)).toEqual({ a: 1, b: [1, 2] });
  });

  it('preserves valid JSON unchanged', () => {
    const input = '{"requirement": {"title": "test", "acGroups": []}}';
    const result = sanitizeJson(input);
    expect(JSON.parse(result)).toEqual(JSON.parse(input));
  });

  it('handles combined issues (fences + escapes + trailing comma)', () => {
    const input = '```json\n{"desc": "a\\:b", "items": [1, 2,],}\n```';
    const result = sanitizeJson(input);
    expect(JSON.parse(result)).toEqual({ desc: 'a:b', items: [1, 2] });
  });

  it('preserves valid escape sequences (\\n \\t \\\" \\\\)', () => {
    const input = '{"text": "line1\\nline2\\ttab", "path": "C:\\\\dir", "quote": "he said \\"hi\\""}';
    const result = sanitizeJson(input);
    const parsed = JSON.parse(result);
    expect(parsed.text).toBe('line1\nline2\ttab');
    expect(parsed.path).toBe('C:\\dir');
    expect(parsed.quote).toBe('he said "hi"');
  });
});
