/**
 * R1（type-repair）：DecisionChainExtractor.query 口径放宽
 *
 * 背景：决策链查询此前只按 tags=['decision'] 过滤，LLM 会话提取产物
 * （type='decision' 但 tags 未必含 'decision' 的存量条目）查不到。
 * 放宽为：type='decision' OR tags 含 'decision'。
 * 同时：LLM 提取产物 content 是自然语言（非 JSON），query 不得因
 * JSON.parse 抛错而整体失败（逐条容错，缺省 {}）。
 */
import { describe, it, expect, vi } from 'vitest';

const { mockList } = vi.hoisted(() => ({
  mockList: vi.fn().mockReturnValue([]),
}));

vi.mock('../knowledge-bus.service.js', () => ({
  sharedStore: { list: mockList },
}));

import { DecisionChainExtractor } from '../decision-chain-extractor.js';

const baseEntry = {
  maturity: 'draft',
  layer: 'project',
  created: '2026-07-20T00:00:00Z',
  lastReferenced: '2026-07-20T00:00:00Z',
  contributors: ['test'],
  projects: [],
  applicablePhases: [],
  sourceReferences: [],
  referencedBy: [],
  executionResults: [],
  consumptionMode: 'signal',
  origin: 'agent',
};

describe('R1: DecisionChainExtractor.query 口径放宽', () => {
  it('type=decision 条目（无 decision tag，自然语言 content）也能查到', async () => {
    mockList.mockReturnValue([
      {
        ...baseEntry,
        id: 'd-llm',
        type: 'decision',
        title: '选用 JWT 而非 session',
        content: '背景: 多端登录。选择: JWT 无状态。', // LLM 产物：非 JSON
        tags: ['decision', 'architecture'],
      },
      {
        ...baseEntry,
        id: 'd-legacy',
        type: 'decision',
        title: '存量 decision（tags 无 decision）',
        content: '自然语言内容，不是 JSON',
        tags: [],
      },
      {
        ...baseEntry,
        id: 'x-other',
        type: 'pitfall',
        title: '非决策条目',
        content: '{}',
        tags: ['pitfall'],
      },
    ]);

    const extractor = new DecisionChainExtractor();
    const results = await extractor.query({});

    const ids = results.map(r => r.id);
    expect(ids).toContain('d-llm');
    expect(ids).toContain('d-legacy'); // type='decision' 口径：无 decision tag 也命中
    expect(ids).not.toContain('x-other');
  });

  it('tags 含 decision 的 extractor 产物（JSON content）字段解析保持兼容', async () => {
    mockList.mockReturnValue([
      {
        ...baseEntry,
        id: 'd-extractor',
        type: 'decision',
        title: '选型：pnpm  workspaces',
        content: JSON.stringify({ context: 'monorepo 管理', chosen: 'pnpm', rationale: 'workspace 原生支持', sourceType: 'execution' }),
        tags: ['decision', 'process'],
      },
    ]);

    const extractor = new DecisionChainExtractor();
    const results = await extractor.query({});

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'd-extractor', chosen: 'pnpm', category: 'process' });
  });

  it('自然语言 content 不让 query 抛错（逐条容错）', async () => {
    mockList.mockReturnValue([
      { ...baseEntry, id: 'd-plain', type: 'decision', title: '纯文本决策', content: '不是 JSON 的内容', tags: ['decision', 'process'] },
    ]);

    const extractor = new DecisionChainExtractor();
    await expect(extractor.query({})).resolves.toHaveLength(1);
  });
});
