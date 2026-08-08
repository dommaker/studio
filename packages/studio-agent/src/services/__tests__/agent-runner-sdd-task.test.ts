/**
 * SP-004 Step 5: Behavioral tests for resolveSddTaskData
 *
 * Tests the SDD task layer reading logic: contractTests + testFiles
 * resolution with DB fallback.
 */
import { describe, test, expect, vi, beforeAll } from 'vitest';

// Mock SDD functions before importing runner-params
const mockReadSddDoc = vi.fn();
const mockFindSddDocById = vi.fn();

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    readSddDoc: mockReadSddDoc,
    findSddDocById: mockFindSddDocById,
  };
});

// Must import after mock setup
const { resolveSddTaskData } = await import('../runner-params.js');

function makeTask(params: Record<string, unknown> = {}) {
  return {
    id: 'task-001',
    executionId: 'exec-001',
    prompt: 'Test task',
    parameters: params,
  } as any;
}

describe('resolveSddTaskData', () => {
  beforeAll(() => {
    vi.clearAllMocks();
  });

  test('returns DB contractTests when no slug available', async () => {
    mockFindSddDocById.mockResolvedValue(null);
    const dbTests = [{ file: '__tests__/db.test.ts', content: 'it("db", () => {})' }];
    const task = makeTask({ contractTests: dbTests });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toEqual(dbTests);
    expect(result.testFiles).toEqual([]);
  });

  test('returns DB values when SDD file not found', async () => {
    mockReadSddDoc.mockResolvedValue(null);
    const dbTests = [{ file: '__tests__/db.test.ts', content: 'it("db", () => {})' }];
    const task = makeTask({ contractTests: dbTests, sddSlug: 'nonexistent-slug' });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toEqual(dbTests);
    expect(result.testFiles).toEqual([]);
  });

  test('reads contractTests from SDD task.md', async () => {
    mockReadSddDoc.mockResolvedValue({
      meta: { id: 'test-doc', slug: 'sdd-contract-test' },
      body: [
        '## Contract Tests',
        '',
        '### __tests__/auth.test.ts',
        '```typescript',
        "import { describe, it, expect } from 'vitest';",
        "it('auth test', () => { expect(true).toBe(true); });",
        '```',
      ].join('\n'),
    });

    const task = makeTask({ sddSlug: 'sdd-contract-test' });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toHaveLength(1);
    expect(result.contractTests[0].file).toBe('__tests__/auth.test.ts');
    expect(result.contractTests[0].content).toContain('auth test');
  });

  test('reads testFiles from SDD task.md', async () => {
    mockReadSddDoc.mockResolvedValue({
      meta: { id: 'test-doc-2', slug: 'sdd-testfiles' },
      body: [
        '## Test Files',
        '',
        '- __tests__/auth.test.ts',
        '- __tests__/session.test.ts',
      ].join('\n'),
    });

    const task = makeTask({ sddSlug: 'sdd-testfiles' });
    const result = await resolveSddTaskData(task);
    expect(result.testFiles).toEqual(['__tests__/auth.test.ts', '__tests__/session.test.ts']);
  });

  test('SDD values take precedence over DB when both exist', async () => {
    mockReadSddDoc.mockResolvedValue({
      meta: { id: 'test-doc-3', slug: 'sdd-precedence' },
      body: [
        '## Contract Tests',
        '',
        '### __tests__/sdd.test.ts',
        '```typescript',
        "it('sdd test', () => {});",
        '```',
        '',
        '## Test Files',
        '',
        '- __tests__/regression.test.ts',
      ].join('\n'),
    });

    const dbTests = [{ file: '__tests__/db.test.ts', content: 'it("db", () => {})' }];
    const task = makeTask({ sddSlug: 'sdd-precedence', contractTests: dbTests });
    const result = await resolveSddTaskData(task);
    // SDD values should win
    expect(result.contractTests).toHaveLength(1);
    expect(result.contractTests[0].file).toBe('__tests__/sdd.test.ts');
    expect(result.testFiles).toEqual(['__tests__/regression.test.ts']);
  });

  test('falls back to DB contractTests when SDD has no Contract Tests section', async () => {
    mockReadSddDoc.mockResolvedValue({
      meta: { id: 'test-doc-4', slug: 'sdd-no-contract' },
      body: '## Other Section\n\nSome content.',
    });

    const dbTests = [{ file: '__tests__/db.test.ts', content: 'it("db", () => {})' }];
    const task = makeTask({ sddSlug: 'sdd-no-contract', contractTests: dbTests });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toEqual(dbTests);
    expect(result.testFiles).toEqual([]);
  });

  test('resolves slug from task.parameters.goalId via findSddDocById', async () => {
    mockFindSddDocById.mockResolvedValue('sdd-by-goal');
    mockReadSddDoc.mockResolvedValue({
      meta: { id: 'test-doc-5', slug: 'sdd-by-goal' },
      body: [
        '## Contract Tests',
        '',
        '### __tests__/goal.test.ts',
        '```typescript',
        "it('goal test', () => {});",
        '```',
        '',
        '## Test Files',
        '',
        '- __tests__/existing.test.ts',
      ].join('\n'),
    });

    const task = makeTask({ goalId: 'goal-abc-123' });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toHaveLength(1);
    expect(result.contractTests[0].file).toBe('__tests__/goal.test.ts');
    expect(result.testFiles).toEqual(['__tests__/existing.test.ts']);
  });

  test('returns empty when both SDD and DB have no contractTests', async () => {
    mockReadSddDoc.mockResolvedValue({
      meta: { id: 'test-doc-6', slug: 'sdd-empty' },
      body: '## Implementation Notes\n\nSome notes.',
    });

    const task = makeTask({ sddSlug: 'sdd-empty' });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toBeUndefined();
    expect(result.testFiles).toEqual([]);
  });

  test('handles readSddDoc throwing error gracefully', async () => {
    mockReadSddDoc.mockRejectedValue(new Error('read error'));
    const dbTests = [{ file: '__tests__/db.test.ts', content: 'it("db", () => {})' }];
    const task = makeTask({ sddSlug: 'error-slug', contractTests: dbTests });
    const result = await resolveSddTaskData(task);
    expect(result.contractTests).toEqual(dbTests);
    expect(result.testFiles).toEqual([]);
  });
});
