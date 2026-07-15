import { describe, it, expect } from 'vitest';

// ─── buildAugmentedPrompt ───

import { buildAugmentedPrompt } from '../agent-runner.js';

describe('buildAugmentedPrompt', () => {
  it('returns base prompt unchanged when knowledgeContext is empty', () => {
    const result = buildAugmentedPrompt('hello world');
    expect(result).toBe('hello world');
  });

  it('returns base prompt unchanged when knowledgeContext is undefined', () => {
    const result = buildAugmentedPrompt('hello world', undefined);
    expect(result).toBe('hello world');
  });

  it('prepends knowledgeContext to prompt with separator', () => {
    const result = buildAugmentedPrompt('write code', 'project context');
    expect(result).toBe('project context\n\n---\n\nwrite code');
  });

  it('handles empty knowledgeContext string (treated as falsy)', () => {
    const result = buildAugmentedPrompt('hello', '');
    expect(result).toBe('hello');
  });

  it('handles whitespace-only knowledgeContext (treated as falsy)', () => {
    const result = buildAugmentedPrompt('hello', '   ');
    expect(result).toBe('hello');
  });
});
