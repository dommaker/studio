/**
 * sse.routes topic 映射单测
 *  - getTopicFromEventType 纯前缀映射：event_type → SSE topic
 *  - requirement.* → requirements（REQ chips SSE 驱动的路由依据）
 *  - workunit.* （含 workunit.tokens / workunit.execution.step）→ workunits
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { eventBus } from '@dommaker/studio-shared';
import sseRouter, { getTopicFromEventType } from '../sse.routes.js';

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

// ── #324：SSE 直订 eventBus + 背压断开慢客户端 ──
// 驱动方式：express Router.handle + 假 req/res（同 outbound-notify 测试的轻量思路，
// 但不起真 HTTP 服务——背压由 res.write 返回值模拟，真 socket 不可靠复现）。
describe('SSE /stream 背压（#324）', () => {
  interface FakeClient {
    req: EventEmitter & Record<string, unknown>;
    res: { writeHead: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    writes: string[];
    /** 置 true 后 write 返回 false（模拟慢客户端缓冲区满） */
    slow: { value: boolean };
  }

  const connected: FakeClient[] = [];

  function connectClient(): FakeClient {
    const req = new EventEmitter() as FakeClient['req'];
    req.method = 'GET';
    req.url = '/stream?topics=all';
    req.query = { topics: 'all' };
    req.headers = {};
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
    // 正常客户端：收到 id 行 + 匿名 data 行，data 内含 event_type
    const newWrites = normal.writes.slice(normalWritesBefore);
    expect(newWrites.some(w => w === 'id: e-1\n')).toBe(true);
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
});
