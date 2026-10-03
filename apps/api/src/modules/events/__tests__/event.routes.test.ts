/**
 * Event routes unit tests — FileStore mock
 *
 * Covers:
 * - POST /     — create StudioEvent (AC: type+source validation, payload stringify, error)
 * - GET  /     — query StudioEvents (type/since/limit filter, empty, error)
 * - POST /agent-events — batch ingest AgentEvent[] (validation, batch size, session:end trigger)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from 'express';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * #361：writeStudioEvent/readStudioEvents 实现下沉 @dommaker/studio-shared
 * （内部 FileStore/logger 为相对导入，包级 mock 拦不到）——本文件改为真实写口 +
 * STUDIO_EVENTS_FILE 指向 tmp 隔离文件，POST 系断言从磁盘行读取。
 */
// ── Hoisted mocks ─────────────────────────────────────────────────────
const mockGenerateSessionSummary = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  };
});

vi.mock('../session-summary-generator.js', () => ({
  generateSessionSummary: mockGenerateSessionSummary,
}));

// ── Imports after mocks ───────────────────────────────────────────────
import { eventOpenRoutes, eventWriteRoutes } from '../event.routes.js';

// ── Helpers (auth/routes.test.ts pattern) ─────────────────────────────

function createReq(overrides: Record<string, any> = {}) {
  return {
    method: 'POST',
    url: '/',
    headers: { 'content-type': 'application/json' },
    body: {},
    ip: '127.0.0.1',
    query: {},
    params: {},
    cookies: {},
    socket: { remoteAddress: '127.0.0.1' },
    get: () => undefined,
    ...overrides,
  };
}

function createRes() {
  const json = vi.fn();
  const res: Record<string, any> = {
    status: vi.fn(() => res),
    json,
  };
  return res as any;
}

function getHandlers(router: Router, method: string, path: string): Function[] {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack.map((l: any) => l.handle);
    }
  }
  throw new Error(`Handler not found: ${method} ${path}`);
}

async function invokeRoute(
  router: Router,
  method: string,
  path: string,
  reqOverrides: Record<string, any> = {}
) {
  const handlers = getHandlers(router, method, path);
  const req = createReq(reqOverrides);
  const res = createRes();
  let i = 0;
  const next = async () => {
    if (i < handlers.length) {
      await handlers[i++](req, res, next);
    }
  };
  await next();
  return { req, res };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('POST / (create event)', () => {
  let tmpDir: string;
  let eventsFile: string;

  const writtenRows = async (): Promise<Array<Record<string, unknown>>> =>
    (await fs.readFile(eventsFile, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'event-routes-post-'));
    eventsFile = path.join(tmpDir, 'studio-events.jsonl');
    process.env.STUDIO_EVENTS_FILE = eventsFile;
  });

  afterEach(async () => {
    delete process.env.STUDIO_EVENTS_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates event with type and source, returns 201', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/', {
      body: { type: 'test.event', source: 'test-suite', payload: { key: 'value' } },
    });

    expect(res.status).toHaveBeenCalledWith(201);
    // 契约驱动迁移（批次 5/7）：响应统一 `{ data }` 壳
    expect(res.json.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ type: 'test.event', source: 'test-suite' })
    );
    const rows = await writtenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('test.event');
    expect(rows[0].source).toBe('test-suite');
    expect(rows[0].payload).toBe(JSON.stringify({ key: 'value' }));
  });

  it('returns 400 when type missing', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/', {
      body: { source: 'test' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    // 手写 guard 收进 zod：错误统一 `{ error: { code, message } }`，文案变 zod 格式
    expect(res.json.mock.calls[0][0].error.code).toBe('BAD_REQUEST');
    expect(res.json.mock.calls[0][0].error.message).toContain('type');
  });

  it('returns 400 when source missing', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/', {
      body: { type: 'test.event' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('BAD_REQUEST');
    expect(res.json.mock.calls[0][0].error.message).toContain('source');
  });

  it('keeps string payload as-is', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/', {
      body: { type: 'str', source: 'test', payload: 'raw-string' },
    });

    expect(res.status).toHaveBeenCalledWith(201);
    const rows = await writtenRows();
    expect(rows[0].payload).toBe('raw-string');
  });

  it('D18: 空 payload（缺失 / {} / null）拒绝落盘 → 400', async () => {
    for (const payload of [undefined, {}, null]) {
      vi.clearAllMocks();
      const { res } = await invokeRoute(eventWriteRoutes, 'post', '/', {
        body: { type: 'knowledge:consumption', source: 'test', payload },
      });

      expect(res.status).toHaveBeenCalledWith(400);
      // D18 语义保留 handler 显式拒绝（HttpError），文案不变
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'BAD_REQUEST', message: 'payload must be a non-empty object' },
      });
    }
  });

  it('D18: 空 payload 字符串 "{}" 同样拒绝', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/', {
      body: { type: 'knowledge:consumption', source: 'test', payload: '{}' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    await expect(fs.access(eventsFile)).rejects.toBeTruthy();
  });

  it('returns 500 when 写盘失败（事件路径指向普通文件，mkdir ENOTDIR）', async () => {
    const blocker = path.join(tmpDir, 'blocker');
    await fs.writeFile(blocker, 'not a dir');
    process.env.STUDIO_EVENTS_FILE = path.join(blocker, 'events.jsonl');

    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/', {
      body: { type: 'err', source: 'test', payload: { key: 'x' } },
    });

    expect(res.status).toHaveBeenCalledWith(500);
    // 写盘被拒保留 HttpError 显式文案
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL', message: 'Failed to create event' },
    });
  });
});

