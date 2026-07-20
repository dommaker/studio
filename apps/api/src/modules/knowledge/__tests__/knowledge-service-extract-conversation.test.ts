/**
 * R3: KnowledgeService.extractFromConversation + 提案注入闸门
 *
 * 自足测试（不依赖真实 LLM / 真实 HOME）：
 * - modelGateway mock：复用 KnowledgeAgent 底层 LLM 路径（promptJson + provider/tier）
 * - knowledge-agent.service mock：仅提供 EXTRACT_FROM_TEXT_SYSTEM_PROMPT（验证 prompt 复用）
 * - knowledge-singletons mock：避免模块加载副作用（pkill / vector-db sync timer）
 *
 * 覆盖：
 *  (a) LLM 输出解析 → ingest 入库 maturity=draft（proposal）
 *  (b) draft 条目不参与 injectContext 注入（提案闸门）
 *  (d) knowledge:extraction 事件携带 token 计数 / duration / entry ids
 *  边界：无 LLM 配置静默跳过 / LLM 失败不抛出 / 空消息早退 / 形态门禁拒绝
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockAppendJsonl, mockPromptJson, mockIsAvailable, mockGetRecentUsage, mockScheduleVectorDbSync } = vi.hoisted(() => ({
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockPromptJson: vi.fn(),
  mockIsAvailable: vi.fn().mockReturnValue(true),
  mockGetRecentUsage: vi.fn().mockReturnValue([]),
  mockScheduleVectorDbSync: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(() => ({
      appendJsonl: mockAppendJsonl,
      readJsonl: vi.fn().mockResolvedValue([]),
      readJson: vi.fn().mockResolvedValue(null),
      writeJson: vi.fn().mockResolvedValue(undefined),
      readDoc: vi.fn().mockResolvedValue(null),
      writeDoc: vi.fn().mockResolvedValue(undefined),
      listDocs: vi.fn().mockResolvedValue([]),
    })),
    modelGateway: {
      promptJson: mockPromptJson,
      isAvailable: mockIsAvailable,
      getRecentUsage: mockGetRecentUsage,
    },
  };
});

// R3: prompt 复用验证点 — 本模块导出共享 prompt 常量 + E1 override getter
vi.mock('../../agents/knowledge-agent.service.js', () => ({
  EXTRACT_FROM_TEXT_SYSTEM_PROMPT: 'shared-extraction-system-prompt',
  getExtractFromTextSystemPrompt: () => 'shared-extraction-system-prompt',
}));

vi.mock('../knowledge-singletons.js', () => ({
  sharedStore: {},
  sharedLifecycle: {},
  sharedIngest: {},
  sharedQuery: {},
  sharedLinter: {},
  scheduleVectorDbSync: mockScheduleVectorDbSync,
  ingestWithQualityGate: vi.fn(),
  UNIFIED_KNOWLEDGE_DIR: '/tmp/unused',
}));

import { KnowledgeService } from '../knowledge-service.js';

// ── Mock factories（与 knowledge-service.test.ts 同款） ──

function createMockStore(initialEntries: any[] = []) {
  const entries = [...initialEntries];
  return {
    list: vi.fn(() => entries),
    get: vi.fn((id: string) => entries.find(e => e.id === id) || null),
    save: vi.fn((entry: any) => { entries.push(entry); return entry; }),
    update: vi.fn(),
    delete: vi.fn(),
    _entries: entries,
  };
}

function createMockLifecycle() {
  return { recordReference: vi.fn(), shouldAutoPromote: vi.fn(() => false) };
}

function createMockIngest() {
  let seq = 0;
  return {
    ingestEntry: vi.fn((entry: any, opts: any) => ({
      id: `ingested-${++seq}`,
      ...entry,
      ...opts,
      lastReferenced: new Date().toISOString(),
      contributors: ['test'],
    })),
  };
}

function createMockLinter() {
  return { validateEntry: vi.fn(() => []) };
}

function createMockQuery() {
  return {
    queryEntries: vi.fn().mockResolvedValue([]),
    listEntries: vi.fn().mockResolvedValue([]),
    getIndexes: vi.fn().mockReturnValue([]),
    count: vi.fn().mockResolvedValue(0),
  };
}

function createKS(opts?: { entries?: any[] }) {
  const store = createMockStore(opts?.entries);
  const lifecycle = createMockLifecycle();
  const ingest = createMockIngest();
  const linter = createMockLinter();
  const query = createMockQuery();
  const eventEmitter = { emit: vi.fn() };

  const ks = new KnowledgeService({
    store: store as any,
    lifecycle: lifecycle as any,
    ingest: ingest as any,
    linter: linter as any,
    query: query as any,
    eventEmitter: eventEmitter as any,
  });

  return { ks, store, lifecycle, ingest, linter, query, eventEmitter };
}

const MESSAGES = [
  { role: 'user', content: '实现登录功能，注意上次 session 过期的坑' },
  { role: 'assistant', content: '已完成：登录功能 + session 过期根因修复' },
];

describe('R3: extractFromConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAvailable.mockReturnValue(true);
    mockGetRecentUsage.mockReturnValue([]);
  });

  it('(a) 解析 LLM 输出 → 以 maturity=draft 入库（proposal），复用共享 prompt 与 knowledge provider', async () => {
    mockPromptJson.mockResolvedValue({
      entries: [
        { type: 'pitfall', title: 'session 过期未刷新导致 401', content: '根因: token 刷新逻辑遗漏。责任: Executor。预防: 加中间件统一刷新。', tags: ['root-cause'] },
        { type: 'guideline', title: '登录流程统一走 auth-service', content: '可复用模式: 所有登录入口委托 auth-service，避免分散实现。', tags: ['pattern'] },
      ],
    });
    const { ks, ingest } = createKS();

    await ks.extractFromConversation(MESSAGES, { workUnitId: 'wu-r3' });

    // LLM 调用：transcript 含 role 标注消息；prompt/provider 复用 KnowledgeAgent 路径
    expect(mockPromptJson).toHaveBeenCalledTimes(1);
    const [transcript, systemPrompt, options] = mockPromptJson.mock.calls[0];
    expect(transcript).toContain('[user] 实现登录功能，注意上次 session 过期的坑');
    expect(transcript).toContain('[assistant] 已完成：登录功能 + session 过期根因修复');
    expect(systemPrompt).toBe('shared-extraction-system-prompt');
    expect(options).toEqual({ provider: 'knowledge', tier: 'standard' });

    // 入库：proposal（draft）+ signal 消费模式 + 来源追溯
    expect(ingest.ingestEntry).toHaveBeenCalledTimes(2);
    const [partial, opts] = ingest.ingestEntry.mock.calls[0];
    expect(partial).toMatchObject({ type: 'pitfall', title: 'session 过期未刷新导致 401' });
    expect(opts).toMatchObject({
      maturity: 'draft',
      consumptionMode: 'signal',
      layer: 'project',
      origin: 'agent',
      source: 'conversation:wu-r3',
    });
    expect(mockScheduleVectorDbSync).toHaveBeenCalled();
  });

  it('(d) 发射 knowledge:extraction 事件：token 计数 + duration + entry ids', async () => {
    mockPromptJson.mockResolvedValue({
      entries: [
        { type: 'pitfall', title: 'session 过期未刷新导致 401', content: '根因: token 刷新逻辑遗漏。责任: Executor。预防: 加中间件统一刷新。', tags: [] },
      ],
    });
    // timestamp 在调用时取（≥ usageMark），模拟 gateway usageLog 增量
    mockGetRecentUsage.mockImplementation(() => [
      { provider: 'knowledge', model: 'deepseek-v4-pro', promptTokens: 1200, completionTokens: 300, totalTokens: 1500, latencyMs: 800, timestamp: Date.now(), success: true },
    ]);
    const { ks, eventEmitter } = createKS();

    await ks.extractFromConversation(MESSAGES, { workUnitId: 'wu-r3' });

    expect(mockAppendJsonl).toHaveBeenCalledTimes(1);
    const [, event] = mockAppendJsonl.mock.calls[0];
    expect(event).toMatchObject({ type: 'knowledge:extraction', source: 'conversation:wu-r3' });
    const payload = JSON.parse(event.payload);
    expect(payload).toMatchObject({
      trigger: 'task-complete',
      workUnitId: 'wu-r3',
      entryCount: 1,
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500,
    });
    expect(payload.entryIds).toEqual(['ingested-1']);
    expect(typeof payload.durationMs).toBe('number');

    expect(eventEmitter.emit).toHaveBeenCalledWith('knowledge',
      expect.objectContaining({ type: 'extractFromConversation', data: expect.objectContaining({ totalTokens: 1500 }) }),
    );
  });

  it('无 LLM 配置时静默跳过（e2e 降级路径）：不调 LLM、不入库、不记事件', async () => {
    mockIsAvailable.mockReturnValue(false);
    const { ks, ingest } = createKS();

    await expect(ks.extractFromConversation(MESSAGES, { workUnitId: 'wu-r3' })).resolves.not.toThrow();
    expect(mockPromptJson).not.toHaveBeenCalled();
    expect(ingest.ingestEntry).not.toHaveBeenCalled();
    expect(mockAppendJsonl).not.toHaveBeenCalled();
  });

  it('LLM 调用失败被吞掉：不抛出、不入库、不记事件（模板兜底不受影响）', async () => {
    mockPromptJson.mockRejectedValue(new Error('provider down'));
    const { ks, ingest } = createKS();

    await expect(ks.extractFromConversation(MESSAGES, { workUnitId: 'wu-r3' })).resolves.not.toThrow();
    expect(ingest.ingestEntry).not.toHaveBeenCalled();
    expect(mockAppendJsonl).not.toHaveBeenCalled();
  });

  it('空消息 / 全空白消息 → 早退，不调 LLM', async () => {
    const { ks } = createKS();
    await ks.extractFromConversation([], { workUnitId: 'wu-r3' });
    await ks.extractFromConversation([{ role: 'user', content: '   ' }], { workUnitId: 'wu-r3' });
    expect(mockPromptJson).not.toHaveBeenCalled();
  });

  it('LLM 返回空 entries → 仍记提取事件（entryCount=0，成本已发生）', async () => {
    mockPromptJson.mockResolvedValue({ entries: [] });
    const { ks, ingest } = createKS();

    await ks.extractFromConversation(MESSAGES, { workUnitId: 'wu-r3' });
    expect(ingest.ingestEntry).not.toHaveBeenCalled();
    const [, event] = mockAppendJsonl.mock.calls[0];
    expect(JSON.parse(event.payload)).toMatchObject({ entryCount: 0, entryIds: [] });
  });

  it('形态门禁：rule 形态条目被拒绝，不入库', async () => {
    mockPromptJson.mockResolvedValue({
      entries: [
        { type: 'guideline', title: '禁止直连生产库', content: '禁止直连生产数据库', tags: [] },
        { type: 'pitfall', title: 'session 过期未刷新导致 401', content: '根因: token 刷新逻辑遗漏。责任: Executor。预防: 加中间件统一刷新。', tags: [] },
      ],
    });
    const { ks, ingest } = createKS();

    await ks.extractFromConversation(MESSAGES, { workUnitId: 'wu-r3' });
    expect(ingest.ingestEntry).toHaveBeenCalledTimes(1);
    expect(ingest.ingestEntry.mock.calls[0][0].title).toBe('session 过期未刷新导致 401');
  });

  it('linter 高严重度阻断 → 跳过该条', async () => {
    mockPromptJson.mockResolvedValue({
      entries: [
        { type: 'pitfall', title: 'session 过期未刷新导致 401', content: '根因: token 刷新逻辑遗漏。责任: Executor。预防: 加中间件统一刷新。', tags: [] },
      ],
    });
    const { ks, ingest, linter } = createKS();
    linter.validateEntry.mockReturnValue([{ severity: 'high', description: 'too vague', type: 'quality' }]);

    await ks.extractFromConversation(MESSAGES, { workUnitId: 'wu-r3' });
    expect(ingest.ingestEntry).not.toHaveBeenCalled();
  });

  it('非法 type 回落 guideline；超长 transcript 截断到上限', async () => {
    mockPromptJson.mockResolvedValue({
      entries: [
        { type: 'weird-type', title: '某条经验', content: '这是一条足够长的经验内容，用于通过形态门禁检查。', tags: [] },
      ],
    });
    const { ks, ingest } = createKS();

    const longMessages = [
      { role: 'user', content: '头'.repeat(3_000) },
      { role: 'assistant', content: '中'.repeat(9_000) }, // 单条截到 2000
      { role: 'user', content: '尾'.repeat(11_000) },    // 单条截到 2000
    ];
    await ks.extractFromConversation(longMessages, { workUnitId: 'wu-r3' });

    const [transcript] = mockPromptJson.mock.calls[0];
    expect(transcript.length).toBeLessThanOrEqual(12_000 + 200); // 上限 + 标记开销
    expect(ingest.ingestEntry.mock.calls[0][0].type).toBe('guideline');
  });
});

describe('R3: 提案注入闸门（draft 不参与 injectContext）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('(b) rule/context/signal 三档均排除 draft，保留 approved 成熟度', async () => {
    const { ks, query } = createKS();
    query.queryEntries
      .mockResolvedValueOnce([ // rule 档（生产形状：sourceReferences 复数）
        { id: 'r-draft', content: 'Draft rule content here', type: 'guideline', sourceReferences: [{ timestamp: '2026-07-20T00:00:00Z' }], status: 'published', maturity: 'draft' },
        { id: 'r-active', content: 'Active rule content here', type: 'guideline', sourceReferences: [{ timestamp: '2026-07-20T00:00:00Z' }], status: 'published', maturity: 'active' },
      ])
      .mockResolvedValueOnce([ // context 档
        { id: 'c-draft', content: 'Draft preference content', type: 'model', sourceReferences: [{ timestamp: '2026-07-20T00:00:00Z' }], status: 'published', maturity: 'draft' },
        { id: 'c-verified', content: 'Verified preference content', type: 'model', sourceReferences: [{ timestamp: '2026-07-20T00:00:00Z' }], status: 'published', maturity: 'verified' },
      ]);
    query.getIndexes.mockReturnValue([
      { id: 's-draft', summary: 'draft signal', status: 'fresh', maturity: 'draft' },
      { id: 's-proven', summary: 'proven signal', status: 'fresh', maturity: 'proven' },
    ]);

    const result = await ks.injectContext('executor');

    expect(result.injectedIds).toContain('r-active');
    expect(result.injectedIds).toContain('c-verified');
    expect(result.injectedIds).toContain('s-proven');
    expect(result.injectedIds).not.toContain('r-draft');
    expect(result.injectedIds).not.toContain('c-draft');
    expect(result.injectedIds).not.toContain('s-draft');
    expect(result.prompt).not.toContain('Draft rule content');
    expect(result.prompt).not.toContain('Draft preference');
    expect(result.prompt).toContain('Active rule content');
  });

  it('无 maturity 字段的条目（doc 来源）不受闸门影响', async () => {
    const { ks, query } = createKS();
    query.queryEntries
      .mockResolvedValueOnce([{ id: 'r1', content: 'Always use TypeScript', type: 'guideline', sourceReferences: [{ timestamp: '2026-07-20T00:00:00Z' }], status: 'published' }])
      .mockResolvedValueOnce([]);

    const result = await ks.injectContext('executor');
    expect(result.injectedIds).toEqual(['r1']);
  });
});
