/**
 * sse.routes topic 映射单测
 *  - getTopicFromEventType 纯前缀映射：event_type → SSE topic
 *  - requirement.* → requirements（REQ chips SSE 驱动的路由依据）
 *  - workunit.* （含 workunit.tokens / workunit.execution.step）→ workunits
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { eventBus } from '@dommaker/studio-shared';
import sseRouter, { getTopicFromEventType, sseReplayBuffer } from '../sse.routes.js';

describe('getTopicFromEventType', () => {
  it('requirement.created / requirement.updated → requirements', () => {
    expect(getTopicFromEventType('requirement.created')).toBe('requirements');
    expect(getTopicFromEventType('requirement.updated')).toBe('requirements');
  });

  it('workunit.* 一族 → workunits（含 workunit.tokens 与 execution step/stream）', () => {
    expect(getTopicFromEventType('workunit.created')).toBe('workunits');
    expect(getTopicFromEventType('workunit.status_changed')).toBe('workunits');
    expect(getTopicFromEventType('workunit.tokens')).toBe('workunits');
    expect(getTopicFromEventType('workunit.execution.step')).toBe('workunits');
    expect(getTopicFromEventType('workunit.execution.stream')).toBe('workunits');
  });

  it('既有前缀映射不变；未知 → all', () => {
    expect(getTopicFromEventType('execution.started')).toBe('executions');
    expect(getTopicFromEventType('runtime.tick')).toBe('executions');
    expect(getTopicFromEventType('channel.message_created')).toBe('channels');
    expect(getTopicFromEventType('knowledge.extracted')).toBe('knowledge');
    expect(getTopicFromEventType('something.else')).toBe('all');
  });
});

// ── 共享脚手架：express Router.handle + 假 req/res（不起真 HTTP 服务——
// 背压由 res.write 返回值模拟，真 socket 不可靠复现）──
interface FakeClient {
  req: EventEmitter & Record<string, unknown>;
  res: { writeHead: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  writes: string[];
  /** 置 true 后 write 返回 false（模拟慢客户端缓冲区满） */
  slow: { value: boolean };
}

const connected: FakeClient[] = [];

function connectClient(headers: Record<string, string> = {}, topics = 'all'): FakeClient {
  const req = new EventEmitter() as FakeClient['req'];
  req.method = 'GET';
  req.url = `/stream?topics=${topics}`;
  req.query = { topics };
  req.headers = headers;
  req.app = {};
  const client: FakeClient = {
    req,
    writes: [],
    slow: { value: false },
    res: {
      writeHead: vi.fn(),
      write: vi.fn((chunk: string) => { client.writes.push(chunk); return !client.slow.value; }),
      end: vi.fn(),
    },
  };
  (sseRouter as unknown as { handle: (q: unknown, s: unknown, n: () => void) => void }).handle(req, client.res, () => {});
  connected.push(client);
  return client;
}

afterEach(() => {
  // 触发 req close 清理 heartbeat interval 与 clients Map（防句柄泄漏）
  for (const c of connected.splice(0)) c.req.emit('close');
});

/** 把 writes 里的 `id:` + `data:` 行配成帧（heartbeat 注释行无 id 自动跳过） */
function extractFrames(client: FakeClient): { id: string; data: Record<string, unknown> }[] {
  const frames: { id: string; data: Record<string, unknown> }[] = [];
  for (let i = 0; i < client.writes.length; i++) {
    const m = /^id: (.+)\n$/.exec(client.writes[i]);
    if (m && client.writes[i + 1]?.startsWith('data: ')) {
      frames.push({ id: m[1], data: JSON.parse(client.writes[i + 1].slice('data: '.length).trim()) });
    }
  }
  return frames;
}

