/**
 * events 域契约测试：事件行/游标壳行为 + 请求边界 + 响应壳。
 * schema 即正本；同名类型为 z.infer alias / import type 同源，由编译期断言锚定，无 parity 互验层。
 */

import { describe, it, expect } from 'vitest';
import {
  studioEventItemSchema,
  type StudioEventItem,
  eventSearchResultSchema,
  createStudioEventBodySchema,
  createStudioEventResultSchema,
  listStudioEventsQuerySchema,
  createStudioEventResponseSchema,
  eventSearchResponseSchema,
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
  it('扩展键透传（历史行 timestamp 等）；缺 type 即拒', () => {
    const withExtra = { ...eventRow, timestamp: 123, extra: 'x' };
    expect(studioEventItemSchema.parse(withExtra)).toEqual(withExtra);
    expect(() => studioEventItemSchema.parse({ ...eventRow, type: undefined })).toThrow();
  });

  it('稀疏历史行：仅 type 也可通过（source/level/payload/createdAt 可缺省）', () => {
    expect(studioEventItemSchema.parse({ type: 't' })).toEqual({ type: 't' });
  });
});

describe('eventSearchResultSchema（游标壳）', () => {
  it('nextCursor null = 没有更旧的；缺 nextCursor 即拒', () => {
    const result = { events: [eventRow], total: 1, nextCursor: null };
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

describe('index.ts 出口', () => {
  it('events 域 schema 经 index 导出', () => {
    expect(contractIndex.studioEventItemSchema).toBeDefined();
    expect(contractIndex.eventSearchResponseSchema).toBeDefined();
  });
});
