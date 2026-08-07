/**
 * NotificationBell tests — 2026-07 §5.7
 * 跳转优先级：有 workUnitId → /workunits/:id；否则有 pmoId → /pmo/project/:id；否则 → /channels/:channelId
 * 以及每条通知的 WU / PMO 直跳小按钮渲染与点击
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { WebSocketMessage } from '../../api/websocket';

const { mockNavigate, sseHandlers } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  sseHandlers: new Set<(msg: unknown) => void>(),
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

import { NotificationBell } from '../NotificationBell';

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

beforeEach(() => {
  sseHandlers.clear();
  mockNavigate.mockClear();
});

describe('NotificationBell — §5.7 跳转', () => {
  it('有 workUnitId + pmoId：渲染 WU/PMO 按钮，点本体优先跳 WU 详情', () => {
    render(<NotificationBell />);
    emitAtHuman({ id: 'm1', agentName: 'pmo', content: 'WU 完成', workUnitId: 'wu-1', meta: { atHuman: true, pmoId: 'proj-1' } });
    openDropdown();

    expect(screen.getByText('WU')).toBeInTheDocument();
    expect(screen.getByText('PMO')).toBeInTheDocument();

    fireEvent.click(screen.getByText('WU 完成'));
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-1');
  });

  it('只有 pmoId：只渲染 PMO 按钮，点本体跳 PMO 详情', () => {
    render(<NotificationBell />);
    emitAtHuman({ id: 'm2', agentName: 'pmo', content: '项目交付', workUnitId: null, meta: { atHuman: true, pmoId: 'proj-2' } });
    openDropdown();

    expect(screen.queryByText('WU')).not.toBeInTheDocument();
    expect(screen.getByText('PMO')).toBeInTheDocument();

    fireEvent.click(screen.getByText('项目交付'));
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-2');
  });

  it('既无 workUnitId 也无 pmoId（老消息 meta 无 pmoId）：无小按钮，点本体跳频道', () => {
    render(<NotificationBell />);
    emitAtHuman({ id: 'm3', agentName: 'coder', content: '请review', meta: { atHuman: true } });
    openDropdown();

    expect(screen.queryByText('WU')).not.toBeInTheDocument();
    expect(screen.queryByText('PMO')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('请review'));
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-1');
  });

  it('点 WU 按钮直跳 WU 详情（stopPropagation，不触发本体跳转），并标记已读', () => {
    render(<NotificationBell />);
    emitAtHuman({ id: 'm4', agentName: 'pmo', content: 'WU 完成', workUnitId: 'wu-9', meta: { atHuman: true, pmoId: 'proj-9' } });

    // 未读角标 = 1
    expect(screen.getByText('1')).toBeInTheDocument();

    openDropdown();
    fireEvent.click(screen.getByText('WU'));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/workunits/wu-9');
    // 已读 → 角标消失；下拉收起
    expect(screen.queryByText('1')).not.toBeInTheDocument();
    expect(screen.queryByText('WU 完成')).not.toBeInTheDocument();
  });

  it('点 PMO 按钮直跳 PMO 详情，不触发本体跳转', () => {
    render(<NotificationBell />);
    emitAtHuman({ id: 'm5', agentName: 'pmo', content: 'WU 完成', workUnitId: 'wu-5', meta: { atHuman: true, pmoId: 'proj-5' } });
    openDropdown();

    fireEvent.click(screen.getByText('PMO'));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/pmo/project/proj-5');
  });

  it('message.meta 缺失（null）时仍正常入列并跳频道（防御）', () => {
    render(<NotificationBell />);
    // meta 为 null 时 atHuman 取不到 → 不入列；用无 pmoId 的合法 meta 验证防御路径
    emitAtHuman({ id: 'm6', agentName: 'ops', content: '老消息', workUnitId: undefined, meta: { atHuman: true } });
    openDropdown();

    fireEvent.click(screen.getByText('老消息'));
    expect(mockNavigate).toHaveBeenCalledWith('/channels/ch-1');
  });
});
