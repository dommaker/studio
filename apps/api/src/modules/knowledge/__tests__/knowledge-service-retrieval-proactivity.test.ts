/**
 * E2 检索主动性（断点 G）tests
 *
 * - injectContext：有知识注入时附「何时查知识库」指引（KNOWLEDGE_QUERY_GUIDANCE），
 *   无注入时不附。
 * - semanticSearch：mcp-local-rag 可用性探测（每进程缓存，TTL 5min）；
 *   不可用/查询失败时降级为 store 关键词检索，不再静默返回 []；
 *   store 确实无相关条目时诚实返回 []。
 *
 * child_process 整体 mock：execFile 计数 spawn 次数并模拟 RAG 可用/不可用，
 * execFileSync 置空（knowledge-singletons 模块加载时会 pkill 清理孤儿进程）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock child_process（hoisted，先于模块加载生效）──
const { mockExecFile, mockExecFileSync } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  execFileSync: mockExecFileSync,
}));

import { KnowledgeService, KNOWLEDGE_QUERY_GUIDANCE } from '../knowledge-service.js';

// ── Mock factories（与 knowledge-service.test.ts 同款约定）──

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
  return {
    recordReference: vi.fn(),
    shouldAutoPromote: vi.fn(() => false),
  };
}

function createMockIngest() {
  return {
    ingestEntry: vi.fn((entry: any, opts: any) => ({
      id: `ingested-${Date.now()}`,
      ...entry,
      ...opts,
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

function createMockEventEmitter() {
  return { emit: vi.fn() };
}

function createKS(opts?: { entries?: any[] }) {
  const store = createMockStore(opts?.entries);
  const lifecycle = createMockLifecycle();
  const ingest = createMockIngest();
  const linter = createMockLinter();
  const query = createMockQuery();
  const eventEmitter = createMockEventEmitter();

  const ks = new KnowledgeService({
    store: store as any,
    lifecycle: lifecycle as any,
    ingest: ingest as any,
    linter: linter as any,
    query: query as any,
    eventEmitter: eventEmitter as any,
  });

  return { ks, store, lifecycle, query };
}

/** execFile 回调约定：本模块两个调用点都传 (cmd, args, opts, cb) */
function mockRagAvailable(queryStdout = '[]') {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
    if (args.includes('query')) cb(null, queryStdout, '');
    else cb(null, 'Usage: mcp-local-rag [options] <command>', ''); // --help probe
  });
}

function mockRagUnavailable() {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
    cb(new Error('spawn mcp-local-rag ENOENT'), '', '');
  });
}

