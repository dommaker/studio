/**
 * agent.hooks.ts 测试 — G2 tool risk awareness
 */
import { describe, it, expect } from 'vitest';

// Pure function: tests the buildAgentConstraintPrompt logic
// The harness buildConstraintPrompt may return empty if no constraints match trigger,
// but our wrapper always appends tool risk info
describe('buildAgentConstraintPrompt — G2', () => {
  it('工具风险信息总是存在', async () => {
    const mod = await import('../../packages/studio-shared/src/harness/hooks/agent.hooks.js');
    const result = mod.buildAgentConstraintPrompt({
      operation: 'code_implementation',
      taskDescription: 'add login page',
    });
    expect(result).toContain('工具风险');
    expect(result).toContain('sandbox');
  });

  it('三个风险等级都列出来了', async () => {
    const mod = await import('../../packages/studio-shared/src/harness/hooks/agent.hooks.js');
    const result = mod.buildAgentConstraintPrompt({ operation: 'code_implementation' });
    expect(result).toContain('Level 1-2');
    expect(result).toContain('Level 3');
    expect(result).toContain('Level 4');
  });
});
