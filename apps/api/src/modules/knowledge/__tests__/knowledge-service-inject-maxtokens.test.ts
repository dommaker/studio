/**
 * §10 依赖项 — injectContext 的 opts.maxTokens 做实
 *
 * - 自定义预算：按 maxTokens 截断，knowledge:inject-trimmed 事件带该预算值
 * - 缺省：行为不变（INJECT_TOKEN_BUDGET = 2000）
 */
import { describe, it, expect, vi } from 'vitest';

const { mockAppendJsonl } = vi.hoisted(() => ({
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../resolution.service.js', () => ({
  resolutionService: { createResolution: vi.fn().mockResolvedValue(null) },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(function () { return {
      appendJsonl: mockAppendJsonl,
      readJsonl: vi.fn().mockResolvedValue([]),
      readJson: vi.fn().mockResolvedValue(null),
      writeJson: vi.fn().mockResolvedValue(undefined),
      readDoc: vi.fn().mockResolvedValue(null),
      writeDoc: vi.fn().mockResolvedValue(undefined),
      listDocs: vi.fn().mockResolvedValue([]),
    }; }),
  };
});

import { KnowledgeService, INJECT_TOKEN_BUDGET } from '../knowledge-service.js';

function createKS() {
  const query = {
    queryEntries: vi.fn().mockResolvedValue([]),
    listEntries: vi.fn().mockResolvedValue([]),
    getIndexes: vi.fn().mockReturnValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
  const ks = new KnowledgeService({
    store: { list: vi.fn(() => []), get: vi.fn(), save: vi.fn(), update: vi.fn(), delete: vi.fn() } as any,
    lifecycle: { recordReference: vi.fn(), shouldAutoPromote: vi.fn(() => false) } as any,
    ingest: { ingestEntry: vi.fn() } as any,
    linter: { validateEntry: vi.fn(() => []) } as any,
    query: query as any,
    eventEmitter: { emit: vi.fn() } as any,
  });
  return { ks, query };
}

const bigRule = (id: string, label: string) => ({
  id,
  content: `${label} ${'规'.repeat(3500)}`, // ≈875+ tokens/条（chars/4）
  type: 'guideline',
  sourceReferences: [{ timestamp: 't' }],
  status: 'published',
  maturity: 'verified',
});

describe('injectContext maxTokens（§10：_opts 做实）', () => {
  it('custom maxTokens truncates to the given budget', async () => {
    mockAppendJsonl.mockClear();
    const { ks, query } = createKS();
    query.queryEntries
      .mockResolvedValueOnce([bigRule('r1', '规则一'), bigRule('r2', '规则二')])
      .mockResolvedValueOnce([]);

    const result = await ks.injectContext('executor', { maxTokens: 1000 });

    // 第一条 ~876 tokens 进预算，第二条被裁
    expect(result.injectedIds).toEqual(['r1']);
    expect(result.prompt).toContain('规则一');
    expect(result.prompt).not.toContain('规则二');

    // 裁剪事件带自定义预算
    expect(mockAppendJsonl).toHaveBeenCalled();
    const evt = mockAppendJsonl.mock.calls[0][1];
    expect(evt.type).toBe('knowledge:inject-trimmed');
    const payload = JSON.parse(evt.payload);
    expect(payload.budgetTokens).toBe(1000);
    expect(payload.trimmedIds).toContain('r2');
  });

  it('defaults to INJECT_TOKEN_BUDGET (2000) when maxTokens absent — behavior unchanged', async () => {
    mockAppendJsonl.mockClear();
    const { ks, query } = createKS();
    query.queryEntries
      .mockResolvedValueOnce([bigRule('r1', '规则一'), bigRule('r2', '规则二'), bigRule('r3', '规则三')])
      .mockResolvedValueOnce([]);

    const result = await ks.injectContext('executor');

    // 默认 2000：两条 ~876 进预算，第三条被裁
    expect(result.injectedIds).toEqual(['r1', 'r2']);
    const evt = mockAppendJsonl.mock.calls[0][1];
    const payload = JSON.parse(evt.payload);
    expect(payload.budgetTokens).toBe(INJECT_TOKEN_BUDGET);
    expect(payload.trimmedIds).toEqual(['r3']);
  });
});
