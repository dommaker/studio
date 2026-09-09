// ChannelMemberManager — AC-B: Channel member management UI
// #403：成员面/agent 列表改走 store（channelDataStore.members + rosterStore.profiles 客户端切片），
// membersJson prop 退役——成员数据经由 store seed（页面频道记录写穿水合同口径）。
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

const { mockListAgents, mockUpdateMembers, mockCreateAgent, mockChannelGet } = vi.hoisted(() => ({
  mockListAgents: vi.fn(),
  mockUpdateMembers: vi.fn(),
  mockCreateAgent: vi.fn(),
  mockChannelGet: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: {
    listAgents: mockListAgents,
    get: mockChannelGet,
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
import { useChannelDataStore } from '../../../stores/channelDataStore';
import { useRosterStore } from '../../../stores/rosterStore';

const mockAgentList = [
  { id: 'a1', name: 'dev-agent', description: 'does code', status: 'active' },
  { id: 'a2', name: 'pm-agent', description: 'manages tasks', status: 'active' },
  { id: 'a3', name: 'review-agent', description: null, status: 'active' },
];

function seedStores(memberIds?: string[]) {
  // roster 正本 + fresh TTL 锚点（ensureFresh 零请求）；成员面经 setMembers 写穿（同页面水合路径）
  useChannelDataStore.getState().__resetForTests();
  useRosterStore.setState({ profiles: mockAgentList, loadedAt: Date.now(), inflight: null, forbidden: false, lastToken: null });
  if (memberIds) useChannelDataStore.getState().setMembers('ch-1', memberIds);
}

describe('ChannelMemberManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListAgents.mockResolvedValue({ data: { data: mockAgentList } });
    mockChannelGet.mockResolvedValue({ data: { success: true, data: { id: 'ch-1', members: '[]' } } });
    mockUpdateMembers.mockResolvedValue({ data: { members: [] } });
    mockCreateAgent.mockResolvedValue({ data: { id: 'new-a', name: 'new-agent', description: null, status: 'active' } });
    seedStores();
  });

  it('renders toggle button', () => {
    render(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByTitle('Channel 成员管理')).toBeTruthy();
  });

  it('shows "All" when no members configured', () => {
    render(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByText('All')).toBeTruthy();
  });

  it('shows member count when store members has ids', () => {
    seedStores(['a1', 'a2']);
    render(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByText('2 agents')).toBeTruthy();
  });

  it('opens member panel on toggle click', () => {
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    expect(screen.getByText('频道成员')).toBeTruthy();
  });

  it('shows current members in panel', async () => {
    seedStores(['a1']);
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    await waitFor(() => {
      expect(screen.getByText('@dev-agent')).toBeTruthy();
    });
  });

  it('shows available agents to add', async () => {
    seedStores(['a1']);
    render(<ChannelMemberManager channelId="ch-1" />);
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

  it('syncs member ids when store members arrive asynchronously (refresh bug)', () => {
    // 页面刷新时频道记录异步加载：首渲 store 成员面为空，数据后到（写穿水合）
    const { rerender } = render(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByText('All')).toBeTruthy();
    act(() => {
      useChannelDataStore.getState().setMembers('ch-1', ['a1', 'a2']);
    });
    rerender(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByText('2 agents')).toBeTruthy();
  });

  it('creates agent and joins the channel in one action', async () => {
    seedStores([]);
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    fireEvent.click(screen.getByText('+ 创建新 Agent'));
    fireEvent.change(screen.getByPlaceholderText('Agent 名称'), { target: { value: '新成员' } });
    fireEvent.click(screen.getByText('创建并加入频道'));
    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ name: '新成员', channels: ['ch-1'] }));
      expect(mockUpdateMembers).toHaveBeenCalledWith('ch-1', { add: ['new-a'] });
    });
    // 成功后成员面本地写穿（mention 过滤等订阅方即时跟上）
    expect(useChannelDataStore.getState().members['ch-1']).toEqual(['new-a']);
  });

  it('shows inline error when create fails', async () => {
    seedStores([]);
    mockCreateAgent.mockRejectedValue(new Error('provider unavailable'));
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    fireEvent.click(screen.getByText('+ 创建新 Agent'));
    fireEvent.change(screen.getByPlaceholderText('Agent 名称'), { target: { value: 'x' } });
    fireEvent.click(screen.getByText('创建并加入频道'));
    await waitFor(() => {
      expect(screen.getByText('provider unavailable')).toBeTruthy();
    });
  });

  it('store 成员面为 []（空 = 所有 Agent 可见）→ All', () => {
    seedStores([]);
    render(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByText('All')).toBeTruthy();
  });

  it('store 成员面缺键（未拉到）→ All，不抛错', () => {
    render(<ChannelMemberManager channelId="ch-1" />);
    expect(screen.getByText('All')).toBeTruthy();
  });

  it('添加成员成功 → store 成员面写穿', async () => {
    seedStores(['a1']);
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    fireEvent.click(await screen.findByText('@pm-agent'));
    await waitFor(() => {
      expect(mockUpdateMembers).toHaveBeenCalledWith('ch-1', { add: ['a2'] });
    });
    expect(useChannelDataStore.getState().members['ch-1']).toEqual(['a1', 'a2']);
  });

  // 批次A 项8：成员增删失败 toast（原 console.error 静默），store 不写穿
  it('添加成员失败 → toast 提示 + store 不写穿', async () => {
    document.querySelector('#toast-container')?.replaceChildren(); // 只清子节点——toast.ts 模块级缓存 container 引用，remove 会让后续 toast 挂到游离节点
    seedStores(['a1']);
    mockUpdateMembers.mockRejectedValue(Object.assign(new Error('Request failed with status code 403'), {
      isAxiosError: true,
      response: { status: 403, data: { error: { message: '仅频道管理员可增删成员' } } },
    }));
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    fireEvent.click(await screen.findByText('@pm-agent'));
    expect(await screen.findByText('添加成员失败：仅频道管理员可增删成员')).toBeTruthy();
    expect(useChannelDataStore.getState().members['ch-1']).toEqual(['a1']);
  });

  it('移除成员失败 → toast 通用文案 + 成员仍在列表', async () => {
    document.querySelector('#toast-container')?.replaceChildren(); // 只清子节点——toast.ts 模块级缓存 container 引用，remove 会让后续 toast 挂到游离节点
    seedStores(['a1']);
    mockUpdateMembers.mockRejectedValue(new Error('network'));
    render(<ChannelMemberManager channelId="ch-1" />);
    fireEvent.click(screen.getByTitle('Channel 成员管理'));
    const row = (await screen.findByText('@dev-agent')).closest('.mc-mention-item')!;
    fireEvent.click(row.querySelector('button[title="移除"]')!);
    expect(await screen.findByText('移除成员失败，请重试')).toBeTruthy();
    expect(useChannelDataStore.getState().members['ch-1']).toEqual(['a1']);
  });
});
