/**
 * Event routes unit tests — FileStore mock
 *
 * Covers:
 * - POST /     — create StudioEvent (AC: type+source validation, payload stringify, error)
 * - GET  /     — query StudioEvents (type/since/limit filter, empty, error)
 * - POST /agent-events — batch ingest AgentEvent[] (validation, batch size, session:end trigger)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Router } from 'express';

// ── Hoisted mocks ─────────────────────────────────────────────────────
const mockAppendJsonl = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockReadJsonl = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const mockGenerateSessionSummary = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  FileStore: vi.fn().mockImplementation(function () { return {
    appendJsonl: mockAppendJsonl,
    readJsonl: mockReadJsonl,
  }; }),
}));

vi.mock('../session-summary-generator.js', () => ({
  generateSessionSummary: mockGenerateSessionSummary,
}));

// ── Imports after mocks ───────────────────────────────────────────────
import routes from '../event.routes.js';

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
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendJsonl.mockResolvedValue(undefined);
  });

  it('creates event with type and source, returns 201', async () => {
    const { res } = await invokeRoute(routes, 'post', '/', {
      body: { type: 'test.event', source: 'test-suite', payload: { key: 'value' } },
    });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'test.event', source: 'test-suite' })
    );
    expect(mockAppendJsonl).toHaveBeenCalledOnce();
    const stored = mockAppendJsonl.mock.calls[0][1];
    expect(stored.payload).toBe(JSON.stringify({ key: 'value' }));
  });

  it('returns 400 when type missing', async () => {
    const { res } = await invokeRoute(routes, 'post', '/', {
      body: { source: 'test' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'type and source are required' });
    expect(mockAppendJsonl).not.toHaveBeenCalled();
  });

  it('returns 400 when source missing', async () => {
    const { res } = await invokeRoute(routes, 'post', '/', {
      body: { type: 'test.event' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'type and source are required' });
  });

  it('keeps string payload as-is', async () => {
    const { res } = await invokeRoute(routes, 'post', '/', {
      body: { type: 'str', source: 'test', payload: 'raw-string' },
    });

    expect(res.status).toHaveBeenCalledWith(201);
    const stored = mockAppendJsonl.mock.calls[0][1];
    expect(stored.payload).toBe('raw-string');
  });

  it('D18: 空 payload（缺失 / {} / null）拒绝落盘 → 400', async () => {
    for (const payload of [undefined, {}, null]) {
      vi.clearAllMocks();
      const { res } = await invokeRoute(routes, 'post', '/', {
        body: { type: 'knowledge:consumption', source: 'test', payload },
      });

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'payload must be a non-empty object' });
      expect(mockAppendJsonl).not.toHaveBeenCalled();
    }
  });

  it('D18: 空 payload 字符串 "{}" 同样拒绝', async () => {
    const { res } = await invokeRoute(routes, 'post', '/', {
      body: { type: 'knowledge:consumption', source: 'test', payload: '{}' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockAppendJsonl).not.toHaveBeenCalled();
  });

  it('returns 500 on FileStore error', async () => {
    mockAppendJsonl.mockRejectedValueOnce(new Error('Disk full'));

    const { res } = await invokeRoute(routes, 'post', '/', {
      body: { type: 'err', source: 'test', payload: { key: 'x' } },
    });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to create event' });
  });
});

describe('GET / (query events)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadJsonl.mockResolvedValue([
      { type: 'a', source: 's1', payload: '{}', createdAt: '2026-07-18T10:00:00.000Z' },
      { type: 'b', source: 's2', payload: '{}', createdAt: '2026-07-18T11:00:00.000Z' },
      { type: 'a', source: 's1', payload: '{}', createdAt: '2026-07-18T12:00:00.000Z' },
    ]);
  });

  it('returns all events sorted by createdAt desc', async () => {
    const { res } = await invokeRoute(routes, 'get', '/');

    const { events, total } = res.json.mock.calls[0][0];
    expect(total).toBe(3);
    expect(events[0].createdAt).toBe('2026-07-18T12:00:00.000Z');
    expect(events[2].createdAt).toBe('2026-07-18T10:00:00.000Z');
  });

  it('filters by type', async () => {
    const { res } = await invokeRoute(routes, 'get', '/', {
      query: { type: 'a' },
    });

    const { events } = res.json.mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events.every((e: any) => e.type === 'a')).toBe(true);
  });

  it('filters by since', async () => {
    const { res } = await invokeRoute(routes, 'get', '/', {
      query: { since: '2026-07-18T11:30:00.000Z' },
    });

    const { events } = res.json.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].createdAt).toBe('2026-07-18T12:00:00.000Z');
  });

  it('applies limit param (1-200 clamp)', async () => {
    const { res } = await invokeRoute(routes, 'get', '/', {
      query: { limit: '1' },
    });

    const { events } = res.json.mock.calls[0][0];
    expect(events).toHaveLength(1);
  });

  it('defaults limit to 50', async () => {
    mockReadJsonl.mockResolvedValueOnce(
      Array.from({ length: 70 }, (_, i) => ({
        type: 't',
        source: 's',
        payload: '{}',
        createdAt: new Date(2026, 6, 18, i).toISOString(),
      }))
    );

    const { res } = await invokeRoute(routes, 'get', '/');

    const { events } = res.json.mock.calls[0][0];
    expect(events).toHaveLength(50);
  });

  it('caps limit at 200', async () => {
    const { res } = await invokeRoute(routes, 'get', '/', {
      query: { limit: '999' },
    });

    const { events } = res.json.mock.calls[0][0];
    // 3 events exist, so all returned (caps slice, not truncate to 200)
    expect(events).toHaveLength(3);
  });

  it('returns empty when no events match', async () => {
    mockReadJsonl.mockResolvedValueOnce([]);

    const { res } = await invokeRoute(routes, 'get', '/', {
      query: { type: 'nonexistent' },
    });

    const { events, total } = res.json.mock.calls[0][0];
    expect(events).toHaveLength(0);
    expect(total).toBe(0);
  });

  it('filters by workUnitId（payload.workUnitId 匹配；损坏 payload 行跳过）', async () => {
    mockReadJsonl.mockResolvedValueOnce([
      { type: 'workunit:execution_step', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-1', step: 1 }), createdAt: '2026-07-18T10:00:00.000Z' },
      { type: 'workunit:execution_step', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-2', step: 1 }), createdAt: '2026-07-18T11:00:00.000Z' },
      { type: 'workunit:execution_step', source: 'agent-loop', payload: 'broken-json', createdAt: '2026-07-18T12:00:00.000Z' },
      { type: 'workunit:execution_step', source: 'agent-loop', payload: JSON.stringify({ workUnitId: 'wu-1', step: 2 }), createdAt: '2026-07-18T13:00:00.000Z' },
    ]);

    const { res } = await invokeRoute(routes, 'get', '/', {
      query: { type: 'workunit:execution_step', workUnitId: 'wu-1' },
    });

    const { events } = res.json.mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events.every((e: any) => JSON.parse(e.payload).workUnitId === 'wu-1')).toBe(true);
  });

  it('returns 500 on FileStore error', async () => {
    mockReadJsonl.mockRejectedValueOnce(new Error('Read error'));

    const { res } = await invokeRoute(routes, 'get', '/');

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to query events' });
  });
});

describe('POST /agent-events (batch ingest)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendJsonl.mockResolvedValue(undefined);
  });

  const validEvents = () => [
    { sessionId: 's1', agentId: 'agent-1', timestamp: Date.now(), type: 'session:start' },
    { sessionId: 's1', agentId: 'agent-1', timestamp: Date.now(), type: 'tool:call', payload: { tool: 'Bash' } },
  ];

  it('ingests valid array, returns 201 with count', async () => {
    const { res } = await invokeRoute(routes, 'post', '/agent-events', {
      body: validEvents(),
    });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ ingested: 2 });
    expect(mockAppendJsonl).toHaveBeenCalledTimes(2);
  });

  it('returns 400 when body is not array', async () => {
    const { res } = await invokeRoute(routes, 'post', '/agent-events', {
      body: { not: 'array' },
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Body must be a non-empty AgentEvent[]' });
  });

  it('returns 400 when body is empty array', async () => {
    const { res } = await invokeRoute(routes, 'post', '/agent-events', {
      body: [],
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Body must be a non-empty AgentEvent[]' });
  });

  it('returns 400 when batch exceeds 500', async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      sessionId: `s${i}`, agentId: 'a1', timestamp: Date.now(), type: 'ev',
    }));

    const { res } = await invokeRoute(routes, 'post', '/agent-events', {
      body: many,
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Max 500 events per batch' });
    expect(mockAppendJsonl).not.toHaveBeenCalled();
  });

  it('validates required fields on each event', async () => {
    const { res } = await invokeRoute(routes, 'post', '/agent-events', {
      body: [
        { sessionId: 's1', agentId: 'a1', timestamp: Date.now() },       // missing type
        { sessionId: 's1', timestamp: Date.now(), type: 't' },            // missing agentId
        { agentId: 'a1', timestamp: Date.now(), type: 't' },              // missing sessionId
        { sessionId: 's1', agentId: 'a1', type: 't' },                    // missing timestamp
        { sessionId: 's1', agentId: 'a1', timestamp: 'bad', type: 't' },  // timestamp not number
      ],
    });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Validation failed',
        details: expect.arrayContaining([
          expect.stringContaining('type required'),
          expect.stringContaining('agentId required'),
          expect.stringContaining('sessionId required'),
          expect.stringContaining('timestamp (number) required'),
        ]),
      })
    );
    expect(mockAppendJsonl).not.toHaveBeenCalled();
  });

  it('merges agent payload with sessionId', async () => {
    const events = [
      { sessionId: 's1', agentId: 'a1', timestamp: 1000, type: 'custom', payload: { foo: 'bar' } },
    ];

    await invokeRoute(routes, 'post', '/agent-events', { body: events });

    const stored = mockAppendJsonl.mock.calls[0][1];
    expect(stored.payload).toContain('"sessionId":"s1"');
    expect(stored.payload).toContain('"foo":"bar"');
  });

  it('calls generateSessionSummary for session:end events', async () => {
    const events = [
      { sessionId: 's1', agentId: 'a1', timestamp: Date.now(), type: 'session:end' },
    ];

    await invokeRoute(routes, 'post', '/agent-events', { body: events });

    expect(mockGenerateSessionSummary).toHaveBeenCalledWith('s1');
    expect(mockGenerateSessionSummary).toHaveBeenCalledTimes(1);
  });

  it('does NOT call generateSessionSummary for non-session-end events', async () => {
    const events = [
      { sessionId: 's1', agentId: 'a1', timestamp: Date.now(), type: 'tool:call' },
    ];

    await invokeRoute(routes, 'post', '/agent-events', { body: events });

    expect(mockGenerateSessionSummary).not.toHaveBeenCalled();
  });

  it('returns 500 on FileStore error', async () => {
    mockAppendJsonl.mockRejectedValueOnce(new Error('IO error'));

    const { res } = await invokeRoute(routes, 'post', '/agent-events', {
      body: validEvents(),
    });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to ingest agent events' });
  });
});
