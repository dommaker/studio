// useChannelList — 频道列表数据 hook（ChannelHomeRedirect 与 ChannelRail 共用）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockGet, mockPost, mockOnEvent } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockOnEvent: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockGet, post: mockPost },
}));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({ onEvent: mockOnEvent }),
}));

import { useChannelList } from '../useChannelList';
import { useRosterStore } from '../../stores/rosterStore';
import type { ChannelListItem } from '../useChannelList';

const CHANNELS = [
  { id: 'ch-1', name: 'rnd-主研发', type: 'rnd', createdAt: '2026-07-01T00:00:00Z' },
  { id: 'ch-2', name: 'decision-架构决策', type: 'decision', createdAt: '2026-07-01T00:00:00Z' },
];

describe('useChannelList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // #346：channels 切片在 rosterStore（模块级单例），每测重置
    useRosterStore.setState({
      profiles: [], agents: [], channels: [],
      loading: false, error: null, forbidden: false,
      loadedAt: null, channelsLoadedOnce: false, agentsLoadedOnce: false,
      inflight: null, lastToken: null,
    });
    mockGet.mockResolvedValue({ data: { data: CHANNELS } });
    mockOnEvent.mockReturnValue(() => {});
  });

  it('loads channel list on mount', async () => {
    const { result } = renderHook(() => useChannelList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGet).toHaveBeenCalledWith('/channels');
    expect(result.current.channels).toHaveLength(2);
    expect(result.current.channels[0].name).toBe('rnd-主研发');
  });

  it('increments unread count on SSE channel.message_sent from non-human authors', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    const { result } = renderHook(() => useChannelList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-1', message: { authorType: 'agent' } } });
    });
    expect(result.current.unreadCounts['ch-1']).toBe(1);

    act(() => {
      handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-1', message: { authorType: 'agent' } } });
    });
    expect(result.current.unreadCounts['ch-1']).toBe(2);
  });

  it('ignores human-authored messages and other event types for unread', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    const { result } = renderHook(() => useChannelList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-1', message: { authorType: 'human' } } });
      handler!({ event_type: 'channel.message_updated', data: { channelId: 'ch-2' } });
    });
    expect(result.current.unreadCounts['ch-1']).toBeUndefined();
    expect(result.current.unreadCounts['ch-2']).toBeUndefined();
  });

  it('clearUnread removes the counter for a channel', async () => {
    let handler: ((msg: unknown) => void) | null = null;
    mockOnEvent.mockImplementation((h: (msg: unknown) => void) => { handler = h; return () => {}; });
    const { result } = renderHook(() => useChannelList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      handler!({ event_type: 'channel.message_sent', data: { channelId: 'ch-1', message: { authorType: 'agent' } } });
    });
    expect(result.current.unreadCounts['ch-1']).toBe(1);

    act(() => result.current.clearUnread('ch-1'));
    expect(result.current.unreadCounts['ch-1']).toBeUndefined();
  });

  it('createChannel posts payload and appends the new channel', async () => {
    const created = { id: 'ch-3', name: 'ops-监控', type: 'system', createdAt: '2026-07-20T00:00:00Z' };
    mockPost.mockResolvedValue({ data: { data: created } });
    const { result } = renderHook(() => useChannelList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ch: ChannelListItem;
    await act(async () => {
      ch = await result.current.createChannel({ name: 'ops-监控', type: 'system', agents: ['Watcher', 'Alerter'] });
    });
    expect(mockPost).toHaveBeenCalledWith('/channels', {
      name: 'ops-监控',
      type: 'system',
      agents: [{ name: 'Watcher' }, { name: 'Alerter' }],
    });
    expect(ch.id).toBe('ch-3');
    expect(result.current.channels.map(c => c.id)).toContain('ch-3');
  });

  it('createChannel omits agents key when no agent names given', async () => {
    const created = { id: 'ch-4', name: 'x', type: 'rnd', createdAt: '' };
    mockPost.mockResolvedValue({ data: { data: created } });
    const { result } = renderHook(() => useChannelList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.createChannel({ name: 'x', type: 'rnd', agents: [] });
    });
    expect(mockPost).toHaveBeenCalledWith('/channels', { name: 'x', type: 'rnd' });
  });
});
