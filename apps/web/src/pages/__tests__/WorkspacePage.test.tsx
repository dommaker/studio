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
          { id: 'rt-1', provider: 'claude', name: 'Claude Code', version: '2.1.0', status: 'online' },
          { id: 'rt-2', provider: 'opencode', name: 'OpenCode CLI', version: '3.0.0', status: 'online' },
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

  // AC-5.3: provider auto-filled, not editable
  it('clicking create role opens dialog with provider pre-filled', async () => {
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());

    fireEvent.click(screen.getAllByText('设为角色')[0]);

    // Dialog is open
    expect(screen.getByText('创建角色')).toBeDefined();
    // Name input is present
    expect(screen.getByPlaceholderText('角色名称')).toBeDefined();
    // Provider is displayed as readonly text
    expect(screen.getByText('claude')).toBeDefined();
  });

  // AC-5.4: submit creates agent via API
  it('submit creates agent and shows success', async () => {
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());

    fireEvent.click(screen.getAllByText('设为角色')[0]);

    // Fill name and description
    const nameInput = screen.getByPlaceholderText('角色名称');
    fireEvent.change(nameInput, { target: { value: 'Executor' } });

    const descInput = screen.getByPlaceholderText('角色描述（选填）');
    fireEvent.change(descInput, { target: { value: '代码实现' } });

    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith({
        name: 'Executor',
        description: '代码实现',
        provider: 'claude',
      });
    });
  });

  // AC-5.5: shows bound role count
  it('displays no bound roles initially', async () => {
    render(<WorkspacePage />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeDefined());
    const badges = screen.getAllByText('0 个角色');
    expect(badges.length).toBeGreaterThanOrEqual(1);
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
  });
});
