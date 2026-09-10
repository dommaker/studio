// Contract test: DiscussionPanel — MVP-4
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

vi.mock('../../api/workunit', () => ({
  workunitApi: {
    getMessages: vi.fn().mockResolvedValue({ data: { data: [] } }),
    postMessage: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { workunitApi } from '../../api/workunit';
import { DiscussionPanel } from '../DiscussionPanel';
import { toast } from '../../utils/toast';

const mockGetMessages = vi.mocked(workunitApi.getMessages);
const mockPostMessage = vi.mocked(workunitApi.postMessage);

describe('DiscussionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetMessages.mockResolvedValue({ data: { data: [] } });
    mockPostMessage.mockResolvedValue({ data: {} });
    // console.error 静默（失败路径用例不刷测试输出）
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    toast.dismiss();
    vi.restoreAllMocks();
  });

  it('renders discussion panel title', () => {
    render(<DiscussionPanel workUnitId="wu-1" />);
    expect(screen.getByText('讨论空间')).toBeDefined();
  });

  it('shows empty state when no messages', async () => {
    render(<DiscussionPanel workUnitId="wu-1" />);
    expect(await screen.findByText('暂无消息')).toBeDefined();
  });

  it('renders input field for sending messages', () => {
    render(<DiscussionPanel workUnitId="wu-1" />);
    expect(screen.getByPlaceholderText('输入消息...')).toBeDefined();
  });

  // 批次 E-2：加载失败 = console.error + toast 可见反馈（原仅 console 静默）
  it('加载失败 → toast 可见反馈', async () => {
    mockGetMessages.mockRejectedValue(new Error('network down'));
    render(<DiscussionPanel workUnitId="wu-1" />);
    expect(await screen.findByText('加载讨论消息失败，请稍后重试')).toBeDefined();
  });

  // 批次 E-2：发送失败 = toast + 输入内容保留（对齐 ChannelInput「失败保留草稿」）
  it('发送失败 → toast + 输入内容不清空', async () => {
    mockPostMessage.mockRejectedValue(new Error('500'));
    render(<DiscussionPanel workUnitId="wu-1" />);
    await screen.findByText('暂无消息');

    const input = screen.getByPlaceholderText('输入消息...') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '草稿内容' } });
    fireEvent.click(screen.getByText('发送'));

    expect(await screen.findByText('发送失败，内容已保留')).toBeDefined();
    expect(input.value).toBe('草稿内容');
  });
});
