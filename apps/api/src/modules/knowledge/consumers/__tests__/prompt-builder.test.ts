/**
 * buildKnowledgeContext — unified knowledge injection tests
 * Phase 2: uses UnifiedQuery for rules/context/signal injection
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock UnifiedQuery
const mockQueryEntries = vi.fn().mockResolvedValue([]);
const mockGetIndexes = vi.fn().mockReturnValue([]);
const mockCount = vi.fn().mockResolvedValue(0);
vi.mock('../../engine/unified-query.js', () => ({
  UnifiedQuery: vi.fn().mockImplementation(() => ({
    queryEntries: mockQueryEntries,
    getIndexes: mockGetIndexes,
    count: mockCount,
  })),
}));

// Mock knowledgeBus (legacy compatibility)
const mockFormatIndexSummary = vi.fn().mockReturnValue('');
vi.mock('../../knowledge-bus.service.js', () => ({
  knowledgeBus: {
    formatIndexSummary: mockFormatIndexSummary,
  },
}));

// Import after mocks
const { buildKnowledgeContext } = await import('../prompt-builder.js');

describe('buildKnowledgeContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should inject rules as full content', async () => {
    mockQueryEntries.mockResolvedValue([
      { id: 'rule:no_redis', content: '禁止 Redis 依赖', consumptionMode: 'rule' },
    ]);

    const result = await buildKnowledgeContext('executor');

    expect(result).toContain('## 系统约束');
    expect(result).toContain('禁止 Redis 依赖');
    expect(mockQueryEntries).toHaveBeenCalledWith(
      expect.objectContaining({ consumptionModes: ['rule'], agentType: 'executor' }),
    );
  });

  it('should inject context as full content', async () => {
    mockQueryEntries.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: 'pref:user', content: '偏好模型: premium', consumptionMode: 'context' },
    ]);

    const result = await buildKnowledgeContext('executor');

    expect(result).toContain('## 上下文');
    expect(result).toContain('偏好模型: premium');
  });

  it('should inject signals as index', async () => {
    mockGetIndexes.mockReturnValue([
      { id: 'signal:001', title: 'TDD pattern', summary: 'TDD 有效', tags: ['pattern'], source: 'store' },
    ]);

    const result = await buildKnowledgeContext('executor');

    expect(result).toContain('## 近期信号');
    expect(result).toContain('[signal:001] TDD 有效');
  });

  it('should show reference count hint', async () => {
    mockCount.mockResolvedValue(42);

    const result = await buildKnowledgeContext('executor');

    expect(result).toContain('[知识库: 42 条参考');
  });

  it('should strip markdown formatting from injected content', async () => {
    mockQueryEntries.mockResolvedValue([
      { id: 'rule:test', content: '## 标题\n`code` 和 [link](http://x.com)', consumptionMode: 'rule' },
    ]);

    const result = await buildKnowledgeContext('executor');

    // Content should be stripped: no backticks, no links
    expect(result).not.toContain('`');
    expect(result).not.toContain('](http');
    // But the text content should remain
    expect(result).toContain('标题');
    expect(result).toContain('code');
  });

  it('should handle empty knowledge gracefully', async () => {
    const result = await buildKnowledgeContext('executor');

    // Should not crash, may have empty sections or legacy index
    expect(typeof result).toBe('string');
  });
});
