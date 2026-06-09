/**
 * KnowledgeAgent.extractUserBehavior — KE-003 Phase 1 单元测试
 *
 * Mock Prisma + DeepSeek API，测试：transcript 预处理（caller 职责）、
 * JSON 解析兜底、Layer 1 context injection、title 去重、存储逻辑。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────

const mockFindMany = vi.fn().mockResolvedValue([]);
const mockCreate = vi.fn().mockResolvedValue({});

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    userBehaviorProfile: {
      findMany: mockFindMany,
      create: mockCreate,
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  modelGateway: {},
  getModelForTier: () => 'deepseek-v4-flash',
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@dommaker/harness', () => ({
  ColdStartImporter: class {},
  KnowledgeLinter: class { lint() { return { issues: [] }; } },
  ReferenceTracker: class {},
  KnowledgeStore: class { list() { return []; } readEntriesFromDisk() { return []; } },
  FileKnowledgeStore: class { list() { return []; } readEntriesFromDisk() { return []; } },
  KnowledgeIngest: class {},
  KnowledgeLifecycle: class {},
  KnowledgeQuery: class {},
  KnowledgeInjector: class {},
  KnowledgeEvolver: class {},
  KnowledgeDoctor: class {},
}));

vi.mock('../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: {},
  sharedIngest: { ingestEntry: vi.fn() },
}));

vi.mock('../channels/channel-message.service.js', () => ({
  channelMessageService: {},
}));

// Mock fetch for DeepSeek API
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Tests ──────────────────────────────────────────────────

describe('KnowledgeAgent.extractUserBehavior (KE-003)', () => {
  let extractUserBehavior: (content: string, source: string, threshold?: number) => Promise<void>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
    mockCreate.mockResolvedValue({});
    process.env.STUDIO_API_KEY = 'test-key';

    // Mock successful DeepSeek response
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify([
              {
                category: 'correction',
                title: '先验证再改',
                evidence: '你陷入了误区，应该先验证假设',
                pattern: '用户要求先验证再修改代码',
                suggestedAction: 'create_rule',
                confidence: 0.9,
              },
            ]),
          },
        }],
      }),
    });

    const { KnowledgeAgent } = await import('../knowledge-agent.service.js');
    const agent = new KnowledgeAgent();
    extractUserBehavior = (agent as any).extractUserBehavior.bind(agent);
  });

  it('should store extracted behavior profile in Prisma', async () => {
    await extractUserBehavior('User: 你陷入了误区\nAssistant: 抱歉', 'session:test-uuid');

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: 'test-uuid',
        category: 'correction',
        title: '先验证再改',
        confidence: 0.9,
        status: 'pending',
      }),
    });
  });

  it('should extract sessionId from source', async () => {
    await extractUserBehavior('User: test', 'session:a1b2c3d4-e5f6.jsonl.bak.20260529');

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: 'a1b2c3d4-e5f6',
      }),
    });
  });

  it('should skip entries below threshold', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify([{
              category: 'automation',
              title: '低置信度',
              evidence: 'test',
              pattern: 'test',
              suggestedAction: 'skip',
              confidence: 0.3,
            }]),
          },
        }],
      }),
    });

    await extractUserBehavior('User: test', 'session:test', 0.6);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should mark alreadyCovered when title matches existing profile', async () => {
    mockFindMany.mockResolvedValue([{ title: '先验证再改' }]);

    await extractUserBehavior('User: test', 'session:test');

    expect(mockCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        alreadyCovered: '先验证再改',
        status: 'rejected',
      }),
    });
  });

  it('should handle empty LLM response', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    });

    await extractUserBehavior('User: test', 'session:test');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should parse JSON from code block fallback', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{
          message: {
            content: '```json\n[{"category":"workflow","title":"先分析后动手","evidence":"test","pattern":"test","suggestedAction":"create_skill","confidence":0.8}]\n```',
          },
        }],
      }),
    });

    await extractUserBehavior('User: test', 'session:test');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('should parse JSON array from freeform response', async () => {
    mockFetch.mockResolvedValue({
      json: async () => ({
        choices: [{
          message: {
            content: 'Here are the patterns:\n[{"category":"automation","title":"重复查proxy","evidence":"每次都要查","pattern":"查proxy配置","suggestedAction":"create_automation","confidence":0.7}]',
          },
        }],
      }),
    });

    await extractUserBehavior('User: test', 'session:test');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('should skip when no API key', async () => {
    const origKey = process.env.STUDIO_API_KEY;
    delete process.env.STUDIO_API_KEY;

    await extractUserBehavior('User: test', 'session:test');
    expect(mockCreate).not.toHaveBeenCalled();

    if (origKey) process.env.STUDIO_API_KEY = origKey;
  });

  it('should skip empty content', async () => {
    await extractUserBehavior('', 'session:test');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should inject existing profiles into prompt (Layer 1)', async () => {
    mockFindMany.mockResolvedValue([{ title: '已有模式A' }, { title: '已有模式B' }]);

    await extractUserBehavior('User: test', 'session:test');

    // Verify the system prompt contains existing patterns
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const systemPrompt = callBody.messages[0].content;
    expect(systemPrompt).toContain('已有模式A');
    expect(systemPrompt).toContain('已有模式B');
    expect(systemPrompt).toContain('不要重复提取');
  });
});
