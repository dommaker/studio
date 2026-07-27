// ChannelMemberManager — AC-B: Channel member management UI
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { mockListAgents, mockUpdateMembers, mockCreateAgent } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockUpdateMembers: vi.fn(),
  mockCreateAgent: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    listAgents: mockListAgents,
    updateMembers: mockUpdateMembers,
    createAgent: mockCreateAgent,
  },
}));

// 2026-07：创建表单新增 CLI 下拉（由运行环境扫描驱动），测试中固定回退态（全量可选）
vi.mock('../../../hooks/useDetectedProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useDetectedProviders')>();
  return {
    ...actual,
    useDetectedProviders: () => ({ detected: [], loading: false, noneDetected: true }),
  };
});

import { ChannelMemberManager } from '../ChannelMemberManager';

const mockAgentList = [
  { id: 'a1', name: 'dev-agent', description: 'does code', status: 'active' },
  { id: 'a2', name: 'pm-agent', description: 'manages tasks', status: 'active' },
  { id: 'a3', name: 'review-agent', description: null, status: 'active' },
];

describe('ChannelMemberManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgentList } });
    mockUpdateMembers.mockResolvedValue({ data: { members: [] } });
    mockCreateAgent.mockResolvedValue({ id: 'new-a', name: 'new-agent', description: null, status: 'active' });
  });

  it('renders toggle button', () => {
    render(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByTitle('Channel 成员管理')).toBeTruthy();
  });

  it('shows "All" when no members configured', () => {
    render(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByText('All')).toBeTruthy();
  });

  it('shows member count when membersJson has ids', () => {
    render(<ChannelMemberManager channelId="ch-1" membersJson='["a1","a2"]' />);
    expect(screen.getByText('2 agents')).toBeTruthy();
  });

  it('opens member panel on toggle click', () => {
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    expect(screen.getByText('频道成员')).toBeTruthy();
  });

  it('shows current members in panel', async () => {
    render(<ChannelMemberManager channelId="ch-1" membersJson='["a1"]' />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    await waitFor(() => {
      expect(screen.getByText('@dev-agent')).toBeTruthy();
    });
  });

  it('shows available agents to add', async () => {
    render(<ChannelMemberManager channelId="ch-1" membersJson='["a1"]' />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    await waitFor(() => {
      expect(screen.getByText('@pm-agent')).toBeTruthy();
      expect(screen.getByText('@review-agent')).toBeTruthy();
    });
  });

  it('toggles create agent form', () => {
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    fireEvent.click(screen.getByText('+ 创建新 Agent'));
    expect(screen.getByPlaceholderText('Agent 名称')).toBeTruthy();
    expect(screen.getByText('创建并加入频道')).toBeTruthy();
    expect(screen.getByText('取消')).toBeTruthy();
  });

  it('syncs memberIds when membersJson arrives asynchronously (refresh bug)', () => {
    // 页面刷新时 channel 异步加载：首渲 membersJson 为 undefined，数据后到
    const { rerender } = render(<ChannelMemberManager channelId="ch-1" membersJson={undefined} />);
    expect(screen.getByText('All')).toBeTruthy();
    rerender(<ChannelMemberManager channelId="ch-1" membersJson='["a1","a2"]' />);
    expect(screen.getByText('2 agents')).toBeTruthy();
  });

  it('creates agent and joins the channel in one action', async () => {
    mockCreateAgent.mockResolvedValue({ data: { id: 'new-a', name: 'new-agent', description: null, status: 'active' } });
    render(<ChannelMemberManager channelId="ch-1" membersJson="[]" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    fireEvent.click(screen.getByText('+ 创建新 Agent'));
    fireEvent.change(screen.getByPlaceholderText('Agent 名称'), { target: { value: '新成员' } });
    fireEvent.click(screen.getByText('创建并加入频道'));
    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ name: '新成员', channels: ['ch-1'] }));
      expect(mockUpdateMembers).toHaveBeenCalledWith('ch-1', { add: ['new-a'] });
    });
  });

  it('shows inline error when create fails', async () => {
    mockCreateAgent.mockRejectedValue(new Error('provider unavailable'));
    render(<ChannelMemberManager channelId="ch-1" membersJson="[]" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    fireEvent.click(screen.getByText('+ 创建新 Agent'));
    fireEvent.change(screen.getByPlaceholderText('Agent 名称'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('创建并加入频道'));
    await waitFor(() => {
      expect(screen.getByText('provider unavailable')).toBeTruthy();
    });
  });

  it('handles empty membersJson gracefully', () => {
    render(<ChannelMemberManager channelId="ch-1" membersJson="invalid" />);
    expect(screen.getByText('All')).toBeTruthy();
  });

  it('handles empty array membersJson', () => {
    render(<ChannelMemberManager channelId="ch-1" membersJson="[]" />);
    expect(screen.getByText('All')).toBeTruthy();
  });
});
