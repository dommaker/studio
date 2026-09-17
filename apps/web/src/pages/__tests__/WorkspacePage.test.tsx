// Contract test: WorkspacePage — AC Group 5
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// Hoist mocks before all imports
const { mockGetWorkspace, mockCreateAgent } = vi.hoisted(() => ({
  mockGetWorkspace: vi.fn().mockResolvedValue({
    data: {
      success: true,
      data: {
        id: 'ws-1',
        name: 'VPS',
        status: 'idle',
        workspaceRoot: '/root/projects',
        runtimes: [
          {
            id: 'rt-1', provider: 'claude', name: 'Claude Code', version: '2.1.0', status: 'online',
            // #574: 未声明 listModels → 静态兜底清单
            models: ['opus', 'sonnet'], modelsSource: 'fallback',
          },
          {
            id: 'rt-2', provider: 'opencode', name: 'OpenCode CLI', version: '3.0.0', status: 'online',
            // #574: listModels 探测成功 → 实测清单
            models: ['opencode/big-pickle', 'openai/gpt-4o'], modelsSource: 'live',
          },
        ],
      },
    },
  }),
  mockCreateAgent: vi.fn().mockResolvedValue({
    data: { id: 'agent-1', name: 'Executor', description: 'code', provider: 'claude' },
  }),
}));

vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'ws-1' }),
  // #393 后本页渲染 BackButton（内部 useNavigate），mock 工厂必须补全，否则 render 期抛错空 body
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) =>
    React.createElement('a', { href: to }, children),
}));

vi.mock('../../api/index', () => ({
  workspaceApi: {
    get: mockGetWorkspace,
  },
}));

vi.mock('../../api/channel', () => ({
  channelApi: {
    createAgent: mockCreateAgent,
  },
  AgentProfile: {} as unknown as AgentProfile,
}));

import { WorkspacePage } from '../../pages/WorkspacePage';
import type { AgentProfile } from '../../api/channel';

describe('WorkspacePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // AC-5.1: runtime list
  it('renders runtime list with provider, version, status', async () => {
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());
    expect(screen.getByText('v2.1.0')).toBeDefined();
    const onlineBadges = screen.getAllByText('online');
    expect(onlineBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('OpenCode CLI')).toBeDefined();
  });

  // AC-5.2: create role button
  it('shows create role button on each runtime', async () => {
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());
    const buttons = screen.getAllByText('设为角色');
    expect(buttons).toHaveLength(2);
  });

  // #574: runtime 卡片展示模型清单 + 来源标注（live=实测 / fallback=静态）
  it('renders model list with live/fallback source badge per runtime', async () => {
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());
    // claude：静态兜底
    expect(screen.getByText(/opus, sonnet/)).toBeDefined();
    expect(screen.getByText('静态')).toBeDefined();
    // opencode：实测
    expect(screen.getByText(/opencode\/big-pickle/)).toBeDefined();
    expect(screen.getByText('实测')).toBeDefined();
  });

  it('omits model line when runtime has no models field', async () => {
    mockGetWorkspace.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          id: 'ws-1', name: 'VPS', status: 'idle', workspaceRoot: '/tmp',
          runtimes: [
            { id: 'rt-9', provider: 'openclaw', name: 'OpenClaw', version: '1.0.0', status: 'online' },
          ],
        },
      },
    });
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('OpenClaw')).toBeDefined());
    expect(screen.queryByText('实测')).toBeNull();
    expect(screen.queryByText('静态')).toBeNull();
  });

  // AC-5.3: provider auto-filled, not editable（E8-4：链路走 CreateRoleModal 正本，presetProvider 锁定行内 CLI）
  it('clicking create role opens CreateRoleModal with provider pre-filled', async () => {
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());

    fireEvent.click(screen.getAllByText('设为角色')[0]);

    // CreateRoleModal 正本弹框（title + 正本提交键 testid）
    expect(screen.getByText('创建角色')).toBeDefined();
    expect(screen.getByTestId('create-role-submit')).toBeDefined();
    // Name input is present
    expect(screen.getByPlaceholderText(/角色名称/)).toBeDefined();
    // Provider is displayed as readonly text
    expect(screen.getByText('claude')).toBeDefined();
  });

  // AC-5.4: submit creates agent via API（E8-4：成功 = 关弹框 + onCreated，§6.4 正本行为）
  it('submit creates agent via CreateRoleModal and closes dialog', async () => {
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());

    fireEvent.click(screen.getAllByText('设为角色')[0]);

    // Fill name and description
    const nameInput = screen.getByPlaceholderText(/角色名称/);
    fireEvent.change(nameInput, { target: { value: 'Executor' } });

    const descInput = screen.getByPlaceholderText(/描述（可选）/);
    fireEvent.change(descInput, { target: { value: '代码实现' } });

    fireEvent.click(screen.getByTestId('create-role-submit'));

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith({
        name: 'Executor',
        description: '代码实现',
        provider: 'claude',
      });
    });
    // §6.4：创建成功关弹框
    await waitFor(() => expect(screen.queryByTestId('create-role-submit')).toBeNull());
  });

  // E8-2: 骨架合规化（§4.7）+ 删硬编码「0 个角色」假数据（无按 runtime 的角色计数接口）
  it('E8-2: 骨架归 §4.7（u-page-head/u-page-px/page-title/max-w-5xl），行卡归 .card，按钮归 btn btn-primary btn-sm，无假数据', async () => {
    const { container } = render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());
    expect(container.querySelector('.u-page-bg')).toBeTruthy();
    expect(container.querySelector('.u-page-head')).toBeTruthy();
    expect(container.querySelector('.u-page-px')).toBeTruthy();
    expect(container.querySelector('.page-title')?.textContent).toBe('VPS');
    expect(container.querySelector('.max-w-5xl')).toBeTruthy();
    expect(container.querySelectorAll('.card')).toHaveLength(2);
    expect(screen.getAllByText('设为角色')[0].className).toContain('btn btn-primary btn-sm');
    expect(screen.queryByText('0 个角色')).toBeNull();
  });

  it('handles API failure gracefully', async () => {
    mockGetWorkspace.mockRejectedValueOnce(new Error('Network error'));
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('加载失败')).toBeDefined());
  });

  it('handles empty runtimes', async () => {
    mockGetWorkspace.mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          id: 'ws-1', name: 'VPS', status: 'idle', workspaceRoot: '/tmp',
          runtimes: [],
        },
      },
    });
    render(<WorkspacePage />);
    await waitFor(() => {
      expect(screen.getByText('暂无可用 CLI，请先接入算力')).toBeDefined();
    });
    // 批次 F-4：空态补下一步指引（接入方式说明）
    expect(screen.getByText(/在本机安装受支持的 Agent CLI/)).toBeDefined();
  });
});
