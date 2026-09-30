/**
 * events 域契约测试：StudioEventItem/EventSearchResult parity + 请求边界 + 响应壳。
 * 正本 = apps/api/src/modules/events/event.routes.ts + utils/studio-events.ts 写口。
 */

import { describe, it, expect } from 'vitest';
import {
  studioEventItemSchema,
  type StudioEventItem,
  eventSearchResultSchema,
  type EventSearchResult,
  createStudioEventBodySchema,
  createStudioEventResultSchema,
  listStudioEventsQuerySchema,
  agentEventSchema,
  agentEventBatchBodySchema,
  createStudioEventResponseSchema,
  eventSearchResponseSchema,
  ingestAgentEventsResponseSchema,
} from '../events.js';
import * as contractIndex from '../index.js';

const eventRow: StudioEventItem = {
  type: 'workunit:failed',
  source: 'agent-loop',
  level: 'warning',
  payload: '{"workUnitId":"wu-1"}',
  createdAt: '2026-07-18T12:00:00.000Z',
};

describe('studioEventItemSchema', () => {
  it('parity：StudioEventItem fixture 通过校验；扩展键透传（历史行 timestamp 等）', () => {
    expect(studioEventItemSchema.parse(eventRow)).toEqual(eventRow);
    const withExtra = { ...eventRow, timestamp: 123, extra: 'x' };
    expect(studioEventItemSchema.parse(withExtra)).toEqual(withExtra);
    expect(() => studioEventItemSchema.parse({ ...eventRow, type: undefined })).toThrow();
  });

  it('稀疏历史行：仅 type 也可通过（source/level/payload/createdAt 可缺省）', () => {
    expect(studioEventItemSchema.parse({ type: 't' })).toEqual({ type: 't' });
  });
});

describe('eventSearchResultSchema（游标壳）', () => {
  it('parity：EventSearchResult fixture；nextCursor null = 没有更旧的', () => {
    const result: EventSearchResult = { events: [eventRow], total: 1, nextCursor: null };
    expect(eventSearchResultSchema.parse(result)).toEqual(result);
    expect(eventSearchResponseSchema.parse({ data: result }).data.nextCursor).toBeNull();
    expect(() => eventSearchResultSchema.parse({ ...result, nextCursor: undefined })).toThrow();
  });
});

describe('createStudioEventBodySchema', () => {
  it('type/source 必填（原手写 400 收进 zod）；payload 宽松 unknown 可缺省', () => {
    expect(createStudioEventBodySchema.parse({ type: 't', source: 's', payload: { k: 1 } }).type).toBe('t');
    expect(createStudioEventBodySchema.parse({ type: 't', source: 's', payload: 'raw' }).payload).toBe('raw');
    expect(createStudioEventBodySchema.parse({ type: 't', source: 's' }).payload).toBeUndefined();
    expect(() => createStudioEventBodySchema.parse({ source: 's' })).toThrow();
    expect(() => createStudioEventBodySchema.parse({ type: 't' })).toThrow();
    expect(() => createStudioEventBodySchema.parse({ type: '', source: 's' })).toThrow();
  });

  it('201 响应 payload wire 恒为 string', () => {
    const result = { type: 't', source: 's', payload: '{"k":1}', createdAt: '2026-10-01T00:00:00.000Z' };
    expect(createStudioEventResultSchema.parse(result)).toEqual(result);
    expect(createStudioEventResponseSchema.parse({ data: result }).data.source).toBe('s');
  });
});

describe('listStudioEventsQuerySchema', () => {
  it('全字段可选；level/limit 值域放宽到 string（clamp/缺省在 handler）', () => {
    expect(listStudioEventsQuerySchema.parse({})).toEqual({});
    expect(listStudioEventsQuerySchema.parse({ level: 'warning', limit: '50', cursor: 'c1' }).limit).toBe('50');
  });
});

describe('agentEventBatchBodySchema（B9-014）', () => {
  const ev = { sessionId: 's1', agentId: 'a1', timestamp: 1000, type: 'session:start' };

  it('单条四字段必填（原逐条手写校验收进 zod）', () => {
    expect(agentEventSchema.parse(ev)).toEqual(ev);
    expect(() => agentEventSchema.parse({ ...ev, type: undefined })).toThrow();
    expect(() => agentEventSchema.parse({ ...ev, timestamp: 'bad' })).toThrow();
  });

  it('非空数组 + ≤500 上限（原手写 400 收进 zod）', () => {
    expect(agentEventBatchBodySchema.parse([ev])).toHaveLength(1);
    expect(() => agentEventBatchBodySchema.parse([])).toThrow();
    expect(() => agentEventBatchBodySchema.parse({ not: 'array' })).toThrow();
    expect(() => agentEventBatchBodySchema.parse(Array.from({ length: 501 }, () => ev))).toThrow();
    expect(agentEventBatchBodySchema.parse(Array.from({ length: 500 }, () => ev))).toHaveLength(500);
  });

  it('201 响应 { ingested } 壳', () => {
    expect(ingestAgentEventsResponseSchema.parse({ data: { ingested: 2 } }).data.ingested).toBe(2);
  });
});

describe('index.ts 出口', () => {
  it('events 域 schema 经 index 导出', () => {
    expect(contractIndex.studioEventItemSchema).toBeDefined();
    expect(contractIndex.eventSearchResponseSchema).toBeDefined();
    expect(contractIndex.agentEventBatchBodySchema).toBeDefined();
  });
});
