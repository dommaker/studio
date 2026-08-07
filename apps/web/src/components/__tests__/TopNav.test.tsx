/**
 * TopNav 连接状态 — 2026-08 旧 realtime 链路清理
 * 状态点读取 WebSocketProvider context（应用根部唯一 SSE 连接），不再由 App 传 wsStatus prop
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../contexts/ThemeContext';

const { state } = vi.hoisted(() => ({ state: { status: 'disconnected' as string } }));

vi.mock('../../api/websocketHooks', () => ({
  useWebSocketContext: () => ({
    status: state.status,
    onEvent: () => () => {},
  }),
}));

import { TopNav } from '../TopNav';

function renderTopNav() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <TopNav />
      </ThemeProvider>
    </MemoryRouter>
  );
}

describe('TopNav — SSE 连接状态（读 context）', () => {
  it('context status=connected 时状态点为在线', () => {
    state.status = 'connected';
    const { container } = renderTopNav();
    const dot = container.querySelector('.status-dot');
    expect(dot?.className).toContain('status-online');
    expect(dot?.className).not.toContain('status-offline');
  });

  it('context status 非 connected 时状态点为离线', () => {
    state.status = 'disconnected';
    const { container } = renderTopNav();
    expect(container.querySelector('.status-dot')?.className).toContain('status-offline');
  });
});
