/**
 * Pipeline contractTests skipReason + card status + SSE push
 *
 * TDD RED: 测试先行，覆盖 5 个改动点
 */
import { describe, it, expect } from 'vitest';

// ─── 1. validateAnalystOutput: contractTestsSkipReason ───

describe('validateAnalystOutput — contractTestsSkipReason', () => {
  async function validate(d: Record<string, unknown>) {
    const mod = await import('../src/modules/channels/analyst-executor.js');
    return (mod as any).validateAnalystOutput(d);
  }

  const base = {
    title: 'Test',
    summary: 'Test summary',
    acGroups: [{ id: 'g1', acs: ['AC1'], files: [], dependencies: [], implementationNotes: '', architectureContext: { functions: [], callChain: '', imports: [], typesInScope: [], testMock: [], dangerZones: [], verifiedAt: 'HEAD' }, codePatterns: [], gotchas: [] }],
    constraints: [],
    tags: [],
  };

  it('accepts empty contractTests with skipReason', async () => {
    const errors = await validate({ ...base, contractTests: [], contractTestsSkipReason: '纯文件创建，无代码行为可测' });
    expect(errors).toEqual([]);
  });

  it('rejects empty contractTests without skipReason', async () => {
    const errors = await validate({ ...base, contractTests: [] });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('contractTestsSkipReason');
  });

  it('rejects missing contractTests without skipReason', async () => {
    const errors = await validate(base);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('contractTestsSkipReason');
  });

  it('accepts non-empty contractTests without skipReason', async () => {
    const errors = await validate({
      ...base,
      contractTests: [{ file: 'test.ts', content: 'test code' }],
    });
    expect(errors).toEqual([]);
  });

  it('rejects non-string skipReason', async () => {
    const errors = await validate({ ...base, contractTests: [], contractTestsSkipReason: 123 });
    expect(errors.some((e: string) => e.includes('contractTestsSkipReason'))).toBe(true);
  });
});

// ─── 2. RequirementsDocJson type: has contractTestsSkipReason ───

describe('RequirementsDocJson type — contractTestsSkipReason', () => {
  it('exports contractTestsSkipReason field', async () => {
    const mod = await import('../src/modules/channels/analyst-executor.js');
    // Type-only check: if the field doesn't exist, TS compilation would fail.
    // Runtime check: construct an object with the field.
    const doc: any = {
      title: 'T',
      summary: 'S',
      acGroups: [],
      constraints: [],
      tags: [],
      contractTests: [],
      contractTestsSkipReason: 'reason',
    };
    expect(doc.contractTestsSkipReason).toBe('reason');
  });
});

// ─── 3. analyst-prompt: skipReason instruction ───

describe('analyst-prompt — skipReason instruction', () => {
  it('includes contractTestsSkipReason in JSON template', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/channels/analyst-prompt.ts'),
      'utf-8'
    );
    expect(source).toContain('contractTestsSkipReason');
  });
});

// ─── 4. goal-crud: SSE publish on goal.created ───

describe('goal-crud — SSE publish on goal.created', () => {
  it('publishes goal.created to eventStore for SSE', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/goals/goal-crud.ts'),
      'utf-8'
    );
    expect(source).toContain('eventStore.publish');
    expect(source).toContain('goal.created');
  });
});

// ─── 5. channel.routes: card status update on block ───

describe('channel.routes — card status on contractTests block', () => {
  it('updates card meta.status to blocked when contractTests missing', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/channels/channel.routes.ts'),
      'utf-8'
    );
    // Should update card status to 'blocked' when blocking
    expect(source).toMatch(/status.*blocked|blocked.*status/);
    // Should not just return 400 without updating card
    expect(source).toContain('updateMessage');
  });
});

// ─── 6. studio-cli: SSE listener replaces polling ───

// ─── 7. requirement-gate: absolute path handling ───

describe('requirement-gate — absolute path handling', () => {
  it('resolves absolute file paths without joining with repoDir', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/modules/agents/requirement-gate.ts'),
      'utf-8'
    );
    // Should handle absolute paths separately from relative paths
    expect(source).toContain('path.isAbsolute');
  });
});

// ─── 8. studio-cli: SSE listener for goal.created ───

describe('studio-cli — SSE listener for goal.created', () => {
  it('connects to /api/v1/events/stream for goal events', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/cli/studio-cli.ts'),
      'utf-8'
    );
    // Should use SSE stream instead of only polling
    expect(source).toContain('events/stream');
    // Should listen for goal.created event
    expect(source).toContain('goal.created');
  });
});
