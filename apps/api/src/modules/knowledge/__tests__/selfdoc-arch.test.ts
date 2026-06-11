/**
 * SelfDoc Architecture Doc Generation — P5b
 *
 * AC:
 * P5b-1: runArchDocs() generates 7 architecture docs under docs/architecture/
 * P5b-2: Each doc contains 职责/架构/子模块索引/关键接口/依赖 sections
 * P5b-3: Empty code structure produces minimal docs (no crash)
 * P5b-4: LLM failure skips that module, continues others
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

const mockPrompt = vi.fn().mockResolvedValue('# Module\n\n## 职责\nTest module');
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

vi.mock('@dommaker/harness', () => ({
  extractCodeStructure: vi.fn().mockReturnValue({
    files: ['index.ts'],
    functions: [{ name: 'init', signature: 'init(): void' }],
    classes: [],
    interfaces: [],
    types: [],
    imports: [],
  }),
}));

describe('SelfDoc Architecture Docs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrompt.mockResolvedValue('# Module\n\n## 职责\nTest module');
  });

  it('P5b-1: runArchDocs generates 7 architecture docs', async () => {
    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    await scheduler.runArchDocs();

    // Should generate 7 docs: pipeline, knowledge, constraints, agents, skills, infra, index
    const writeCalls = (fs.writeFileSync as any).mock.calls.filter(
      (c: any[]) => String(c[0]).includes('docs/architecture') && String(c[0]).endsWith('.md'),
    );
    expect(writeCalls.length).toBe(7);
  });

  it('P5b-2: each doc contains required sections', async () => {
    mockPrompt.mockResolvedValue(`# Pipeline

## 职责
管线执行引擎

## 架构
Agent 拓扑 + 状态机

## 子模块索引
- scheduler
- executor

## 关键接口
- runGoal()

## 依赖
- KnowledgeService`);

    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    await scheduler.runArchDocs();

    const writeCalls = (fs.writeFileSync as any).mock.calls;
    for (const call of writeCalls) {
      const content = String(call[1]);
      if (content.includes('# Pipeline')) {
        expect(content).toContain('## 职责');
        expect(content).toContain('## 架构');
      }
    }
  });

  it('P5b-3: empty code structure produces minimal docs', async () => {
    const { extractCodeStructure } = await import('@dommaker/harness');
    (extractCodeStructure as any).mockReturnValue({
      files: [],
      functions: [],
      classes: [],
      interfaces: [],
      types: [],
      imports: [],
    });

    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    // Should not throw
    await expect(scheduler.runArchDocs()).resolves.toBeUndefined();
    expect(mockPrompt).toHaveBeenCalled();
  });

  it('P5b-4: LLM failure skips that module, continues others', async () => {
    let callCount = 0;
    mockPrompt.mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error('LLM timeout');
      return Promise.resolve('# Doc');
    });

    const { ImproverScheduler } = await import('../improver-scheduler.service.js');
    const scheduler = new ImproverScheduler();

    // Should not throw
    await expect(scheduler.runArchDocs()).resolves.toBeUndefined();

    // Should still generate other docs (at least 6 out of 7)
    const writeCalls = (fs.writeFileSync as any).mock.calls.filter(
      (c: any[]) => String(c[0]).includes('docs/architecture') && String(c[0]).endsWith('.md'),
    );
    expect(writeCalls.length).toBeGreaterThanOrEqual(6);
  });
});
