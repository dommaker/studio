// TriageBanner tests — #468 投影化：数据源 = 行动中心 store 中 type==='incident' 且未读的通知
// （SSE incident.created/escalated 订阅与内存 dismissed Set 已删）。
// severity 从 content 首行 `severity: <level>` 解析（缺省 warning）；
// 设计稿 §3：仅 critical 突破成横幅，warning 级留在铃铛面板；
// 「关闭」= 对每条可见 incident 调 markRead（POST 持久化墓碑，刷新不复活）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockApi } = vi.hoisted(() => ({
  mockApi: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('../../api', () => ({ api: mockApi }));

import { TriageBanner } from '../TriageBanner';
import { useNotificationStore, type Notification } from '../../stores/notificationStore';

function incident(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'n1', type: 'incident', channelId: null, agentName: 'System',
    title: '严重事故', content: 'severity: critical\n主循环崩溃', time: '10:00',
    read: false, workUnitId: null, pmoId: null, messageId: null,
    ...overrides,
  };
}

beforeEach(() => {
  useNotificationStore.setState({ stateItems: [], notifications: [], unreadCount: 0 });
  mockApi.get.mockReset();
  mockApi.post.mockReset();
  mockApi.post.mockResolvedValue({ data: { success: true } });
});

describe('TriageBanner — #468 行动中心投影（critical 才突破成横幅）', () => {
  it('无未读 critical incident → 不渲染', () => {
    useNotificationStore.setState({
      notifications: [
        incident({ id: 'n1', read: true }), // 已读不显示
        incident({ id: 'n2', type: 'wu_milestone' }), // 非 incident 不显示
      ],
    });
    const { container } = render(<TriageBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('warning 级未读 incident → 不突破成横幅（留铃铛面板）', () => {
    useNotificationStore.setState({
      notifications: [incident({ title: '执行失败告警', content: 'severity: warning\nWU-1 执行失败' })],
    });
    const { container } = render(<TriageBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('content 无 severity 行 → 缺省 warning → 不渲染', () => {
    useNotificationStore.setState({
      notifications: [incident({ content: '系统告警（无 severity 行）' })],
    });
    const { container } = render(<TriageBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('critical 未读（content 首行解析）→ 横幅 critical 配色/🚨，展示标题', () => {
    useNotificationStore.setState({
      notifications: [
        incident({ id: 'n1', title: '警告级', content: 'severity: warning\n一般告警' }),
        incident({ id: 'n2' }),
      ],
    });
    const { container } = render(<TriageBanner />);
    expect(screen.getByText('🚨')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('u-err-bg');
    // 只有 critical 那条进横幅
    expect(screen.getByText('严重事故')).toBeInTheDocument();
    expect(screen.queryByText('警告级')).not.toBeInTheDocument();
  });

  it('多条 critical → 聚合计数文案', () => {
    useNotificationStore.setState({
      notifications: [incident({ id: 'n1' }), incident({ id: 'n2' })],
    });
    render(<TriageBanner />);
    expect(screen.getByText('2 条告警')).toBeInTheDocument();
  });

  it('关闭 = 每条可见 critical incident markRead 持久化（POST /:id/read），横幅消失且非内存 dismissed', () => {
    useNotificationStore.setState({
      notifications: [
        incident({ id: 'n1' }),
        incident({ id: 'n2' }),
        incident({ id: 'n3', title: '警告级', content: 'severity: warning\n一般告警' }),
      ],
      unreadCount: 3,
    });
    render(<TriageBanner />);

    fireEvent.click(screen.getByText('关闭'));

    // 持久化：两条 critical 均已读（store read 墓碑驱动，刷新重拉也不复活——无内存 dismissed）；
    // warning 级不在横幅管辖内，不被误标已读
    const state = useNotificationStore.getState().notifications;
    expect(state.find(n => n.id === 'n1')?.read).toBe(true);
    expect(state.find(n => n.id === 'n2')?.read).toBe(true);
    expect(state.find(n => n.id === 'n3')?.read).toBe(false);
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n1/read');
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n2/read');
    expect(mockApi.post).not.toHaveBeenCalledWith('/notifications/n3/read');
    expect(screen.queryByText('关闭')).not.toBeInTheDocument();
  });
});