// ── #324：SSE 直订 eventBus + 背压断开慢客户端 ──
describe('SSE /stream 背压（#324）', () => {
  it('write 返回 false 的慢客户端被断开并移除，正常客户端照常收到事件', () => {
    const normal = connectClient();
    const slow = connectClient();
    // 连接事件已送达（write 当时返回 true）
    expect(normal.writes.some(w => w.startsWith('data:'))).toBe(true);
    expect(slow.writes.some(w => w.startsWith('data:'))).toBe(true);

    slow.slow.value = true; // 此后 write 返回 false
    const normalWritesBefore = normal.writes.length;
    const slowWritesBefore = slow.writes.length;

    eventBus.publish('events', {
      event_type: 'task.updated', event_id: 'e-1',
      timestamp: '2026-08-25T00:00:00Z', data: { taskId: 't-1' },
    });

    // 慢客户端：res.end 被调、之后不再收到写出
    expect(slow.res.end).toHaveBeenCalledTimes(1);
    // 正常客户端：收到 id 行（#491 起 = 服务端单调 seq，不再是信封 event_id）+ 匿名 data 行
    const newWrites = normal.writes.slice(normalWritesBefore);
    const idLine = newWrites.find(w => /^id: \d+\n$/.test(w));
    expect(idLine).toBeDefined();
    const dataLine = newWrites.find(w => w.startsWith('data: '));
    expect(dataLine).toBeDefined();
    expect(JSON.parse(dataLine!.slice('data: '.length).trim()).event_type).toBe('task.updated');

    // 慢客户端已从 clients 移除：再发事件它不再有写出
    eventBus.publish('events', {
      event_type: 'task.updated', event_id: 'e-2',
      timestamp: '2026-08-25T00:00:01Z', data: { taskId: 't-2' },
    });
    expect(slow.writes.length).toBe(slowWritesBefore + 1); // 仅 e-1 那次 write 过（返回 false）
    expect(normal.writes.length).toBeGreaterThan(normalWritesBefore + 2);
  });

  it('慢客户端断开后 heartbeat interval 一并清除（不 write-after-end）', () => {
    vi.useFakeTimers();
    try {
      const slow = connectClient();
      slow.slow.value = true;
      eventBus.publish('events', {
        event_type: 'task.updated', event_id: 'e-3',
        timestamp: '2026-08-25T00:00:02Z', data: { taskId: 't-3' },
      });
      expect(slow.res.end).toHaveBeenCalledTimes(1);

      const writesBefore = slow.writes.length;
      vi.advanceTimersByTime(60_000); // 两个 heartbeat 周期
      expect(slow.writes.length).toBe(writesBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── B6（2026-09-16 channel 性能审计）：广播循环每事件只序列化一次 ──
describe('SSE 广播序列化一次（B6）', () => {
  it('同一事件向多个订阅客户端广播，JSON.stringify 只调用一次（不逐客户端重复）', () => {
    connectClient();
    connectClient();
    connectClient();
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      eventBus.publish('events', {
        event_type: 'task.updated', event_id: 'e-b6',
        timestamp: '2026-09-16T00:00:00Z', data: { taskId: 't-b6' },
      });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('无订阅客户端的 topic 不序列化（零客户端零成本）', () => {
    connectClient({}, 'channels'); // 只订 channels
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      eventBus.publish('events', {
        event_type: 'task.updated', event_id: 'e-b6b',
        timestamp: '2026-09-16T00:00:00Z', data: { taskId: 't-b6b' },
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── #491：断线窗口事件 replay——重连带 Last-Event-ID 补发窗口内遗漏事件 ──
describe('SSE /stream 断线 replay（#491）', () => {
  function publish(eventType: string, eventId: string, data: Record<string, unknown>) {
    eventBus.publish('events', {
      event_type: eventType, event_id: eventId,
      timestamp: '2026-09-11T00:00:00Z', data,
    });
  }

  it('重连带 last-event-id：断线窗口内事件按序补发（含 channel.message_updated），connection.established 在其后', () => {
    const a = connectClient();
    const cursor = extractFrames(a).at(-1)!.id; // connection.established 的 id = 当前 seq

    publish('channel.message_created', 'ev-c1', { channelId: 'ch-1', message: { id: 'm1' } });
    publish('channel.message_updated', 'ev-u1', { channelId: 'ch-1', messageId: 'm1' });

    const b = connectClient({ 'last-event-id': cursor });
    const frames = extractFrames(b);
    expect(frames).toHaveLength(3);
    expect(frames[0].data.event_type).toBe('channel.message_created');
    expect(frames[1].data.event_type).toBe('channel.message_updated');
    // 按 seq 升序，且 connection.established 殿后（id = currentSeq ≥ 补发事件，游标不回退）
    expect(Number(frames[0].id)).toBeLessThan(Number(frames[1].id));
    expect(Number(frames[1].id)).toBeLessThanOrEqual(Number(frames[2].id));
    expect(frames[2].data.clientId).toBeDefined();
  });

  it('补发按订阅 topics 过滤：不匹配的事件不重放', () => {
    const a = connectClient({}, 'channels');
    const cursor = extractFrames(a).at(-1)!.id;

    publish('channel.message_created', 'ev-c2', { channelId: 'ch-1', message: { id: 'm2' } });
    publish('task.updated', 'ev-t2', { taskId: 't-9' });

    const b = connectClient({ 'last-event-id': cursor }, 'channels');
    const frames = extractFrames(b);
    // 仅 channels 事件 + connection.established
    expect(frames.map(f => f.data.event_type)).toEqual(['channel.message_created', undefined]);
  });

  it('lastEventId 无法解析（旧版 uuid 游标）→ 不补发，仅 connection.established', () => {
    const b = connectClient({ 'last-event-id': 'a1b2c3d4-e5f6-uuid' });
    const frames = extractFrames(b);
    expect(frames).toHaveLength(1);
    expect(frames[0].data.clientId).toBeDefined();
  });

  it('lastEventId 早于 buffer 最老事件（有洞）→ 不补发，由前端 refetch 兜底', () => {
    // 直推 buffer 越过容量制造淘汰（容量 500，推到最老 seq > 2）
    for (let i = 0; i < 600; i++) sseReplayBuffer.push('all', 'task.updated', { i });
    const b = connectClient({ 'last-event-id': '1' });
    const frames = extractFrames(b);
    expect(frames).toHaveLength(1);
    expect(frames[0].data.clientId).toBeDefined();
  });
});

// ── #524 P1-3（#516 项⑥）：stream chunk 不进 500 条共享 replay buffer ──
describe('SSE replay buffer 踢出 stream chunk（#524 P1-3）', () => {
  function publishStream(eventId: string, data: Record<string, unknown>) {
    eventBus.publish('events', {
      event_type: 'workunit.execution.stream', event_id: eventId,
      timestamp: '2026-09-12T00:00:00Z', data,
    });
  }

  it('stream chunk 直播照常送达，但不占 replay buffer seq（未入队）', () => {
    const a = connectClient();
    const before = sseReplayBuffer.currentSeq;

    publishStream('s-1', { workUnitId: 'wu-1', kind: 'text', text: 'hello' });

    const frames = extractFrames(a);
    expect(frames.at(-1)!.data.event_type).toBe('workunit.execution.stream'); // 直播照常
    expect(sseReplayBuffer.currentSeq).toBe(before); // buffer 未被占用
  });

  it('高 stream 负载后重连：关键事件补发齐全（窗口不被 chunk 挤占）', () => {
    const a = connectClient();
    const cursor = extractFrames(a).at(-1)!.id;

    eventBus.publish('events', {
      event_type: 'channel.message_created', event_id: 'ev-k1',
      timestamp: '2026-09-12T00:00:01Z', data: { channelId: 'ch-1', message: { id: 'mk1' } },
    });
    // 600 条 stream chunk（超 500 容量）——若入队会把 ev-k1 挤出窗口
    for (let i = 0; i < 600; i++) publishStream(`s-${i}`, { i });
    eventBus.publish('events', {
      event_type: 'channel.message_updated', event_id: 'ev-k2',
      timestamp: '2026-09-12T00:00:02Z', data: { channelId: 'ch-1', messageId: 'mk1' },
    });

    const b = connectClient({ 'last-event-id': cursor });
    const types = extractFrames(b).map(f => f.data.event_type);
    expect(types).toEqual(['channel.message_created', 'channel.message_updated', undefined]);
  });
});