describe('GET / (query events)', () => {
  // #180 缝升级：GET 改走尾部倒读（studio-events-tail），测试用真临时文件 + STUDIO_EVENTS_FILE 覆盖
  let tmpDir: string;
  let eventsFile: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'event-routes-test-'));
    eventsFile = path.join(tmpDir, 'studio-events.jsonl');
    process.env.STUDIO_EVENTS_FILE = eventsFile;
  });

  afterEach(async () => {
    delete process.env.STUDIO_EVENTS_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seed(lines: Array<Record<string, unknown>>): Promise<void> {
    await fs.writeFile(eventsFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  const baseLines = () => [
    { type: 'a', source: 's1', payload: '{}', createdAt: '2026-07-18T10:00:00.000Z' },
    { type: 'b', source: 's2', payload: '{}', createdAt: '2026-07-18T11:00:00.000Z' },
    { type: 'a', source: 's1', payload: '{}', createdAt: '2026-07-18T12:00:00.000Z' },
  ];

  it('#60 决策 Q3a：GET / 需登录（P2-e 起 requireAuth 挂 route-registry entry，路由栈不再含鉴权；姿态锁定见 __tests__/route-registry-auth.test.ts）', () => {
    // 路由栈只剩 defineRoute 单 handler（鉴权已上移 registry，不在栈内）
    expect(getHandlers(eventOpenRoutes, 'get', '/').length).toBe(1);
  });

  it('returns all events sorted by createdAt desc, nextCursor null', async () => {
    await seed(baseLines());
    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/');

    const { events, total, nextCursor } = res.json.mock.calls[0][0].data;
    expect(total).toBe(3);
    expect(events[0].createdAt).toBe('2026-07-18T12:00:00.000Z');
    expect(events[2].createdAt).toBe('2026-07-18T10:00:00.000Z');
    expect(nextCursor).toBeNull();
  });

  it('filters by type', async () => {
    await seed(baseLines());
    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/', {
      query: { type: 'a' },
    });

    const { events } = res.json.mock.calls[0][0].data;
    expect(events).toHaveLength(2);
    expect(events.every((e: any) => e.type === 'a')).toBe(true);
  });

  it('filters by since', async () => {
    await seed(baseLines());
    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/', {
      query: { since: '2026-07-18T11:30:00.000Z' },
    });

    const { events } = res.json.mock.calls[0][0].data;
    expect(events).toHaveLength(1);
    expect(events[0].createdAt).toBe('2026-07-18T12:00:00.000Z');
  });

  it('#180: filters by until（只返回不晚于 until 的事件）', async () => {
    await seed(baseLines());
    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/', {
      query: { until: '2026-07-18T11:30:00.000Z' },
    });

    const { events } = res.json.mock.calls[0][0].data;
    expect(events).toHaveLength(2);
    expect(events[0].createdAt).toBe('2026-07-18T11:00:00.000Z');
  });

  it('#180: level 默认 ≥info —— debug 事件默认隐藏，level=debug 全返回', async () => {
    await seed([
      { type: 'knowledge:skill_used', source: 's', level: 'debug', payload: '{}', createdAt: '2026-07-18T10:00:00.000Z' },
      { type: 'workunit:failed', source: 's', level: 'warning', payload: '{}', createdAt: '2026-07-18T11:00:00.000Z' },
      { type: 'workunit:closed', source: 's', payload: '{}', createdAt: '2026-07-18T12:00:00.000Z' },
    ]);

    const def = await invokeRoute(eventOpenRoutes, 'get', '/');
    const defEvents = def.res.json.mock.calls[0][0].data.events;
    expect(defEvents).toHaveLength(2);
    expect(defEvents.every((e: any) => e.type !== 'knowledge:skill_used')).toBe(true);

    const dbg = await invokeRoute(eventOpenRoutes, 'get', '/', { query: { level: 'debug' } });
    expect(dbg.res.json.mock.calls[0][0].data.events).toHaveLength(3);
  });

  it('#180: level=warning 只返回 warning/critical（无 level 字段的 info 被滤掉）', async () => {
    await seed([
      { type: 'knowledge:skill_used', source: 's', level: 'debug', payload: '{}', createdAt: '2026-07-18T10:00:00.000Z' },
      { type: 'workunit:closed', source: 's', payload: '{}', createdAt: '2026-07-18T11:00:00.000Z' },
      { type: 'workunit:failed', source: 's', level: 'warning', payload: '{}', createdAt: '2026-07-18T12:00:00.000Z' },
    ]);

    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/', { query: { level: 'warning' } });
    const { events } = res.json.mock.calls[0][0].data;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('workunit:failed');
  });

  it('#180: keyword 过滤（type/source/payload 大小写不敏感子串）', async () => {
    await seed([
      { type: 'workunit:failed', source: 'agent-loop', payload: JSON.stringify({ blockReason: 'Verify FAILED: tsc' }), createdAt: '2026-07-18T10:00:00.000Z' },
      { type: 'workunit:closed', source: 'agent-loop', payload: JSON.stringify({ summary: 'done' }), createdAt: '2026-07-18T11:00:00.000Z' },
      { type: 'monitor:alert', source: 'watchdog', payload: JSON.stringify({ message: 'disk low' }), createdAt: '2026-07-18T12:00:00.000Z' },
    ]);

    const byPayload = await invokeRoute(eventOpenRoutes, 'get', '/', { query: { keyword: 'verify failed' } });
    expect(byPayload.res.json.mock.calls[0][0].data.events).toHaveLength(1);
    expect(byPayload.res.json.mock.calls[0][0].data.events[0].type).toBe('workunit:failed');

    const byType = await invokeRoute(eventOpenRoutes, 'get', '/', { query: { keyword: 'monitor' } });
    expect(byType.res.json.mock.calls[0][0].data.events).toHaveLength(1);

    const noHit = await invokeRoute(eventOpenRoutes, 'get', '/', { query: { keyword: 'nonexistent-keyword' } });
    expect(noHit.res.json.mock.calls[0][0].data.events).toHaveLength(0);
  });

  it('#180: 游标分页替代 200 硬顶 —— 三页扫完无重叠，末页 nextCursor null', async () => {
    await seed(Array.from({ length: 5 }, (_, i) => ({
      type: 't', source: 's', payload: '{}',
      createdAt: `2026-07-18T${String(10 + i).padStart(2, '0')}:00:00.000Z`,
    })));

    const p1 = await invokeRoute(eventOpenRoutes, 'get', '/', { query: { limit: '2' } });
    const b1 = p1.res.json.mock.calls[0][0].data;
    expect(b1.events).toHaveLength(2);
    expect(b1.nextCursor).not.toBeNull();

    const p2 = await invokeRoute(eventOpenRoutes, 'get', '/', { query: { limit: '2', cursor: b1.nextCursor } });
    const b2 = p2.res.json.mock.calls[0][0].data;
    expect(b2.events).toHaveLength(2);
    expect(b2.nextCursor).not.toBeNull();

    const p3 = await invokeRoute(eventOpenRoutes, 'get', '/', { query: { limit: '2', cursor: b2.nextCursor } });
    const b3 = p3.res.json.mock.calls[0][0].data;
    expect(b3.events).toHaveLength(1);
    expect(b3.nextCursor).toBeNull();

    const all = [...b1.events, ...b2.events, ...b3.events].map((e: any) => e.createdAt);
    expect(new Set(all).size).toBe(5); // 无重叠
  });

  it('applies limit param (1-200 clamp)', async () => {
    await seed(baseLines());
    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/', {
      query: { limit: '1' },
    });

    const { events } = res.json.mock.calls[0][0].data;
    expect(events).toHaveLength(1);
  });

  it('defaults limit to 50', async () => {
    await seed(Array.from({ length: 70 }, (_, i) => ({
      type: 't', source: 's', payload: '{}',
      createdAt: new Date(2026, 6, 18, Math.floor(i / 24), i % 60).toISOString(),
    })));

    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/');

    const { events, nextCursor } = res.json.mock.calls[0][0].data;
    expect(events).toHaveLength(50);
    expect(nextCursor).not.toBeNull(); // 还有 20 条更旧的
  });

  it('returns empty when no events match', async () => {
    await seed(baseLines());
    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/', {
      query: { type: 'nonexistent' },
    });

    const { events, total } = res.json.mock.calls[0][0].data;
    expect(events).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('filters by workUnitId（payload.workUnitId 匹配；损坏 payload 行跳过）', async () => {
    await fs.writeFile(eventsFile, [
      JSON.stringify({ type: 'workunit:execution_step', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-1', step: 1 }), createdAt: '2026-07-18T10:00:00.000Z' }),
      JSON.stringify({ type: 'workunit:execution_step', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-2', step: 1 }), createdAt: '2026-07-18T11:00:00.000Z' }),
      'broken-json',
      JSON.stringify({ type: 'workunit:execution_step', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-1', step: 2 }), createdAt: '2026-07-18T13:00:00.000Z' }),
    ].join('\n') + '\n');

    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/', {
      query: { type: 'workunit:execution_step', workUnitId: 'wu-1' },
    });

    const { events } = res.json.mock.calls[0][0].data;
    expect(events).toHaveLength(2);
    expect(events.every((e: any) => JSON.parse(e.payload).workUnitId === 'wu-1')).toBe(true);
  });

  it('returns 500 on read error（事件文件路径指向目录）', async () => {
    process.env.STUDIO_EVENTS_FILE = tmpDir; // 目录：open 成功、read 抛 EISDIR

    const { res } = await invokeRoute(eventOpenRoutes, 'get', '/');

    expect(res.status).toHaveBeenCalledWith(500);
    // 错误壳统一：500 文案由固定串变为实际错误消息
    expect(res.json.mock.calls[0][0].error.code).toBe('INTERNAL');
  });
});

describe('POST /agent-events (batch ingest)', () => {
  let tmpDir: string;
  let eventsFile: string;

  const writtenRows = async (): Promise<Array<Record<string, unknown>>> =>
    (await fs.readFile(eventsFile, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'event-routes-agent-'));
    eventsFile = path.join(tmpDir, 'studio-events.jsonl');
    process.env.STUDIO_EVENTS_FILE = eventsFile;
  });

  afterEach(async () => {
    delete process.env.STUDIO_EVENTS_FILE;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const validEvents = () => [
    { sessionId: 's1', agentId: 'agent-1', timestamp: Date.now(), type: 'session:start' },
    { sessionId: 's1', agentId: 'agent-1', timestamp: Date.now(), type: 'tool:call', payload: { tool: 'Bash' } },
  ];

  it('ingests valid array, returns 201 with count', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/agent-events', {
      body: validEvents(),
    });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ data: { ingested: 2 } });
    const rows = await writtenRows();
    expect(rows.map((r) => r.type)).toEqual(['session:start', 'tool:call']);
  });

  it('returns 400 when body is not array', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/agent-events', {
      body: { not: 'array' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    // 手写 guard 收进 zod：错误统一 `{ error: { code, message } }`，文案变 zod 格式
    expect(res.json.mock.calls[0][0].error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when body is empty array', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/agent-events', {
      body: [],
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('BAD_REQUEST');
  });

  it('returns 400 when batch exceeds 500', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      sessionId: `s${i}`, agentId: 'a1', timestamp: Date.now(), type: 'ev',
    }));

    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/agent-events', {
      body: many,
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error.code).toBe('BAD_REQUEST');
  });

  it('validates required fields on each event', async () => {
    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/agent-events', {
      body: [
        { sessionId: 's1', agentId: 'a1', timestamp: Date.now() },       // missing type
        { sessionId: 's1', timestamp: Date.now(), type: 't' },            // missing agentId
        { agentId: 'a1', timestamp: Date.now(), type: 't' },              // missing sessionId
        { sessionId: 's1', agentId: 'a1', type: 't' },                    // missing timestamp
        { sessionId: 's1', agentId: 'a1', timestamp: 'bad', type: 't' },  // timestamp not number
      ],
    });

    expect(res.status).toHaveBeenCalledWith(400);
    // 「Validation failed + details[]」聚合错误体退役为 zod 首错格式（首条缺 type）
    expect(res.json.mock.calls[0][0].error.code).toBe('BAD_REQUEST');
    expect(res.json.mock.calls[0][0].error.message).toContain('type');
  });

  it('merges agent payload with sessionId', async () => {
    const events = [
      { sessionId: 's1', agentId: 'a1', timestamp: 1000, type: 'custom', payload: { foo: 'bar' } },
    ];

    await invokeRoute(eventWriteRoutes, 'post', '/agent-events', { body: events });

    const rows = await writtenRows();
    expect(rows[0].source).toBe('a1');
    expect(String(rows[0].payload)).toContain('"sessionId":"s1"');
    expect(String(rows[0].payload)).toContain('"foo":"bar"');
  });

  it('calls generateSessionSummary for session:end events', async () => {
    const events = [
      { sessionId: 's1', agentId: 'a1', timestamp: Date.now(), type: 'session:end' },
    ];

    await invokeRoute(eventWriteRoutes, 'post', '/agent-events', { body: events });

    expect(mockGenerateSessionSummary).toHaveBeenCalledWith('s1');
    expect(mockGenerateSessionSummary).toHaveBeenCalledTimes(1);
  });

  it('does NOT call generateSessionSummary for non-session-end events', async () => {
    const events = [
      { sessionId: 's1', agentId: 'a1', timestamp: Date.now(), type: 'tool:call' },
    ];

    await invokeRoute(eventWriteRoutes, 'post', '/agent-events', { body: events });

    expect(mockGenerateSessionSummary).not.toHaveBeenCalled();
  });

  it('returns 500 when 写盘失败（事件路径指向普通文件，mkdir ENOTDIR）', async () => {
    const blocker = path.join(tmpDir, 'blocker');
    await fs.writeFile(blocker, 'not a dir');
    process.env.STUDIO_EVENTS_FILE = path.join(blocker, 'events.jsonl');

    const { res } = await invokeRoute(eventWriteRoutes, 'post', '/agent-events', {
      body: validEvents(),
    });

    expect(res.status).toHaveBeenCalledWith(500);
    // 错误壳统一：500 文案由固定串变为实际错误消息
    expect(res.json.mock.calls[0][0].error.code).toBe('INTERNAL');
  });
});
