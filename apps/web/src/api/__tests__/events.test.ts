// Contract test: Events API client — #180 事件检索（#60 决策 Q3a）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: { events: [], total: 0, nextCursor: null } }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { eventsApi } from '../events';
import { api } from '../index';

describe('eventsApi', () => {
  it('search 透传过滤参数到 GET /events', async () => {
    await eventsApi.search({ type: 'workunit:failed', level: 'warning', keyword: 'tsc', until: '2026-08-01T00:00:00.000Z', limit: 50 });
    expect(api.get).toHaveBeenCalledWith('/events', {
      params: { type: 'workunit:failed', level: 'warning', keyword: 'tsc', until: '2026-08-01T00:00:00.000Z', limit: 50 },
    });
  });

  it('search 带 cursor 翻页', async () => {
    await eventsApi.search({ level: 'info', limit: 50, cursor: '1234' });
    expect(api.get).toHaveBeenCalledWith('/events', {
      params: { level: 'info', limit: 50, cursor: '1234' },
    });
  });
});