function probeCallCount(): number {
  return mockExecFile.mock.calls.filter(c => (c[1] as string[]).includes('--help')).length;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── 指引块注入 ──

describe('E2: injectContext 附「何时查知识库」指引', () => {
  it('signal 档注入时附带指引块（含 MCP 查询入口）', async () => {
    const { ks, query } = createKS();
    query.getIndexes.mockReturnValue([
      { id: 's1', summary: '近期信号：deploy 超时频发', status: 'fresh', maturity: 'active' },
    ]);

    const result = await ks.injectContext('executor');

    expect(result.prompt).toContain('## 近期信号');
    expect(result.prompt).toContain(KNOWLEDGE_QUERY_GUIDANCE);
    expect(result.prompt).toContain('## 何时查知识库');
    expect(result.prompt).toContain('mcp__local-rag__query_documents');
  });

  it('rule 档注入时同样附带指引块', async () => {
    const { ks, query } = createKS();
    query.queryEntries.mockResolvedValueOnce([
      { id: 'r1', content: '禁止直接操作生产库', type: 'guideline', sourceReference: 'ref1', status: 'published' },
    ]);

    const result = await ks.injectContext('executor');

    expect(result.prompt).toContain('## 系统约束');
    expect(result.prompt).toContain(KNOWLEDGE_QUERY_GUIDANCE);
  });

  it('无任何知识注入时不附指引（prompt 为空）', async () => {
    const { ks } = createKS();
    const result = await ks.injectContext('executor');
    expect(result.prompt).toBe('');
    expect(result.prompt).not.toContain(KNOWLEDGE_QUERY_GUIDANCE);
    expect(result.injectedIds).toEqual([]);
  });
});

// ── RAG 可用性探测 + 关键词降级 ──

describe('E2: semanticSearch RAG 探测与降级', () => {
  it('probe 可用：正常走 RAG 查询，TTL 内重复查询只探测一次', async () => {
    mockRagAvailable('[]');
    const { ks } = createKS();

    await ks.semanticSearch('deploy');
    await ks.semanticSearch('deploy');
    await ks.semanticSearch('deploy');

    expect(probeCallCount()).toBe(1); // 3 次查询只探测 1 次
    expect(mockExecFile).toHaveBeenCalledTimes(4); // 首次 probe+query，后续仅 query
  });

  it('probe 不可用：降级关键词检索，返回 store 中匹配条目', async () => {
    mockRagUnavailable();
    const entries = [
      { id: 'k1', title: 'deploy 超时排查', content: 'deploy timeout 时先检查网络与锁竞争', tags: ['pitfall'], maturity: 'active', lastReferenced: new Date().toISOString() },
      { id: 'k2', title: '代码风格规范', content: '缩进与命名约定，与部署无关的内容', tags: ['guideline'], maturity: 'active', lastReferenced: new Date().toISOString() },
    ];
    const { ks } = createKS({ entries });

    const results = await ks.semanticSearch('deploy');

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].entryId).toBe('k1');
    expect(results[0]).toHaveProperty('filePath');
    expect(results[0]).toHaveProperty('score');
    expect(results[0]).toHaveProperty('text');
    // 降级不触发 RAG query spawn（probe 失败即短路）
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(probeCallCount()).toBe(1);
  });

  it('probe 不可用结果被缓存：TTL 内重复查询不再 spawn', async () => {
    mockRagUnavailable();
    const entries = [
      { id: 'k1', title: 'deploy 超时排查', content: 'deploy timeout 时先检查网络与锁竞争', tags: ['pitfall'], maturity: 'active', lastReferenced: new Date().toISOString() },
    ];
    const { ks } = createKS({ entries });

    const first = await ks.semanticSearch('deploy');
    const second = await ks.semanticSearch('deploy');

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(mockExecFile).toHaveBeenCalledTimes(1); // 仅首次探测
  });

  it('probe 可用但 query 失败：降级关键词检索，且 TTL 内后续查询直接走降级', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args.includes('query')) cb(new Error('query timeout'), '', '');
      else cb(null, 'help', '');
    });
    const entries = [
      { id: 'k1', title: 'deploy 超时排查', content: 'deploy timeout 时先检查网络与锁竞争', tags: ['pitfall'], maturity: 'active', lastReferenced: new Date().toISOString() },
    ];
    const { ks } = createKS({ entries });

    const first = await ks.semanticSearch('deploy');
    expect(first.length).toBeGreaterThan(0);
    expect(first[0].entryId).toBe('k1');
    expect(mockExecFile).toHaveBeenCalledTimes(2); // probe + 失败的 query

    const second = await ks.semanticSearch('deploy');
    expect(second.length).toBeGreaterThan(0);
    expect(mockExecFile).toHaveBeenCalledTimes(2); // query 失败后标记不可用，不再 spawn
  });

  it('store 无相关条目：诚实返回 []（不编造）', async () => {
    mockRagUnavailable();
    const entries = [
      { id: 'k1', title: '代码风格规范', content: '缩进与命名约定', tags: ['guideline'], maturity: 'active', lastReferenced: new Date().toISOString() },
    ];
    const { ks } = createKS({ entries });

    const results = await ks.semanticSearch('部署');
    expect(results).toEqual([]);
  });

  it('store 完全为空：诚实返回 []', async () => {
    mockRagUnavailable();
    const { ks } = createKS();
    const results = await ks.semanticSearch('deploy');
    expect(results).toEqual([]);
  });
});
