/**
 * buildKnowledgeContext — unified knowledge injection tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock UnifiedQuery
const mockQueryEntries = vi.fn().mockResolvedValue([]);
const mockGetIndexes = vi.fn().mockReturnValue([]);
const mockCount = vi.fn().mockResolvedValue(0);
const mockUqInstance = {
  queryEntries: mockQueryEntries,
  getIndexes: mockGetIndexes,
  count: mockCount,
};
vi.mock('../../engine/unified-query.js', () => ({
  UnifiedQuery: class {
    constructor() { return mockUqInstance; }
  },
}));

// Mock knowledgeBus dependencies
const mockRecordReference = vi.fn();
const mockStoreList = vi.fn().mockReturnValue([]);
vi.mock('../../knowledge-bus.service.js', () => ({
  sharedStore: { list: mockStoreList },
  sharedLifecycle: { recordReference: mockRecordReference },
}));

// Mock skillLoader to prevent Skills section (which contains backticks in template)
vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { load: vi.fn().mockReturnValue([]), formatForPrompt: vi.fn().mockReturnValue('') },
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

    expect(result).not.toContain('`');
    expect(result).not.toContain('](http');
    expect(result).toContain('标题');
    expect(result).toContain('code');
  });

  it('should handle empty knowledge gracefully', async () => {
    const result = await buildKnowledgeContext('executor');

    expect(typeof result).toBe('string');
  });

  it('should show knowledge stats summary', async () => {
    mockStoreList.mockReturnValue([
      { tags: ['pattern'] },
      { tags: ['pattern'] },
      { tags: ['pitfall'] },
      { tags: ['guideline'] },
    ]);

    const result = await buildKnowledgeContext('executor');

    expect(result).toContain('知识库: 4 条');
    expect(result).toContain('代码模式 2');
    expect(result).toContain('坑点 1');
    expect(result).toContain('规范 1');
  });

  it('should record references for injected entries', async () => {
    mockQueryEntries
      .mockResolvedValueOnce([{ id: 'rule:no_redis', content: 'test', consumptionMode: 'rule' }])
      .mockResolvedValueOnce([{ id: 'pref:user', content: 'test', consumptionMode: 'context' }]);
    mockGetIndexes.mockReturnValue([
      { id: 'signal:001', summary: 'test', tags: [], source: 'store' },
    ]);

    await buildKnowledgeContext('executor');

    expect(mockRecordReference).toHaveBeenCalledWith('rule:no_redis', 'prompt-inject');
    expect(mockRecordReference).toHaveBeenCalledWith('pref:user', 'prompt-inject');
    expect(mockRecordReference).toHaveBeenCalledWith('signal:001', 'prompt-inject');
    expect(mockRecordReference).toHaveBeenCalledTimes(3);
  });

  it('should not fail if recordReference throws', async () => {
    mockQueryEntries.mockResolvedValueOnce([
      { id: 'rule:test', content: 'test', consumptionMode: 'rule' },
    ]);
    mockRecordReference.mockImplementation(() => { throw new Error('db error'); });

    const result = await buildKnowledgeContext('executor');

    expect(result).toContain('## 系统约束');
  });

  it('should not show stats when store is empty', async () => {
    mockStoreList.mockReturnValue([]);
    mockCount.mockResolvedValue(0);

    const result = await buildKnowledgeContext('executor');

    expect(result).not.toContain('知识库:');
  });
});
