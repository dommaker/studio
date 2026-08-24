/**
 * NotificationBell tests — #274 接后端 notifications API + §5.7 跳转优先级
 *
 * 后端持久化通知：挂载拉列表（历史在）、未读计数、单条已读（POST /:id/read）、
 * 全部已读（POST /read-all）；点击按 WU > PMO > 频道跳转（link 解析）。
 * SSE atHuman 实时增量保留：入列、跳转优先级、不产生后端已读调用。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { WebSocketMessage } from '../../api/websocket';

const { mockNavigate, sseHandlers, mockApi } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  sseHandlers: new Set<(msg: unknown) => void>(),
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({
    onEvent: (handler: (msg: unknown) => void) => {
      sseHandlers.add(handler);
      return () => { sseHandlers.delete(handler); };
    },
  }),
}));

vi.mock('../../api', () => ({ api: mockApi }));

import { NotificationBell } from '../NotificationBell';

interface BackendNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  content: string;
  link: string | null;
  createdAt: string;
  read: boolean;
  readAt: string | null;
}

function backendRows(overrides: Partial<BackendNotification>[] = []): BackendNotification[] {
  const base: BackendNotification[] = [
    { id: 'n1', userId: 'u1', type: 'auditor_suggestion', title: '审计建议 (2 项)', content: '建议一 | 建议二', link: '/channels/ch-9', createdAt: '2026-08-18T08:00:00.000Z', read: false, readAt: null },
    { id: 'n2', userId: 'u1', type: 'system', title: '系统通知', content: '已读的一条', link: '/pmo/project/proj-7', createdAt: '2026-08-17T08:00:00.000Z', read: true, readAt: '2026-08-17T09:00:00.000Z' },
  ];
  return base.map((b, i) => ({ ...b, ...(overrides[i] ?? {}) }));
}

function mockList(rows: BackendNotification[]) {
  mockApi.get.mockResolvedValue({ data: rows });
}

interface FakeMessage {
  id: string;
  agentName: string;
  content: string;
  workUnitId?: string | null;
  meta?: { atHuman?: boolean; pmoId?: string } | null;
}

function emitAtHuman(message: FakeMessage, channelId = 'ch-1') {
  const msg: WebSocketMessage = {
    event_id: `evt-${message.id}`,
    event_type: 'channel.message_sent',
    timestamp: new Date().toISOString(),
    data: { channelId, message },
  };
  act(() => {
    sseHandlers.forEach(h => h(msg));
  });
}

function openDropdown() {
  fireEvent.click(screen.getByTitle('通知中心'));
}

async function renderLoaded(rows: BackendNotification[]) {
  mockList(rows);
  render(<NotificationBell />);
  await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith('/notifications'));
}

beforeEach(() => {
  sseHandlers.clear();
  mockNavigate.mockClear();
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

describe('#274 后端持久化通知', () => {
  it('挂载拉取后端列表：历史通知渲染，未读计数 = 未读条数', async () => {
    await renderLoaded(backendRows());
    // 未读角标（n1 未读，n2 已读）
    expect(screen.getByText('1')).toBeInTheDocument();

    openDropdown();
    await waitFor(() => expect(screen.getByText('审计建议 (2 项)')).toBeInTheDocument());
    expect(screen.getByText('系统通知')).toBeInTheDocument();
  });

  it('刷新后历史通知仍在（数据源 = 后端，非内存 SSE）', async () => {
    await renderLoaded(backendRows());
    openDropdown();
    // 无 SSE 事件也有历史列表
    expect(screen.getByText('建议一 | 建议二')).toBeInTheDocument();
  });

  it('后端返回空 → 暂无通知', async () => {
    await renderLoaded([]);
    openDropdown();
    expect(screen.getByText('暂无通知')).toBeInTheDocument();
  });

  it('点击后端通知：标记已读（POST /notifications/:id/read）并按 link 跳转频道', async () => {
    await renderLoaded(backendRows());
    openDropdown();

    fireEvent.click(screen.getByText('审计建议 (2 项)'));
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n1/read');
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-9');
    // 角标清零
    await waitFor(() => expect(screen.queryByText('1')).not.toBeInTheDocument());
  });

  it('link 解析跳转优先级：/workunits/:id > /pmo/project/:id > /channels/:id', async () => {
    await renderLoaded(backendRows([{}, { id: 'n2', link: '/pmo/project/proj-7', read: false }]));
    openDropdown();

    fireEvent.click(screen.getByText('系统通知'));
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-7');
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n2/read');
  });

  it('link 为 /workunits/:id 时跳 WU 详情', async () => {
    await renderLoaded(backendRows([{ id: 'n1', link: '/workunits/wu-3' }]));
    openDropdown();

    fireEvent.click(screen.getByText('审计建议 (2 项)'));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-3');
  });

  it('全部已读：POST /notifications/read-all 并清角标', async () => {
    await renderLoaded(backendRows([{}, { id: 'n2', read: false }]));
    // 两条未读 → 角标 2
    expect(screen.getByText('2')).toBeInTheDocument();

    openDropdown();
    fireEvent.click(screen.getByText('全部已读'));

    expect(mockApi.post).toHaveBeenCalledWith('/notifications/read-all');
    await waitFor(() => expect(screen.queryByText('2')).not.toBeInTheDocument());
  });

  it('后端请求失败不崩溃：展示暂无通知', async () => {
    mockApi.get.mockRejectedValue(new Error('network'));
    render(<NotificationBell />);
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    openDropdown();
    expect(screen.getByText('暂无通知')).toBeInTheDocument();
  });
});

describe('§5.7 SSE 实时 atHuman 增量（保留）', () => {
  it('有 workUnitId + pmoId：点本体优先跳 WU 详情，不调后端已读 API', async () => {
    await renderLoaded([]);
    emitAtHuman({ id: 'm1', agentName: 'pmo', content: 'WU 完成', workUnitId: 'wu-1', meta: { atHuman: true, pmoId: 'proj-1' } });
    openDropdown();

    expect(screen.getByText('WU')).toBeInTheDocument();
    expect(screen.getByText('PMO')).toBeInTheDocument();

    fireEvent.click(screen.getByText('WU 完成'));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-1');
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('只有 pmoId：点本体跳 PMO 详情', async () => {
    await renderLoaded([]);
    emitAtHuman({ id: 'm2', agentName: 'pmo', content: '项目交付', workUnitId: null, meta: { atHuman: true, pmoId: 'proj-2' } });
    openDropdown();

    fireEvent.click(screen.getByText('项目交付'));
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-2');
  });

  it('既无 workUnitId 也无 pmoId：点本体跳频道', async () => {
    await renderLoaded([]);
    emitAtHuman({ id: 'm3', agentName: 'coder', content: '请review', meta: { atHuman: true } });
    openDropdown();

    fireEvent.click(screen.getByText('请review'));
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-1');
  });

  it('SSE 与后端通知并存：角标合并计数', async () => {
    await renderLoaded(backendRows());
    emitAtHuman({ id: 'm4', agentName: 'pmo', content: '新@消息', meta: { atHuman: true } });
    // 后端 1 条未读 + SSE 1 条未读
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('点 WU 按钮直跳 WU 详情（stopPropagation，不触发本体跳转）', async () => {
    await renderLoaded([]);
    emitAtHuman({ id: 'm5', agentName: 'pmo', content: 'WU 完成', workUnitId: 'wu-9', meta: { atHuman: true, pmoId: 'proj-9' } });

    openDropdown();
    fireEvent.click(screen.getByText('WU'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-9');
    // 下拉收起
    expect(screen.queryByText('WU 完成')).not.toBeInTheDocument();
  });

  it('点 PMO 按钮直跳 PMO 详情，不触发本体跳转', async () => {
    await renderLoaded([]);
    emitAtHuman({ id: 'm6', agentName: 'pmo', content: 'WU 完成', workUnitId: 'wu-5', meta: { atHuman: true, pmoId: 'proj-5' } });
    openDropdown();

    fireEvent.click(screen.getByText('PMO'));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-5');
  });
});
