// TriageBanner tests — #468 投影化：数据源 = 行动中心 store 中 type==='incident' 且未读的通知
// （SSE incident.created/escalated 订阅与内存 dismissed Set 已删）。
// severity 从 content 首行 `severity: <level>` 解析（缺省 warning）；
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
    title: '执行失败告警', content: 'severity: warning\nWU-1 执行失败', time: '10:00',
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

describe('TriageBanner — #468 行动中心投影', () => {
  it('无未读 incident → 不渲染', () => {
    useNotificationStore.setState({
      notifications: [
        incident({ id: 'n1', read: true }), // 已读不显示
        incident({ id: 'n2', type: 'wu_milestone' }), // 非 incident 不显示
      ],
    });
    const { container } = render(<TriageBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('有未读 incident → 横幅显示（warning 配色/⚠️，展示标题）', () => {
    useNotificationStore.setState({ notifications: [incident()] });
    render(<TriageBanner />);
    expect(screen.getByText('执行失败告警')).toBeInTheDocument();
    expect(screen.getByText('⚠️')).toBeInTheDocument();
  });

  it('任一 severity: critical（content 首行解析）→ critical 配色/🚨', () => {
    useNotificationStore.setState({
      notifications: [
        incident({ id: 'n1' }),
        incident({ id: 'n2', title: '严重事故', content: 'severity: critical\n主循环崩溃' }),
      ],
    });
    const { container } = render(<TriageBanner />);
    expect(screen.getByText('🚨')).toBeInTheDocument();
    expect(container.firstChild).toHaveClass('u-err-bg');
    // 多条 → 聚合计数文案
    expect(screen.getByText('2 条告警')).toBeInTheDocument();
  });

  it('content 无 severity 行 → 缺省 warning', () => {
    useNotificationStore.setState({
      notifications: [incident({ content: '系统告警（无 severity 行）' })],
    });
    const { container } = render(<TriageBanner />);
    expect(screen.getByText('⚠️')).toBeInTheDocument();
    expect(container.firstChild).not.toHaveClass('u-err-bg');
  });

  it('关闭 = 每条可见 incident markRead 持久化（POST /:id/read），横幅消失且非内存 dismissed', () => {
    useNotificationStore.setState({
      notifications: [incident({ id: 'n1' }), incident({ id: 'n2' })],
      unreadCount: 2,
    });
    render(<TriageBanner />);

    fireEvent.click(screen.getByText('关闭'));

    // 持久化：两条均已读（store read 墓碑驱动，刷新重拉也不复活——无内存 dismissed）
    expect(useNotificationStore.getState().notifications.every(n => n.read)).toBe(true);
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n1/read');
    expect(mockApi.post).toHaveBeenCalledWith('/notifications/n2/read');
    expect(screen.queryByText('关闭')).not.toBeInTheDocument();
  });
});
