// #291 路由层 basename 测试：dev（base=/dev/）深链/入口渲染目标页而非 404；生产（base=/）行为不变
// 复验入口 main.tsx 的接线为 BrowserRouter basename={import.meta.env.BASE_URL}，
// 本测试在路由表层验证：同一份路由表在 basename='/dev/' 下吃 /dev/* URL，在 basename='/' 下保持现状。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

// stores：认证态固定为已登录非 Guest（否则 App 落 LandingPage 围墙）
vi.mock('../stores', () => ({
  useAgentStore: () => ({ loadAgents: vi.fn() }),
  useRuntimeStore: () => ({ loadExecutions: vi.fn() }),
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({ isGuest: () => false, isAuthenticated: () => true }),
}));

vi.mock('../api/channel', () => ({
  channelApi: { listAgents: vi.fn().mockResolvedValue({ data: { data: [] } }) },
}));

// 壳组件与 provider 与本测试无关，全部透传/置空
vi.mock('../api/websocket', () => ({
  WebSocketProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../contexts/ThemeContext', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/TopNav', () => ({ TopNav: () => null }));
vi.mock('../components/SidebarNew', () => ({ Sidebar: () => null }));
vi.mock('../components/TriageBanner', () => ({ TriageBanner: () => null }));
vi.mock('../components/setup/StudioRoleSetupModal', () => ({ StudioRoleSetupModal: () => null }));
vi.mock('../components/setup/FirstRoleSetupModal', () => ({ FirstRoleSetupModal: () => null }));

// 只替身本测试命中的三个懒加载页面，其余页面不会触发 import
vi.mock('../pages/ChannelListPage', () => ({
  ChannelListPage: () => <div data-testid="channel-list-page" />,
}));
vi.mock('../pages/ChannelDetailPage', () => ({
  ChannelDetailPage: () => <div data-testid="channel-detail-page" />,
}));
vi.mock('../pages/NotFoundPage', () => ({
  NotFoundPage: () => <div data-testid="not-found-page" />,
}));

import App from '../App';

function renderAt(url: string, basename: string) {
  window.history.pushState({}, '', url);
  return render(
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>,
  );
}

beforeAll(() => {
  // jsdom 初始 URL 为 http://localhost/，无需额外处理
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('#291 basename 深链路由', () => {
  it('dev：/dev/channels/:id 深链渲染频道页而非 404', async () => {
    renderAt('/dev/channels/ch-1', '/dev/');
    expect(await screen.findByTestId('channel-detail-page')).toBeInTheDocument();
    expect(screen.queryByTestId('not-found-page')).not.toBeInTheDocument();
  });

  it('dev：/dev/ 入口渲染频道列表页而非 404', async () => {
    renderAt('/dev/', '/dev/');
    expect(await screen.findByTestId('channel-list-page')).toBeInTheDocument();
    expect(screen.queryByTestId('not-found-page')).not.toBeInTheDocument();
  });

  it('生产：base=/ 时 /channels/:id 渲染频道页（行为无变化）', async () => {
    renderAt('/channels/ch-1', '/');
    expect(await screen.findByTestId('channel-detail-page')).toBeInTheDocument();
    expect(screen.queryByTestId('not-found-page')).not.toBeInTheDocument();
  });

  it('对照：base=/ 时 /dev/* URL 落 404（证明 basename 是深链存活的充要条件）', async () => {
    renderAt('/dev/channels/ch-1', '/');
    expect(await screen.findByTestId('not-found-page')).toBeInTheDocument();
  });
});
