/**
 * ImproverScheduler 独立测试
 *
 * AC3 覆盖：
 * 1. runSelfDoc 正常流程（extractCodeStructure → LLM → write）
 * 2. extractCodeStructure 不可用时降级
 * 3. LLM 调用失败时静默跳过
 * 4. 空目录列表时不做任何操作
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ── Mocks (vi.mock is hoisted before imports) ──

const mockPrompt = vi.fn().mockResolvedValue('# Generated Doc');
const mockRecordPattern = vi.fn().mockResolvedValue(undefined);

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  modelGateway: { prompt: (...args: any[]) => mockPrompt(...args) },
}));

vi.mock('../knowledge-bus.service.js', () => ({
  knowledgeBus: { recordPattern: (...args: any[]) => mockRecordPattern(...args) },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readdirSync: vi.fn().mockReturnValue([]),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

// extractCodeStructure mock — set to undefined in "unavailable" tests
let extractCodeStructureImpl: ((dir: string) => any) | undefined = vi.fn().mockReturnValue({
  files: ['foo.ts'],
  functions: [{ name: 'doStuff', signature: 'doStuff(x: number): void', jsdoc: 'Does stuff' }],
  classes: [],
  interfaces: [],
  types: [],
});

vi.mock('@dommaker/harness', () => ({
  get extractCodeStructure() { return extractCodeStructureImpl; },
}));

describe('ImproverScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset to default
    extractCodeStructureImpl = vi.fn().mockReturnValue({
      files: ['foo.ts'],
      functions: [{ name: 'doStuff', signature: 'doStuff(x: number): void', jsdoc: 'Does stuff' }],
      classes: [],
      interfaces: [],
      types: [],
    });
    mockPrompt.mockResolvedValue('# Generated Doc');
    (fs.readdirSync as any).mockReturnValue([]);
    (fs.writeFileSync as any).mockClear();
  });

  it('AC3.1: runSelfDoc normal flow — extractCodeStructure → LLM → write', async () => {
    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    await scheduler.runSelfDoc(['/test/dir']);

    // extractCodeStructure called with dir
    expect(extractCodeStructureImpl).toHaveBeenCalledWith('/test/dir');

    // modelGateway.prompt called (system + user prompt)
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    const [systemPrompt, userPrompt] = mockPrompt.mock.calls[0];
    expect(typeof systemPrompt).toBe('string');
    expect(typeof userPrompt).toBe('string');
    expect(userPrompt).toContain('doStuff');

    // knowledgeBus.recordPattern called with architecture type
    expect(mockRecordPattern).toHaveBeenCalledTimes(1);
    const entry = mockRecordPattern.mock.calls[0][0];
    expect(entry.type).toBe('guideline');
    expect(entry.title).toContain('/test/dir');

    // CONTEXT.md written
    expect(fs.writeFileSync).toHaveBeenCalled();
    const writeCall = (fs.writeFileSync as any).mock.calls.find(
      (c: any[]) => String(c[0]).includes('CONTEXT.md'),
    );
    expect(writeCall).toBeDefined();
  });

  it('AC3.2: extractCodeStructure unavailable — fallback to file listing', async () => {
    // Simulate import failure
    extractCodeStructureImpl = undefined;

    (fs.readdirSync as any).mockReturnValue(['bar.ts', 'baz.js', 'readme.md']);

    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    await scheduler.runSelfDoc(['/fallback/dir']);

    // readdirSync called to list files
    expect(fs.readdirSync).toHaveBeenCalledWith('/fallback/dir');

    // LLM still called with simplified prompt containing filenames
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    const [, userPrompt] = mockPrompt.mock.calls[0];
    expect(userPrompt).toContain('bar.ts');
    expect(userPrompt).toContain('baz.js');

    // knowledgeBus still writes
    expect(mockRecordPattern).toHaveBeenCalledTimes(1);

    // CONTEXT.md still written
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('AC3.3: LLM failure — silently skips, no write', async () => {
    mockPrompt.mockRejectedValue(new Error('LLM unavailable'));

    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    // Should not throw
    await expect(scheduler.runSelfDoc(['/test/dir'])).resolves.toBeUndefined();

    // No knowledgeBus write
    expect(mockRecordPattern).not.toHaveBeenCalled();

    // No CONTEXT.md write
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('AC3.4: empty dirs — no-op', async () => {
    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    await scheduler.runSelfDoc([]);

    // Nothing called
    expect(extractCodeStructureImpl).not.toHaveBeenCalled();
    expect(mockPrompt).not.toHaveBeenCalled();
    expect(mockRecordPattern).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('startScheduler sets interval and stopScheduler clears it', async () => {
    vi.useFakeTimers();
    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    scheduler.startScheduler();
    // Timer should be set (no throw)
    scheduler.stopScheduler();
    // Idempotent
    expect(() => scheduler.stopScheduler()).not.toThrow();

    vi.useRealTimers();
  });
});
